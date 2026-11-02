import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskCache } from "../src/cache.js";
import { BackendUnavailableError, StorageError } from "../src/errors.js";
import { DAY_MS, makeHarness, readAll, streamOf, T0, type Harness } from "./helpers.js";

const body = (text: string) => ({ size: Buffer.byteLength(text), contentType: "text/plain", body: streamOf(text) });

async function putText(h: Harness, key: string, text: string, expiresAt?: string) {
  return h.storage.put(key, { ...body(text), expiresAt });
}

async function readOpened(opened: { body: NodeJS.ReadableStream } | null): Promise<string> {
  if (!opened) throw new Error("expected an object");
  return (await readAll(opened.body as never)).toString();
}

describe("DiskCache", () => {
  let dir: string;
  let clock: { now: number };
  const now = () => clock.now;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pistorage-cache-"));
    clock = { now: T0 };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function addEntry(cache: DiskCache, key: string, text: string) {
    const spooled = await cache.spool(streamOf(text));
    return cache.adopt({ key, size: text.length, contentType: "text/plain", etag: key, lastModified: "" }, spooled.path);
  }

  it("treats an entry as expired only after the TTL from its last access", async () => {
    const cache = await DiskCache.open({ dir, ttlMs: DAY_MS, maxBytes: 1000, now });
    await addEntry(cache, "a", "xx");
    clock.now += DAY_MS;
    expect(cache.isTtlExpired(cache.get("a")!, clock.now)).toBe(false);
    cache.touch("a");
    clock.now += DAY_MS;
    expect(cache.isTtlExpired(cache.get("a")!, clock.now)).toBe(false);
    clock.now += DAY_MS + 1;
    expect(cache.isTtlExpired(cache.get("a")!, clock.now)).toBe(true);
  });

  it("evicts the least recently used entries when over the size cap", async () => {
    const cache = await DiskCache.open({ dir, ttlMs: 100 * DAY_MS, maxBytes: 100, now });
    await addEntry(cache, "a", "x".repeat(40));
    clock.now += 1000;
    await addEntry(cache, "b", "y".repeat(40));
    clock.now += 1000;
    cache.touch("a"); // a is now the most recently used
    clock.now += 1000;
    await addEntry(cache, "c", "z".repeat(40)); // 120 bytes: b (least recent) goes
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.stats().bytes).toBe(80);
  });

  it("drops TTL-expired entries only when asked (the backend is reachable)", async () => {
    const cache = await DiskCache.open({ dir, ttlMs: DAY_MS, maxBytes: 1000, now });
    await addEntry(cache, "a", "x");
    clock.now += 2 * DAY_MS;
    await cache.prune({ dropTtlExpired: false });
    expect(cache.get("a")).toBeDefined();
    const result = await cache.prune({ dropTtlExpired: true });
    expect(result.removed).toBe(1);
    expect(cache.get("a")).toBeUndefined();
  });

  it("writes access times back on flush and reloads them with the index", async () => {
    const cache = await DiskCache.open({ dir, ttlMs: 100 * DAY_MS, maxBytes: 1000, now });
    await addEntry(cache, "a", "hello");
    clock.now += 5000;
    cache.touch("a");
    await cache.flush();
    const reopened = await DiskCache.open({ dir, ttlMs: 100 * DAY_MS, maxBytes: 1000, now });
    expect(reopened.get("a")?.lastAccess).toBe(T0 + 5000);
    expect(reopened.stats()).toEqual({ bytes: 5, count: 1 });
  });

  it("removes files left behind by an interrupted write", async () => {
    const cache = await DiskCache.open({ dir, ttlMs: DAY_MS, maxBytes: 1000, now });
    await addEntry(cache, "a", "hello");
    await writeFile(join(dir, "objects", "orphan.bin"), "junk");
    await DiskCache.open({ dir, ttlMs: DAY_MS, maxBytes: 1000, now });
    const names = await readdir(join(dir, "objects"));
    expect(names).not.toContain("orphan.bin");
    expect(names.filter((n) => n.endsWith(".bin"))).toHaveLength(1);
  });
});

describe("PiStorage: read-through cache", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness({ ttlMs: 14 * DAY_MS });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("writes to the backend and then keeps the copy, so a read needs no backend call", async () => {
    await putText(h, "a.txt", "hello");
    expect(h.backend.calls).toEqual(["put"]);
    h.backend.calls = [];
    const opened = await h.storage.open("a.txt");
    expect(await readOpened(opened)).toBe("hello");
    expect(opened?.stale).toBe(false);
    expect(h.backend.calls).toEqual([]);
  });

  it("fills the cache on a miss and serves the next read from disk", async () => {
    await h.backend.inner.put("direct.txt", streamOf("from backend"), { size: 12, contentType: "text/plain" });
    expect(await readOpened(await h.storage.open("direct.txt"))).toBe("from backend");
    h.backend.calls = [];
    expect(await readOpened(await h.storage.open("direct.txt"))).toBe("from backend");
    expect(h.backend.calls).toEqual([]);
    expect(h.cache.get("direct.txt")).toBeDefined();
  });

  it("asks the backend again once the copy is past its TTL, and refreshes it", async () => {
    await putText(h, "a.txt", "one");
    h.clock.now += 15 * DAY_MS;
    h.backend.calls = [];
    expect(await readOpened(await h.storage.open("a.txt"))).toBe("one");
    expect(h.backend.calls).toContain("get");
    expect(h.cache.isTtlExpired(h.cache.get("a.txt")!, h.clock.now)).toBe(false);
  });

  it("serves a copy past its TTL when the backend is offline, marked stale", async () => {
    await putText(h, "a.txt", "old copy");
    h.clock.now += 15 * DAY_MS;
    h.backend.offline = true;
    const opened = await h.storage.open("a.txt");
    expect(opened?.stale).toBe(true);
    expect(await readOpened(opened)).toBe("old copy");
    expect((await h.storage.status()).staleServed).toBe(1);
  });

  it("serves a fresh copy without marking it stale while offline", async () => {
    await putText(h, "a.txt", "fresh");
    h.backend.offline = true;
    const opened = await h.storage.open("a.txt");
    expect(opened?.stale).toBe(false);
    expect(await readOpened(opened)).toBe("fresh");
  });

  it("cannot serve an uncached object while the backend is offline", async () => {
    await h.backend.inner.put("cold", streamOf("x"), { size: 1, contentType: "text/plain" });
    h.backend.offline = true;
    await expect(h.storage.open("cold")).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it("fails a write with 503 while the backend is offline, and keeps nothing", async () => {
    h.backend.offline = true;
    const error = await putText(h, "lost.txt", "data").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect((error as StorageError).status).toBe(503);
    expect(h.cache.get("lost.txt")).toBeUndefined();
    h.backend.offline = false;
    expect(await h.backend.inner.head("lost.txt")).toBeNull();
  });

  it("replaces an older cached copy on overwrite", async () => {
    await putText(h, "a.txt", "first");
    await putText(h, "a.txt", "second!");
    expect(await readOpened(await h.storage.open("a.txt"))).toBe("second!");
  });

  it("serves byte ranges from the cache and from the backend", async () => {
    await putText(h, "r.txt", "0123456789");
    const cached = await h.storage.open("r.txt", "bytes=2-4");
    expect(cached?.range).toEqual({ start: 2, end: 4 });
    expect(await readOpened(cached)).toBe("234");

    await h.backend.inner.put("cold.txt", streamOf("0123456789"), { size: 10, contentType: "text/plain" });
    const direct = await h.storage.open("cold.txt", "bytes=-3");
    expect(await readOpened(direct)).toBe("789");
  });

  it("does not keep objects larger than the cache cap, but still serves them", async () => {
    const small = await makeHarness({ maxBytes: 8, maxUploadBytes: 100 });
    try {
      await small.storage.put("big", { size: 12, contentType: "text/plain", body: streamOf("abcdefghijkl") });
      expect(small.cache.get("big")).toBeUndefined();
      expect(await readOpened(await small.storage.open("big"))).toBe("abcdefghijkl");
    } finally {
      await small.cleanup();
    }
  });

  it("deletes from the backend and the cache", async () => {
    await putText(h, "gone.txt", "bye");
    await h.storage.delete("gone.txt");
    expect(h.cache.get("gone.txt")).toBeUndefined();
    expect(await h.storage.open("gone.txt")).toBeNull();
    expect(await h.storage.head("gone.txt")).toBeNull();
  });

  it("rejects a body that does not match its declared length", async () => {
    const error = await h.storage
      .put("bad", { size: 5, contentType: "text/plain", body: streamOf("abc") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("BODY_LENGTH_MISMATCH");
    expect(await h.backend.inner.head("bad")).toBeNull();
  });

  it("refuses an upload over the size limit with 413", async () => {
    const error = await h.storage
      .put("huge", { size: 2 * 1024 * 1024, contentType: "x/y", body: streamOf("") })
      .catch((e: unknown) => e);
    expect((error as StorageError).status).toBe(413);
  });

  it("answers head from the cache while fresh and from the backend otherwise", async () => {
    await putText(h, "h.txt", "abc");
    h.backend.calls = [];
    expect((await h.storage.head("h.txt"))?.info.size).toBe(3);
    expect(h.backend.calls).toEqual([]);
    h.clock.now += 15 * DAY_MS;
    h.backend.offline = true;
    const stale = await h.storage.head("h.txt");
    expect(stale?.stale).toBe(true);
  });
});

describe("PiStorage: retention", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness({ retentionSweepEnabled: true });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("reads an object as missing once its retention has passed", async () => {
    const expiresAt = new Date(T0 + 60 * DAY_MS).toISOString();
    await putText(h, "canva/slide.png", "png", expiresAt);
    expect((await h.storage.head("canva/slide.png"))?.info.expiresAt).toBe(expiresAt);
    h.clock.now += 61 * DAY_MS;
    expect(await h.storage.open("canva/slide.png")).toBeNull();
    expect(await h.storage.head("canva/slide.png")).toBeNull();
  });

  it("deletes expired objects from the backend and the cache in the sweep, and keeps the rest", async () => {
    await putText(h, "short", "s", new Date(T0 + DAY_MS).toISOString());
    await putText(h, "long", "l", new Date(T0 + 365 * DAY_MS).toISOString());
    await putText(h, "forever", "f");
    h.clock.now += 2 * DAY_MS;
    const report = await h.storage.sweepRetention();
    expect(report).toMatchObject({ checked: 3, deleted: 1 });
    expect(await h.backend.inner.head("short")).toBeNull();
    expect(h.cache.get("short")).toBeUndefined();
    expect(await h.backend.inner.head("long")).not.toBeNull();
    expect(await h.backend.inner.head("forever")).not.toBeNull();
    expect((await h.storage.status()).lastRetentionSweep).toEqual(report);
  });
});

describe("PiStorage: offline eviction", () => {
  it("keeps TTL-expired copies while offline, but still enforces the size cap", async () => {
    const h = await makeHarness({ ttlMs: DAY_MS, maxBytes: 10 });
    try {
      await h.storage.put("one", { size: 6, contentType: "x/y", body: streamOf("111111") });
      await h.storage.put("two", { size: 6, contentType: "x/y", body: streamOf("222222") });
      expect(h.cache.get("one")).toBeUndefined(); // over the cap: least recently used goes
      h.clock.now += 2 * DAY_MS;
      h.backend.offline = true;
      const result = await h.storage.prune();
      expect(result.backendReachable).toBe(false);
      expect(h.cache.get("two")).toBeDefined(); // past TTL but kept for stale serving
    } finally {
      await h.cleanup();
    }
  });
});
