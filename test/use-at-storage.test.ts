import { afterEach, describe, expect, it } from "vitest";
import { appFor, makeHarness, streamOf, type Harness } from "./helpers.js";

const HOUR = 3600_000;

describe("useAt in storage", () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
  });
  const make = async (now: string, options: Parameters<typeof makeHarness>[0] = {}) => {
    const h = await makeHarness(options);
    h.clock.now = Date.parse(now);
    harnesses.push(h);
    return h;
  };
  const put = (h: Harness, key: string, useAt?: string[]) =>
    h.storage.put(key, { size: 5, contentType: "text/plain", body: streamOf("hello"), ...(useAt ? { useAt } : {}) });

  it("is stored with the object, returned in headers and JSON, and refused when not a date", async () => {
    const h = await make("2026-11-06T12:00:00Z");
    const app = appFor(h.storage);
    const stored = await app.inject({ method: "PUT", url: "/api/v1/objects/a.txt", headers: { "x-pistorage-use-at": "2026-11-08, 2026-11-15/2026-11-16" }, payload: "hello" });
    expect(stored.statusCode).toBe(201);
    expect(stored.json().useAt).toEqual(["2026-11-08", "2026-11-15/2026-11-16"]);
    const head = await app.inject({ method: "HEAD", url: "/api/v1/objects/a.txt" });
    expect(head.headers["x-pistorage-use-at"]).toBe("2026-11-08, 2026-11-15/2026-11-16");
    const bad = await app.inject({ method: "PUT", url: "/api/v1/objects/b.txt", headers: { "x-pistorage-use-at": "next sunday" }, payload: "x" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID_USE_AT");
    await app.close();
  });

  it("prefetch pulls a due object into the cache, leaves the rest, and asks about unchanged objects only once", async () => {
    const h = await make("2026-11-06T12:00:00Z"); // two days before the use date
    await put(h, "soon.txt", ["2026-11-08"]);
    await put(h, "later.txt", ["2026-12-24"]);
    await put(h, "plain.txt");
    for (const key of ["soon.txt", "later.txt", "plain.txt"]) await h.cache.remove(key);

    const report = await h.storage.prefetchDue();
    expect(report).toMatchObject({ checked: 3, due: 1, fetched: 1, failed: 0 });
    expect(h.cache.get("soon.txt")).toBeDefined();
    expect(h.cache.get("later.txt")).toBeUndefined();

    const heads = h.backend.calls.filter((c) => c === "head").length;
    expect((await h.storage.prefetchDue()).fetched).toBe(0);
    expect(h.backend.calls.filter((c) => c === "head").length).toBe(heads);
  });

  it("keeps a due object against age and size eviction, and lets it go after the grace", async () => {
    const h = await make("2026-11-06T12:00:00Z", { ttlMs: HOUR, maxBytes: 12 });
    await put(h, "soon.txt", ["2026-11-08"]);
    h.clock.now = Date.parse("2026-11-08T08:00:00Z"); // far past the ttl, inside the day
    await put(h, "filler-1.txt");
    await put(h, "filler-2.txt"); // 15 bytes in a 12 byte cache: something must go, but not the pinned one
    expect(h.cache.get("soon.txt")).toBeDefined();
    await h.cache.prune({ dropTtlExpired: true });
    expect(h.cache.get("soon.txt")).toBeDefined();

    h.clock.now = Date.parse("2026-11-09T03:00:00Z"); // the local day ended at 22:00 UTC, 5 h ago: inside the 6 h grace
    await h.cache.prune({ dropTtlExpired: true });
    expect(h.cache.get("soon.txt")).toBeDefined();
    h.clock.now = Date.parse("2026-11-09T05:00:00Z"); // 7 h after the end of the day
    await h.cache.prune({ dropTtlExpired: true });
    expect(h.cache.get("soon.txt")).toBeUndefined();
  });

  it("a prefetched object is still readable when the backend is offline", async () => {
    const h = await make("2026-11-08T07:00:00Z");
    await put(h, "service.txt", ["2026-11-08T10:00"]);
    await h.cache.remove("service.txt");
    await h.storage.prefetchDue();
    h.backend.offline = true;
    const opened = await h.storage.open("service.txt");
    expect(opened).not.toBeNull();
    opened?.body.destroy();
  });
});

describe("changing useAt of an existing object", () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
  });
  const make = async (now: string, options: Parameters<typeof makeHarness>[0] = {}) => {
    const h = await makeHarness(options);
    h.clock.now = Date.parse(now);
    harnesses.push(h);
    return h;
  };
  const put = (h: Harness, key: string, useAt?: string[], extra: { expiresAt?: string } = {}) =>
    h.storage.put(key, { size: 5, contentType: "text/plain", body: streamOf("hello"), ...(useAt ? { useAt } : {}), ...extra });

  it("changes and clears the date in the backend and the cached copy without sending the bytes again", async () => {
    const h = await make("2026-11-06T12:00:00Z");
    await put(h, "a.txt", ["2026-12-24"], { expiresAt: "2027-01-01T00:00:00.000Z" });
    const puts = h.backend.calls.filter((c) => c === "put").length;

    const changed = await h.storage.setUseAt("a.txt", ["2026-11-08"]);
    expect(changed?.info.useAt).toEqual(["2026-11-08"]);
    expect(h.backend.calls.filter((c) => c === "put").length).toBe(puts);
    expect(await h.backend.head("a.txt")).toMatchObject({ useAt: ["2026-11-08"], contentType: "text/plain", expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(h.cache.get("a.txt")?.useAt).toEqual(["2026-11-08"]);
    // the new date makes it due now, so the cache keeps it
    expect(h.cache.isPinned(h.cache.get("a.txt")!, h.clock.now)).toBe(true);

    const cleared = await h.storage.setUseAt("a.txt", []);
    expect(cleared?.info.useAt).toBeUndefined();
    expect((await h.backend.head("a.txt"))?.useAt).toBeUndefined();
    expect(h.cache.get("a.txt")?.useAt).toBeUndefined();
  });

  it("is noticed by the next prefetch sweep even though the object itself did not change", async () => {
    const h = await make("2026-11-06T12:00:00Z");
    await put(h, "a.txt", ["2026-12-24"]);
    await h.cache.remove("a.txt");
    expect((await h.storage.prefetchDue()).fetched).toBe(0); // not due yet, and now remembered
    await h.storage.setUseAt("a.txt", ["2026-11-08"]);
    expect((await h.storage.prefetchDue()).fetched).toBe(1);
  });

  it("changes an object that still waits in the spool, and answers null for a missing one", async () => {
    const h = await make("2026-11-06T12:00:00Z", { spool: true });
    h.backend.offline = true;
    const queued = await put(h, "w.txt", ["2026-12-24"]);
    expect(queued.pending).toBe(true);
    const changed = await h.storage.setUseAt("w.txt", ["2026-11-08"]);
    expect(changed).toMatchObject({ pending: true, info: { useAt: ["2026-11-08"] } });
    h.backend.offline = false;
    await h.storage.flushSpool();
    expect((await h.backend.head("w.txt"))?.useAt).toEqual(["2026-11-08"]);
    expect(await h.storage.setUseAt("nope.txt", ["2026-11-08"])).toBeNull();
  });

  it("is available over HTTP: a date, a list, null to clear, 400 for a bad value, 404 for a missing object", async () => {
    const h = await make("2026-11-06T12:00:00Z");
    await put(h, "a.txt");
    const app = appFor(h.storage);
    const call = (payload: unknown) => app.inject({ method: "POST", url: "/api/v1/use-at", payload: payload as object });
    const one = await call({ key: "a.txt", useAt: "2026-11-08, 2026-11-15" });
    expect(one.statusCode).toBe(200);
    expect(one.json().useAt).toEqual(["2026-11-08", "2026-11-15"]);
    expect((await call({ key: "a.txt", useAt: ["2026-11-20/2026-11-21"] })).json().useAt).toEqual(["2026-11-20/2026-11-21"]);
    expect((await call({ key: "a.txt", useAt: null })).json().useAt).toBeUndefined();
    const bad = await call({ key: "a.txt", useAt: "next sunday" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID_USE_AT");
    expect((await call({ key: "a.txt", useAt: 5 })).statusCode).toBe(400);
    expect((await call({ key: "missing.txt", useAt: "2026-11-08" })).statusCode).toBe(404);
    await app.close();
  });
});
