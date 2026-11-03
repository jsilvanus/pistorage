import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { Transform, type Readable } from "node:stream";
import type { ByteRange, ListResult, ObjectInfo, StorageBackend } from "./backend.js";
import { DiskCache, type CacheEntry } from "./cache.js";
import { BackendUnavailableError, isBackendUnavailable, StorageError } from "./errors.js";
import { resolveRange } from "./range.js";
import { isRetentionExpired } from "./retention.js";
import { DEFAULT_TIMEZONE, isDue } from "./use-at.js";

export interface StorageOptions {
  backend: StorageBackend;
  cache: DiskCache;
  maxUploadBytes: number;
  retentionSweepEnabled: boolean;
  /**
   * Where writes wait while the backend is down. They are served from here and uploaded when the
   * backend answers again. Undefined = a write while the backend is down fails with 503.
   */
  spool?: DiskCache | undefined;
  spoolMaxBytes?: number | undefined;
  /** Zone for dates in useAt that carry none. Default Europe/Helsinki. */
  timezone?: string | undefined;
  /**
   * Objects with a useAt are fetched into the cache and kept there from `leadMs` before their time
   * until `graceMs` after it. Undefined = default 48 h before and 6 h after.
   */
  prefetch?: { leadMs: number; graceMs: number } | undefined;
  now?: () => number;
}

export interface PutInput {
  size: number;
  contentType: string;
  expiresAt?: string | undefined;
  useAt?: string[] | undefined;
  body: Readable;
}

export interface OpenedObject {
  info: ObjectInfo;
  body: Readable;
  range?: ByteRange | undefined;
  stale: boolean;
  pending?: boolean;
}

/** A stored object, and whether it is only in the local spool so far. */
export interface PutResult {
  info: ObjectInfo;
  pending: boolean;
}

export interface HeadResult {
  info: ObjectInfo;
  stale: boolean;
  /** True when the object is only in the local spool and not in the backend yet. */
  pending?: boolean;
}

export interface PrefetchReport {
  at: string;
  /** Objects looked at (listed by the backend). */
  checked: number;
  /** Objects whose time is near and that are therefore wanted in the cache. */
  due: number;
  /** Fetched into the cache by this sweep. */
  fetched: number;
  /** Were due but could not be fetched (backend down, too large for the cache). */
  failed: number;
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
  readonly spool: DiskCache | undefined;
  private readonly spoolMaxBytes: number;
  private flushing = false;
  private readonly clock: () => number;
  private staleServed = 0;
  private lastRetentionSweep: RetentionSweepReport | null = null;
  private lastPrefetch: PrefetchReport | null = null;
  private prefetching = false;
  readonly timezone: string;
  readonly prefetchLeadMs: number;
  readonly prefetchGraceMs: number;
  /** What the backend last told us about each key's useAt, by etag, so a sweep only asks about changed objects. */
  private readonly useAtIndex = new Map<string, { etag: string; useAt: string[] }>();

  constructor(options: StorageOptions) {
    this.backend = options.backend;
    this.cache = options.cache;
    this.maxUploadBytes = options.maxUploadBytes;
    this.retentionSweepEnabled = options.retentionSweepEnabled;
    this.spool = options.spool;
    this.spoolMaxBytes = options.spoolMaxBytes ?? 2 * 1024 * 1024 * 1024;
    this.clock = options.now ?? Date.now;
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
    this.prefetchLeadMs = options.prefetch?.leadMs ?? 48 * 3600_000;
    this.prefetchGraceMs = options.prefetch?.graceMs ?? 6 * 3600_000;
    this.cache.setPinned((entry, now) => isDue(entry.useAt, this.timezone, now, this.prefetchLeadMs, this.prefetchGraceMs));
  }

  async put(key: string, input: PutInput): Promise<PutResult> {
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
          expiresAt: input.expiresAt,
          useAt: input.useAt
        })
      );
    } catch (error) {
      if (this.spool && isBackendUnavailable(error)) return this.keepInSpool(key, input, spooled, error);
      await this.cache.discard(spooled.path);
      throw error;
    }
    // A newer version reached the backend: a waiting older one must not be uploaded later over it.
    if (this.spool?.get(key)) await this.spool.remove(key);

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
    return { info: stored, pending: false };
  }

  /** The backend is down: the write waits in the spool (within its size cap) and is uploaded later. */
  private async keepInSpool(
    key: string,
    input: PutInput,
    spooled: { path: string; bytes: number },
    cause: BackendUnavailableError
  ): Promise<PutResult> {
    const spool = this.spool!;
    const waiting = spool.get(key)?.size ?? 0;
    if (spool.stats().bytes - waiting + spooled.bytes > this.spoolMaxBytes) {
      await this.cache.discard(spooled.path);
      throw new BackendUnavailableError(`${cause.message}; the local spool is full (${this.spoolMaxBytes} bytes)`);
    }
    const info: ObjectInfo = {
      key,
      size: spooled.bytes,
      contentType: input.contentType,
      etag: `pending-${randomUUID()}`,
      lastModified: new Date(this.clock()).toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.useAt?.length ? { useAt: input.useAt } : {})
    };
    // Copy into the spool's own directory first: it may be on another disk than the read cache.
    const copy = await spool.spool(createReadStream(spooled.path));
    await this.cache.discard(spooled.path);
    await spool.adopt(info, copy.path);
    // An older copy in the read cache must not be served instead of this one.
    await this.cache.remove(key);
    return { info, pending: true };
  }

  /**
   * Uploads the waiting writes, oldest first. Stops at the first sign that the backend is still down.
   * Returns how many went through and how many are still waiting.
   */
  async flushSpool(): Promise<{ uploaded: number; waiting: number }> {
    const spool = this.spool;
    if (!spool || this.flushing) return { uploaded: 0, waiting: spool?.stats().count ?? 0 };
    this.flushing = true;
    let uploaded = 0;
    try {
      const entries = spool.allEntries().sort((a, b) => a.lastModified.localeCompare(b.lastModified));
      for (const entry of entries) {
        const path = spool.filePath(entry);
        try {
          const stored = await this.backend.put(entry.key, createReadStream(path), {
            size: entry.size,
            contentType: entry.contentType,
            expiresAt: entry.expiresAt,
            useAt: entry.useAt
          });
          // A newer write for this key may have replaced the entry while it uploaded.
          if (spool.get(entry.key)?.etag !== entry.etag) continue;
          uploaded += 1;
          try {
            if (entry.size <= this.cache.maxBytes) await this.cache.adopt(stored, path);
          } catch {
            // the read cache is only a convenience
          }
          await spool.remove(entry.key);
        } catch (error) {
          if (isBackendUnavailable(error)) break;
          // Any other error is about this one object: leave it waiting and go on.
        }
      }
    } finally {
      this.flushing = false;
    }
    return { uploaded, waiting: spool.stats().count };
  }

  /** Opens an object for reading. Returns null when it does not exist (or its retention has passed). */
  async open(key: string, rangeHeader?: string): Promise<OpenedObject | null> {
    const now = this.clock();
    const waiting = this.spool?.get(key);
    if (waiting) {
      if (isRetentionExpired(waiting.expiresAt, now)) {
        await this.spool!.remove(key);
      } else {
        const opened = await this.serveCached(waiting, rangeHeader, false, this.spool!);
        if (opened) return { ...opened, pending: true };
      }
    }
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
    const waiting = this.spool?.get(key);
    if (waiting && !isRetentionExpired(waiting.expiresAt, now)) {
      return { info: infoOf(waiting), stale: false, pending: true };
    }
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
    await this.spool?.remove(key);
    await this.call(() => this.backend.delete(key));
    await this.cache.remove(key);
  }

  async list(prefix: string, limit?: number): Promise<ListResult> {
    const listing = await this.call(() => this.backend.list(prefix, limit));
    const waiting = (this.spool?.allEntries() ?? []).filter((e) => e.key.startsWith(prefix));
    if (waiting.length === 0) return listing;
    const merged = [
      ...listing.items.filter((i) => !waiting.some((w) => w.key === i.key)),
      ...waiting.map((e) => ({ key: e.key, size: e.size, etag: e.etag, lastModified: e.lastModified }))
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const max = limit ?? 1000;
    return { items: merged.slice(0, max), truncated: listing.truncated || merged.length > max };
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

  /**
   * Fetches into the cache every object whose useAt is near (see `prefetch` in the options), so it is
   * there when it is needed even if the backend or the internet is not. The cache keeps those objects
   * until the grace period after their time has passed. Asks the backend about an object only when its
   * etag in the listing is new, so a sweep over a large bucket is one listing.
   */
  async prefetchDue(): Promise<PrefetchReport> {
    if (this.prefetching) return this.lastPrefetch ?? { at: new Date(this.clock()).toISOString(), checked: 0, due: 0, fetched: 0, failed: 0 };
    this.prefetching = true;
    const now = this.clock();
    const report: PrefetchReport = { at: new Date(now).toISOString(), checked: 0, due: 0, fetched: 0, failed: 0 };
    try {
      const listing = await this.list("", 10000);
      const seen = new Set<string>();
      for (const item of listing.items) {
        report.checked += 1;
        seen.add(item.key);
        let known = this.useAtIndex.get(item.key);
        if (!known || known.etag !== item.etag) {
          const info = await this.call(() => this.backend.head(item.key));
          known = { etag: item.etag, useAt: info?.useAt ?? [] };
          this.useAtIndex.set(item.key, known);
        }
        if (!isDue(known.useAt, this.timezone, now, this.prefetchLeadMs, this.prefetchGraceMs)) continue;
        report.due += 1;
        const cached = this.cache.get(item.key);
        if (cached && cached.etag === item.etag) continue;
        if (item.size > this.cache.maxBytes) {
          report.failed += 1;
          continue;
        }
        try {
          const opened = await this.load(item.key, undefined);
          opened?.body.destroy();
          if (opened) report.fetched += 1;
        } catch {
          report.failed += 1;
        }
      }
      for (const key of this.useAtIndex.keys()) if (!seen.has(key)) this.useAtIndex.delete(key);
      await this.cache.prune({ dropTtlExpired: false, now });
    } finally {
      this.prefetching = false;
    }
    this.lastPrefetch = report;
    return report;
  }

  async status(): Promise<{
    backend: { kind: string; location: string; reachable: boolean };
    cache: { dir: string; bytes: number; count: number; maxBytes: number; ttlSeconds: number };
    spool: { enabled: boolean; waiting: number; bytes: number; maxBytes: number; oldest: string | null };
    staleServed: number;
    lastRetentionSweep: RetentionSweepReport | null;
    retentionSweepEnabled: boolean;
    prefetch: { timezone: string; leadHours: number; graceHours: number; pinned: number; last: PrefetchReport | null };
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
      spool: {
        enabled: this.spool !== undefined,
        waiting: this.spool?.stats().count ?? 0,
        bytes: this.spool?.stats().bytes ?? 0,
        maxBytes: this.spoolMaxBytes,
        oldest: (this.spool?.allEntries().map((e) => e.lastModified).sort()[0]) ?? null
      },
      staleServed: this.staleServed,
      lastRetentionSweep: this.lastRetentionSweep,
      retentionSweepEnabled: this.retentionSweepEnabled,
      prefetch: {
        timezone: this.timezone,
        leadHours: this.prefetchLeadMs / 3600_000,
        graceHours: this.prefetchGraceMs / 3600_000,
        pinned: this.cache.allEntries().filter((e) => this.cache.isPinned(e, this.clock())).length,
        last: this.lastPrefetch
      },
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
  private async serveCached(
    entry: CacheEntry,
    rangeHeader: string | undefined,
    stale: boolean,
    from: DiskCache = this.cache
  ): Promise<OpenedObject | undefined> {
    const range = resolveRange(rangeHeader, entry.size);
    const body = createReadStream(from.filePath(entry), range ? { start: range.start, end: range.end } : undefined);
    try {
      await once(body, "open");
    } catch {
      body.destroy();
      await from.remove(entry.key);
      return undefined;
    }
    from.touch(entry.key);
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
