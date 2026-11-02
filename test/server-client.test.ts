import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PiStorageClient, PiStorageClientError } from "../src/client.js";
import { buildServer } from "../src/server.js";
import { DAY_MS, makeHarness, type Harness } from "./helpers.js";

let h: Harness;
let app: FastifyInstance;

async function start(apiKey?: string, options: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness({ maxUploadBytes: 1000, ...options });
  app = buildServer({ storage: h.storage, apiKey });
  await app.ready();
}

afterEach(async () => {
  await app?.close();
  await h?.cleanup();
});

/** Lets the client run in-process: fetch is answered by app.inject, so no socket is opened. */
function injectFetch(server: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    let payload: Buffer | string | undefined;
    if (init.body instanceof Blob) payload = Buffer.from(await init.body.arrayBuffer());
    else if (init.body instanceof Uint8Array) payload = Buffer.from(init.body);
    else if (typeof init.body === "string") payload = init.body;
    const res = await server.inject({ method: method as "GET", url: url.pathname + url.search, headers, payload: payload ?? undefined });
    const outHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined) outHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    const noBody = method === "HEAD" || res.statusCode === 204 || res.statusCode === 304;
    return new Response(noBody ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: outHeaders });
  }) as typeof fetch;
}

describe("HTTP API", () => {
  beforeEach(async () => {
    await start();
  });

  it("stores bytes as sent, including a JSON body, and reads them back with type and ETag", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/objects/data/doc.json",
      headers: { "content-type": "application/json" },
      payload: '{"x":1}'
    });
    expect(put.statusCode).toBe(201);
    expect(put.json()).toMatchObject({ key: "data/doc.json", size: 7, contentType: "application/json" });

    const get = await app.inject({ method: "GET", url: "/api/v1/objects/data/doc.json" });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe('{"x":1}');
    expect(get.headers["content-type"]).toBe("application/json");
    expect(get.headers["accept-ranges"]).toBe("bytes");
    expect(get.headers.etag).toMatch(/^"[0-9a-f]+"$/);
    expect(get.headers["x-pistorage-stale"]).toBeUndefined();
  });

  it("accepts keys with spaces, non-ASCII characters and encoded slashes in the path", async () => {
    const url = `/api/v1/objects/${encodeURIComponent("kirkko")}/${encodeURIComponent("ääkkö 1.txt")}`;
    expect((await app.inject({ method: "PUT", url, payload: "x" })).statusCode).toBe(201);
    const get = await app.inject({ method: "GET", url });
    expect(get.body).toBe("x");
    const listing = await app.inject({ method: "GET", url: "/api/v1/objects?prefix=kirkko/" });
    expect(listing.json().items.map((item: { key: string }) => item.key)).toEqual(["kirkko/ääkkö 1.txt"]);
  });

  it("answers HEAD with the headers and no body, and 404 for a missing object", async () => {
    await app.inject({ method: "PUT", url: "/api/v1/objects/h", headers: { "content-type": "text/plain" }, payload: "abcd" });
    const head = await app.inject({ method: "HEAD", url: "/api/v1/objects/h" });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe("4");
    expect(head.body).toBe("");
    expect((await app.inject({ method: "HEAD", url: "/api/v1/objects/none" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/objects/none" })).json().error.code).toBe("NOT_FOUND");
  });

  it("serves a byte range with 206 and Content-Range, and 416 when it is outside the object", async () => {
    await app.inject({ method: "PUT", url: "/api/v1/objects/r", payload: "0123456789" });
    const partial = await app.inject({ method: "GET", url: "/api/v1/objects/r", headers: { range: "bytes=2-4" } });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("234");
    expect(partial.headers["content-range"]).toBe("bytes 2-4/10");
    expect(partial.headers["content-length"]).toBe("3");

    const suffix = await app.inject({ method: "GET", url: "/api/v1/objects/r", headers: { range: "bytes=-2" } });
    expect(suffix.body).toBe("89");

    const outside = await app.inject({ method: "GET", url: "/api/v1/objects/r", headers: { range: "bytes=50-" } });
    expect(outside.statusCode).toBe(416);
    expect(outside.headers["content-range"]).toBe("bytes */10");
  });

  it("deletes idempotently", async () => {
    await app.inject({ method: "PUT", url: "/api/v1/objects/d", payload: "x" });
    expect((await app.inject({ method: "DELETE", url: "/api/v1/objects/d" })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/objects/d" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/objects/d" })).statusCode).toBe(404);
  });

  it("refuses invalid keys with 400", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/v1/objects/x..y", payload: "x" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_KEY");
  });

  it("answers 413 for an object over the upload limit, before reading it", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/objects/big",
      headers: { "content-length": "5000" },
      payload: "x".repeat(5000)
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("TOO_LARGE");
  });

  it("stores retention deadlines from the header and refuses past or invalid ones", async () => {
    const future = new Date(Date.now() + 60 * DAY_MS).toISOString();
    const ok = await app.inject({
      method: "PUT",
      url: "/api/v1/objects/keep",
      headers: { "x-pistorage-expires-at": future },
      payload: "x"
    });
    expect(ok.json().expiresAt).toBe(future);
    const head = await app.inject({ method: "HEAD", url: "/api/v1/objects/keep" });
    expect(head.headers["x-pistorage-expires-at"]).toBe(future);

    const past = await app.inject({
      method: "PUT",
      url: "/api/v1/objects/old",
      headers: { "x-pistorage-expires-at": "2001-01-01T00:00:00Z" },
      payload: "x"
    });
    expect(past.statusCode).toBe(400);
    const junk = await app.inject({
      method: "PUT",
      url: "/api/v1/objects/junk",
      headers: { "x-pistorage-expires-at": "soon" },
      payload: "x"
    });
    expect(junk.statusCode).toBe(400);
  });

  it("lists with a prefix and a limit", async () => {
    for (const name of ["a/1", "a/2", "a/3", "b/1"]) {
      await app.inject({ method: "PUT", url: `/api/v1/objects/${name}`, payload: "x" });
    }
    const listing = await app.inject({ method: "GET", url: "/api/v1/objects?prefix=a/&limit=2" });
    expect(listing.json()).toMatchObject({ truncated: true });
    expect(listing.json().items).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/v1/objects?limit=0" })).statusCode).toBe(400);
  });

  it("answers 503 for a write while the backend is offline", async () => {
    h.backend.offline = true;
    const response = await app.inject({ method: "PUT", url: "/api/v1/objects/z", payload: "x" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("BACKEND_UNAVAILABLE");
  });

  it("marks a stale response with x-pistorage-stale: 1 when the backend is offline past the TTL", async () => {
    await app.inject({ method: "PUT", url: "/api/v1/objects/s", payload: "cached" });
    h.clock.now += 15 * DAY_MS;
    h.backend.offline = true;
    const response = await app.inject({ method: "GET", url: "/api/v1/objects/s" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("cached");
    expect(response.headers["x-pistorage-stale"]).toBe("1");
  });

  it("reports status, prunes the cache and runs the retention sweep only when enabled", async () => {
    const status = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(status.json()).toMatchObject({
      backend: { kind: "local", reachable: true },
      retentionSweepEnabled: false,
      maxUploadBytes: 1000
    });
    h.backend.offline = true;
    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).json().backend.reachable).toBe(false);
    h.backend.offline = false;

    expect((await app.inject({ method: "POST", url: "/api/v1/cache/prune" })).json()).toMatchObject({
      backendReachable: true
    });
    expect((await app.inject({ method: "POST", url: "/api/v1/retention/sweep" })).statusCode).toBe(409);
  });

  it("answers health without a key and 404 for unknown routes", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok", service: "pistorage" });
    expect((await app.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
  });
});

describe("HTTP API with an API key", () => {
  beforeEach(async () => {
    await start("s3cret");
  });

  it("refuses every /api/v1 request without the key, reads included", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/objects" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/v1/objects/a", payload: "x" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/objects", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
  });

  it("accepts the bearer token or x-api-key, and keeps /health open", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/objects", headers: { authorization: "Bearer s3cret" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/objects", headers: { "x-api-key": "s3cret" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("PiStorageClient", () => {
  beforeEach(async () => {
    await start("key-1");
  });

  it("puts, heads, gets and deletes through the HTTP API", async () => {
    const client = new PiStorageClient({ baseUrl: "http://pistorage.test", apiKey: "key-1", fetch: injectFetch(app) });
    const info = await client.put("exports/logo.png", new TextEncoder().encode("PNGDATA"), { contentType: "image/png" });
    expect(info).toMatchObject({ key: "exports/logo.png", size: 7, contentType: "image/png" });

    const head = await client.head("exports/logo.png");
    expect(head).toMatchObject({ size: 7, contentType: "image/png" });
    expect(head?.etag).toHaveLength(32);

    const response = await client.get("exports/logo.png");
    expect(await response.text()).toBe("PNGDATA");

    const partial = await client.get("exports/logo.png", { range: { start: 0, end: 2 } });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("PNG");

    await client.delete("exports/logo.png");
    expect(await client.head("exports/logo.png")).toBeNull();
  });

  it("sends a retention deadline and lists by prefix", async () => {
    const client = new PiStorageClient({ baseUrl: "http://pistorage.test", apiKey: "key-1", fetch: injectFetch(app) });
    const expiresAt = new Date(Date.now() + 60 * DAY_MS);
    const info = await client.put("canva/a", "x", { expiresAt });
    expect(info.expiresAt).toBe(expiresAt.toISOString());
    const listing = await client.list("canva/");
    expect(listing.items.map((item) => item.key)).toEqual(["canva/a"]);
  });

  it("throws a typed error with the server code, for a wrong key or a missing object", async () => {
    const wrong = new PiStorageClient({ baseUrl: "http://pistorage.test", apiKey: "nope", fetch: injectFetch(app) });
    const error = await wrong.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiStorageClientError);
    expect((error as PiStorageClientError).status).toBe(401);

    const client = new PiStorageClient({ baseUrl: "http://pistorage.test", apiKey: "key-1", fetch: injectFetch(app) });
    const missing = await client.get("absent").catch((e: unknown) => e);
    expect((missing as PiStorageClientError).code).toBe("NOT_FOUND");
  });

  it("answers status and admin calls", async () => {
    const client = new PiStorageClient({ baseUrl: "http://pistorage.test", apiKey: "key-1", fetch: injectFetch(app) });
    expect(await client.status()).toMatchObject({ backend: { kind: "local" } });
    expect(await client.pruneCache()).toMatchObject({ backendReachable: true });
  });

  it("accepts a Blob body and a streamed-free string body", async () => {
    const client = new PiStorageClient({ baseUrl: "http://pistorage.test", apiKey: "key-1", fetch: injectFetch(app) });
    await client.put("blob", new Blob(["blob-bytes"]));
    expect(await (await client.get("blob")).text()).toBe("blob-bytes");
    await client.put("text", "plain text");
    expect(await (await client.get("text")).text()).toBe("plain text");
  });
});

describe("client against a backend that is down", () => {
  it("surfaces 503 from a write", async () => {
    await start();
    h.backend.offline = true;
    const client = new PiStorageClient({ baseUrl: "http://pistorage.test", fetch: injectFetch(app) });
    const error = await client.put("x", "y").catch((e: unknown) => e);
    expect((error as PiStorageClientError).status).toBe(503);
  });
});
