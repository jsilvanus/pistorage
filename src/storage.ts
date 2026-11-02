import { once } from "node:events";
import { createReadStream } from "node:fs";
import { Transform, type Readable } from "node:stream";
import type { ByteRange, ListResult, ObjectInfo, StorageBackend } from "./backend.js";
import { DiskCache, type CacheEntry } from "./cache.js";
import { BackendUnavailableError, isBackendUnavailable, StorageError } from "./errors.js";
import { resolveRange } from "./range.js";
import { isRetentionExpired } from "./retention.js";

export interface StorageOptions {
  backend: StorageBackend;
  cache: DiskCache;
  maxUploadBytes: number;
  retentionSweepEnabled: boolean;
  now?: () => number;
}

export interface PutInput {
  size: number;
  contentType: string;
  expiresAt?: string | undefined;
  body: Readable;
}

export interface OpenedObject {
  info: ObjectInfo;
  body: Readable;
  range?: ByteRange | undefined;
  stale: boolean;
}

export interface HeadResult {
  info: ObjectInfo;
  stale: boolean;
}

export interface RetentionSweepReport {
  at: string;
  checked: number;
  deleted: number;
}

/** Counts bytes and fails when the body does not match the declared Content-Length. */
export function sizedStream(size: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > size) {
        callback(new StorageError(400, "BODY_LENGTH_MISMATCH", "request body is longer than Content-Length"));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (seen !== size) {
        callback(new StorageError(400, "BODY_LENGTH_MISMATCH", `request body is ${seen} bytes, Content-Length says ${size}`));
        return;
      }
      callback();
    }
  });
}

function infoOf(entry: CacheEntry): ObjectInfo {
  const { lastAccess: _lastAccess, ...info } = entry;
  return info;
}

/**
 * The storage service: a durable backend behind a read-through disk cache.
 *
 * - Writes go to the backend first; only after it accepted the object is the copy kept in the cache.
 *   If the backend is unreachable the write fails with 503.
 * - Reads come from the cache while the copy is within its TTL (counted from last access).
 *   Past the TTL the backend is asked again; if it cannot be reached the old copy is served and
 *   the response is marked stale.
 * - Objects with a retention deadline read as missing once it passes; the retention sweep deletes them.
 */
export class PiStorage {
  readonly backend: StorageBackend;
  readonly cache: DiskCache;
  readonly maxUploadBytes: number;
  readonly retentionSweepEnabled: boolean;
  private readonly clock: () => number;
  private staleServed = 0;
  private lastRetentionSweep: RetentionSweepReport | null = null;

  constructor(options: StorageOptions) {
    this.backend = options.backend;
    this.cache = options.cache;
    this.maxUploadBytes = options.maxUploadBytes;
    this.retentionSweepEnabled = options.retentionSweepEnabled;
    this.clock = options.now ?? Date.now;
  }

  async put(key: string, input: PutInput): Promise<ObjectInfo> {
    if (input.size > this.maxUploadBytes) {
      throw new StorageError(413, "TOO_LARGE", `object is larger than the ${this.maxUploadBytes} byte limit`);
    }
    let spooled: { path: string; bytes: number };
    try {
      spooled = await this.cache.spool(input.body, sizedStream(input.size));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (input.body.errored) throw new StorageError(400, "UPLOAD_INTERRUPTED", "upload was interrupted");
      throw error;
    }

    let stored: ObjectInfo;
    try {
      stored = await this.call(() =>
        this.backend.put(key, createReadStream(spooled.path), {
          size: input.size,
          contentType: input.contentType,
          expiresAt: input.expiresAt
        })
      );
    } catch (error) {
      await this.cache.discard(spooled.path);
      throw error;
    }

    // Backend accepted it: now keep the copy, or drop an older cached copy that must not be served any more.
    try {
      if (input.size <= this.cache.maxBytes) {
        await this.cache.adopt(stored, spooled.path);
      } else {
        await this.cache.discard(spooled.path);
        await this.cache.remove(key);
      }
    } catch {
      await this.cache.discard(spooled.path);
      await this.cache.remove(key);
    }
    return stored;
  }

  /** Opens an object for reading. Returns null when it does not exist (or its retention has passed). */
  async open(key: string, rangeHeader?: string): Promise<OpenedObject | null> {
    const now = this.clock();
    const entry = this.cache.get(key);
    if (entry) {
      if (isRetentionExpired(entry.expiresAt, now)) {
        await this.cache.remove(key);
        return null;
      }
      if (!this.cache.isTtlExpired(entry, now)) {
        const opened = await this.serveCached(entry, rangeHeader, false);
        if (opened) return opened;
      } else {
        try {
          return await this.load(key, rangeHeader);
        } catch (error) {
          if (!isBackendUnavailable(error)) throw error;
          const opened = await this.serveCached(entry, rangeHeader, true);
          if (opened) {
            this.staleServed += 1;
            return opened;
          }
          throw error;
        }
      }
    }
    return this.load(key, rangeHeader);
  }

  async head(key: string): Promise<HeadResult | null> {
    const now = this.clock();
    const entry = this.cache.get(key);
    if (entry && isRetentionExpired(entry.expiresAt, now)) {
      await this.cache.remove(key);
      return null;
    }
    if (entry && !this.cache.isTtlExpired(entry, now)) {
      return { info: infoOf(entry), stale: false };
    }
    let info: ObjectInfo | null;
    try {
      info = await this.call(() => this.backend.head(key));
    } catch (error) {
      if (entry && isBackendUnavailable(error)) {
        this.staleServed += 1;
        return { info: infoOf(entry), stale: true };
      }
      throw error;
    }
    if (!info) {
      await this.cache.remove(key);
      return null;
    }
    if (isRetentionExpired(info.expiresAt, now)) return null;
    return { info, stale: false };
  }

  async delete(key: string): Promise<void> {
    await this.call(() => this.backend.delete(key));
    await this.cache.remove(key);
  }

  async list(prefix: string, limit?: number): Promise<ListResult> {
    return this.call(() => this.backend.list(prefix, limit));
  }

  /** Drops dead cache entries and enforces the size cap. TTL eviction waits while the backend is down. */
  async prune(): Promise<{ removed: number; freedBytes: number; backendReachable: boolean }> {
    const reachable = await this.backend.ping();
    const result = await this.cache.prune({ dropTtlExpired: reachable, now: this.clock() });
    return { ...result, backendReachable: reachable };
  }

  /** Deletes backend objects whose retention deadline has passed, and their cache copies. */
  async sweepRetention(): Promise<RetentionSweepReport> {
    const now = this.clock();
    let checked = 0;
    let deleted = 0;
    const listing = await this.list("");
    for (const item of listing.items) {
      checked += 1;
      const info = await this.call(() => this.backend.head(item.key));
      if (info && isRetentionExpired(info.expiresAt, now)) {
        await this.call(() => this.backend.delete(item.key));
        await this.cache.remove(item.key);
        deleted += 1;
      }
    }
    await this.cache.prune({ dropTtlExpired: false, now });
    this.lastRetentionSweep = { at: new Date(now).toISOString(), checked, deleted };
    return this.lastRetentionSweep;
  }

  async status(): Promise<{
    backend: { kind: string; location: string; reachable: boolean };
    cache: { dir: string; bytes: number; count: number; maxBytes: number; ttlSeconds: number };
    staleServed: number;
    lastRetentionSweep: RetentionSweepReport | null;
    retentionSweepEnabled: boolean;
    maxUploadBytes: number;
  }> {
    const reachable = await this.backend.ping();
    const stats = this.cache.stats();
    return {
      backend: { kind: this.backend.kind, location: this.backend.location, reachable },
      cache: {
        dir: this.cache.dirOf(),
        bytes: stats.bytes,
        count: stats.count,
        maxBytes: this.cache.maxBytes,
        ttlSeconds: Math.round(this.cache.ttlMs / 1000)
      },
      staleServed: this.staleServed,
      lastRetentionSweep: this.lastRetentionSweep,
      retentionSweepEnabled: this.retentionSweepEnabled,
      maxUploadBytes: this.maxUploadBytes
    };
  }

  /** Fetches an object from the backend, keeps it in the cache when it fits, and serves it. */
  private async load(key: string, rangeHeader: string | undefined): Promise<OpenedObject | null> {
    const now = this.clock();
    const info = await this.call(() => this.backend.head(key));
    if (!info || isRetentionExpired(info.expiresAt, now)) {
      await this.cache.remove(key);
      return null;
    }
    const range = resolveRange(rangeHeader, info.size);

    if (info.size > this.cache.maxBytes) {
      await this.cache.remove(key);
      const direct = await this.call(() => this.backend.get(key, range));
      if (!direct) return null;
      return { info, body: direct.body, range, stale: false };
    }

    const got = await this.call(() => this.backend.get(key));
    if (!got) {
      await this.cache.remove(key);
      return null;
    }

    let spooled: { path: string; bytes: number };
    try {
      spooled = await this.cache.spool(got.body);
    } catch (error) {
      if (got.body.errored) throw new BackendUnavailableError(`download of ${key} failed`);
      // The cache disk failed, not the backend: serve straight from the backend without caching.
      return this.direct(key, info, range);
    }
    if (spooled.bytes !== info.size) {
      await this.cache.discard(spooled.path);
      throw new BackendUnavailableError(`download of ${key} was cut short`);
    }

    let entry: CacheEntry;
    try {
      entry = await this.cache.adopt(info, spooled.path);
    } catch {
      await this.cache.discard(spooled.path);
      return this.direct(key, info, range);
    }
    return (await this.serveCached(entry, rangeHeader, false)) ?? this.direct(key, info, range);
  }

  /** Serves a range straight from the backend, without the cache. */
  private async direct(key: string, info: ObjectInfo, range: ByteRange | undefined): Promise<OpenedObject | null> {
    const got = await this.call(() => this.backend.get(key, range));
    if (!got) return null;
    return { info, body: got.body, range, stale: false };
  }

  /** Streams a cached copy. Returns undefined when the cached file has gone missing (the entry is dropped). */
  private async serveCached(entry: CacheEntry, rangeHeader: string | undefined, stale: boolean): Promise<OpenedObject | undefined> {
    const range = resolveRange(rangeHeader, entry.size);
    const body = createReadStream(this.cache.filePath(entry), range ? { start: range.start, end: range.end } : undefined);
    try {
      await once(body, "open");
    } catch {
      body.destroy();
      await this.cache.remove(entry.key);
      return undefined;
    }
    this.cache.touch(entry.key);
    return { info: infoOf(entry), body, range, stale };
  }

  /** Runs a backend call and records whether the backend answered. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      throw error;
    }
  }
}
