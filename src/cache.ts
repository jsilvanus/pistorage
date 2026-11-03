import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PassThrough, type Readable, type Transform } from "node:stream";
import type { ObjectInfo } from "./backend.js";
import { isRetentionExpired } from "./retention.js";

/** A cached object. `lastAccess` (ms) drives both the TTL and the LRU order. */
export interface CacheEntry extends ObjectInfo {
  lastAccess: number;
}

export interface DiskCacheOptions {
  dir: string;
  ttlMs: number;
  maxBytes: number;
  now?: () => number;
}

export interface PruneResult {
  removed: number;
  freedBytes: number;
}

function stemOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

/**
 * Read-through cache on local disk. Each object is `objects/<sha256 of key>.bin` with a `.json`
 * sidecar holding its metadata and last access time. Access times are kept in memory and written
 * back by `flush()` (the periodic sweep), so reads do not write to an SD card.
 *
 * Eviction: entries past the TTL (counted from last access) are dropped while the backend is
 * reachable; entries past their retention deadline are always dropped; the least recently used
 * entries are dropped while the total is over `maxBytes`.
 */
export class DiskCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly dirty = new Set<string>();
  private totalBytes = 0;
  private readonly objectsDir: string;
  private readonly tmpDir: string;
  private readonly clock: () => number;
  private pinned: (entry: CacheEntry, now: number) => boolean = () => false;

  private constructor(private readonly options: DiskCacheOptions) {
    this.objectsDir = join(options.dir, "objects");
    this.tmpDir = join(options.dir, "tmp");
    this.clock = options.now ?? Date.now;
  }

  /** Opens the cache directory, loads the index and removes files left by an interrupted run. */
  static async open(options: DiskCacheOptions): Promise<DiskCache> {
    const cache = new DiskCache(options);
    await cache.load();
    return cache;
  }

  /**
   * Entries for which this returns true are kept: not dropped for age and not evicted for size
   * (a retention deadline still removes them). Used for objects that are about to be needed.
   */
  setPinned(predicate: (entry: CacheEntry, now: number) => boolean): void {
    this.pinned = predicate;
  }

  isPinned(entry: CacheEntry, now: number = this.clock()): boolean {
    return this.pinned(entry, now);
  }

  dirOf(): string {
    return this.options.dir;
  }

  get maxBytes(): number {
    return this.options.maxBytes;
  }

  get ttlMs(): number {
    return this.options.ttlMs;
  }

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  filePath(entry: CacheEntry): string {
    return join(this.objectsDir, `${stemOf(entry.key)}.bin`);
  }

  stats(): { bytes: number; count: number } {
    return { bytes: this.totalBytes, count: this.entries.size };
  }

  isTtlExpired(entry: CacheEntry, now: number = this.clock()): boolean {
    return now - entry.lastAccess > this.options.ttlMs;
  }

  touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastAccess = this.clock();
    this.dirty.add(key);
  }

  /** Writes a stream to a temporary file and returns its path plus the byte count. */
  async spool(source: Readable, transform: Transform = new PassThrough()): Promise<{ path: string; bytes: number }> {
    await mkdir(this.tmpDir, { recursive: true });
    const path = join(this.tmpDir, `${randomUUID()}.part`);
    try {
      await pipeline(source, transform, createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return { path, bytes: (await stat(path)).size };
  }

  /** Moves a spooled file into place as the cached copy of `info.key`, then enforces the size cap. */
  async adopt(info: ObjectInfo, spooled: string): Promise<CacheEntry> {
    await mkdir(this.objectsDir, { recursive: true });
    const stem = join(this.objectsDir, stemOf(info.key));
    await rename(spooled, `${stem}.bin`);
    const entry: CacheEntry = { ...info, lastAccess: this.clock() };
    await writeJsonAtomic(`${stem}.json`, entry);
    const previous = this.entries.get(info.key);
    if (previous) this.totalBytes -= previous.size;
    this.entries.set(info.key, entry);
    this.totalBytes += entry.size;
    this.dirty.delete(info.key);
    await this.prune({ dropTtlExpired: false, exclude: info.key });
    return entry;
  }

  async discard(spooled: string): Promise<void> {
    await rm(spooled, { force: true });
  }

  async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    this.dirty.delete(key);
    if (entry) this.totalBytes -= entry.size;
    const stem = join(this.objectsDir, stemOf(key));
    await rm(`${stem}.bin`, { force: true });
    await rm(`${stem}.json`, { force: true });
  }

  /**
   * Drops dead entries, then least-recently-used ones until under the size cap.
   * `dropTtlExpired` is false while the backend is unreachable, so that stale copies stay readable.
   */
  async prune(options: { dropTtlExpired: boolean; exclude?: string; now?: number }): Promise<PruneResult> {
    const now = options.now ?? this.clock();
    let removed = 0;
    let freedBytes = 0;
    for (const entry of [...this.entries.values()]) {
      const dead =
        isRetentionExpired(entry.expiresAt, now) ||
        (options.dropTtlExpired && this.isTtlExpired(entry, now) && !this.pinned(entry, now));
      if (!dead) continue;
      freedBytes += entry.size;
      removed += 1;
      await this.remove(entry.key);
    }
    if (this.totalBytes > this.options.maxBytes) {
      const byAge = [...this.entries.values()]
        .filter((entry) => entry.key !== options.exclude && !this.pinned(entry, now))
        .sort((a, b) => a.lastAccess - b.lastAccess);
      for (const entry of byAge) {
        if (this.totalBytes <= this.options.maxBytes) break;
        freedBytes += entry.size;
        removed += 1;
        await this.remove(entry.key);
      }
    }
    return { removed, freedBytes };
  }

  /** Writes the in-memory access times of touched entries back to their sidecars. */
  async flush(): Promise<void> {
    for (const key of [...this.dirty]) {
      this.dirty.delete(key);
      const entry = this.entries.get(key);
      if (!entry) continue;
      await writeJsonAtomic(join(this.objectsDir, `${stemOf(key)}.json`), entry);
    }
  }

  allEntries(): CacheEntry[] {
    return [...this.entries.values()];
  }

  private async load(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true });
    await rm(this.tmpDir, { recursive: true, force: true });
    const names = await readdir(this.objectsDir);
    const known = new Set<string>();
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const path = join(this.objectsDir, name);
      try {
        const entry = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
        const stem = stemOf(entry.key);
        const data = await stat(join(this.objectsDir, `${stem}.bin`));
        if (name !== `${stem}.json` || data.size !== entry.size) throw new Error("sidecar does not match its data");
        this.entries.set(entry.key, entry);
        this.totalBytes += entry.size;
        known.add(`${stem}.bin`);
      } catch {
        await rm(path, { force: true });
      }
    }
    for (const name of names.filter((n) => n.endsWith(".bin") && !known.has(n))) {
      await rm(join(this.objectsDir, name), { force: true });
    }
  }
}
