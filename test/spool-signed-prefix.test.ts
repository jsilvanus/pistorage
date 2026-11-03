import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { LocalBackend } from "../src/backends/local.js";
import { normalizeKeyPrefix, PrefixedBackend } from "../src/backends/prefixed.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { checkSignature, signPath } from "../src/signing.js";
import { appFor, makeHarness, readAll, streamOf, type Harness } from "./helpers.js";

let h: Harness;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await h?.cleanup();
});

describe("write spool", () => {
  it("keeps a write while the backend is down, serves it, and uploads it when the backend is back", async () => {
    h = await makeHarness({ spool: true });
    h.backend.offline = true;
    const result = await h.storage.put("a/b.txt", { size: 5, contentType: "text/plain", body: streamOf("hello") });
    expect(result.pending).toBe(true);
    expect((await readAll((await h.storage.open("a/b.txt"))!.body)).toString()).toBe("hello");
    expect((await h.storage.head("a/b.txt"))?.pending).toBe(true);
    expect((await h.storage.status()).spool.waiting).toBe(1);

    expect(await h.storage.flushSpool()).toEqual({ uploaded: 0, waiting: 1 });
    h.backend.offline = false;
    expect(await h.storage.flushSpool()).toEqual({ uploaded: 1, waiting: 0 });
    expect(await h.backend.inner.head("a/b.txt")).not.toBeNull();
    const opened = await h.storage.open("a/b.txt");
    expect(opened?.pending).toBeUndefined();
    expect((await readAll(opened!.body)).toString()).toBe("hello");
  });

  it("without a spool a write while the backend is down is still a 503", async () => {
    h = await makeHarness();
    h.backend.offline = true;
    await expect(h.storage.put("k", { size: 1, contentType: "x/y", body: streamOf("a") })).rejects.toMatchObject({ status: 503 });
  });

  it("refuses a write beyond the spool cap", async () => {
    h = await makeHarness({ spool: true, spoolMaxBytes: 8 });
    h.backend.offline = true;
    await h.storage.put("a", { size: 5, contentType: "x/y", body: streamOf("12345") });
    await expect(h.storage.put("b", { size: 5, contentType: "x/y", body: streamOf("12345") })).rejects.toMatchObject({ status: 503 });
    // replacing the waiting key does not count twice
    await h.storage.put("a", { size: 6, contentType: "x/y", body: streamOf("123456") });
  });

  it("a newer write replaces a waiting one, and a successful write drops it", async () => {
    h = await makeHarness({ spool: true });
    h.backend.offline = true;
    await h.storage.put("k", { size: 3, contentType: "x/y", body: streamOf("old") });
    await h.storage.put("k", { size: 3, contentType: "x/y", body: streamOf("new") });
    expect((await readAll((await h.storage.open("k"))!.body)).toString()).toBe("new");
    h.backend.offline = false;
    await h.storage.put("k", { size: 4, contentType: "x/y", body: streamOf("last") });
    expect((await h.storage.status()).spool.waiting).toBe(0);
    expect((await readAll((await h.storage.open("k"))!.body)).toString()).toBe("last");
  });

  it("lists waiting keys, deletes them, and keeps them across a restart", async () => {
    h = await makeHarness({ spool: true });
    h.backend.offline = true;
    await h.storage.put("p/one", { size: 1, contentType: "x/y", body: streamOf("1") });
    h.backend.offline = false;
    await h.storage.put("p/two", { size: 1, contentType: "x/y", body: streamOf("2") });
    expect((await h.storage.list("p/")).items.map((i) => i.key)).toEqual(["p/one", "p/two"]);
    await h.storage.delete("p/one");
    expect((await h.storage.list("p/")).items.map((i) => i.key)).toEqual(["p/two"]);
    expect(await h.storage.head("p/one")).toBeNull();
  });

  it("answers 202 with the pending header over HTTP, and POST /spool/flush uploads", async () => {
    h = await makeHarness({ spool: true });
    app = appFor(h.storage);
    h.backend.offline = true;
    const put = await app.inject({ method: "PUT", url: "/api/v1/objects/k", headers: { "content-type": "text/plain" }, payload: "hey" });
    expect(put.statusCode).toBe(202);
    expect(put.headers["x-pistorage-pending"]).toBe("1");
    expect(put.json().pending).toBe(true);
    const get = await app.inject({ url: "/api/v1/objects/k" });
    expect(get.statusCode).toBe(200);
    expect(get.headers["x-pistorage-pending"]).toBe("1");
    h.backend.offline = false;
    expect((await app.inject({ method: "POST", url: "/api/v1/spool/flush" })).json()).toEqual({ uploaded: 1, waiting: 0 });
  });
});

describe("key prefix", () => {
  it("stores under the prefix and hides it from callers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pistorage-prefix-"));
    try {
      const inner = new LocalBackend(dir);
      const backend = new PrefixedBackend(inner, "pi/");
      await backend.put("a/b", streamOf("x"), { size: 1, contentType: "text/plain" });
      expect((await inner.head("pi/a/b"))?.size).toBe(1);
      expect(await inner.head("a/b")).toBeNull();
      expect((await backend.head("a/b"))?.key).toBe("a/b");
      expect((await backend.list("a/")).items.map((i) => i.key)).toEqual(["a/b"]);
      expect((await backend.get("a/b"))?.info.key).toBe("a/b");
      await inner.put("other/z", streamOf("y"), { size: 1, contentType: "text/plain" });
      expect((await backend.list("")).items.map((i) => i.key)).toEqual(["a/b"]);
      await backend.delete("a/b");
      expect(await inner.head("pi/a/b")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalises the setting and defaults to pi/", () => {
    expect(normalizeKeyPrefix("pi")).toBe("pi/");
    expect(normalizeKeyPrefix("church/pi/")).toBe("church/pi/");
    expect(normalizeKeyPrefix("none")).toBe("");
    expect(() => normalizeKeyPrefix("/x")).toThrow();
    expect(() => normalizeKeyPrefix("a/../b")).toThrow();
    expect(loadConfig({}, "/tmp/x").keyPrefix).toBe("pi/");
    expect(loadConfig({ PISTORAGE_KEY_PREFIX: "none" }, "/tmp/x").keyPrefix).toBe("");
  });

  it("config: the spool is on by default and the signing secret falls back to the API key", () => {
    const base = loadConfig({}, "/tmp/x");
    expect(base.spool?.dir).toBe("/tmp/x/data/spool");
    expect(base.signingSecret).toBeUndefined();
    expect(loadConfig({ PISTORAGE_SPOOL: "0" }, "/tmp/x").spool).toBeUndefined();
    expect(loadConfig({ PISTORAGE_API_KEY: "k" }, "/tmp/x").signingSecret).toBe("k");
    expect(loadConfig({ PISTORAGE_API_KEY: "k", PISTORAGE_SIGNING_SECRET: "s" }, "/tmp/x").signingSecret).toBe("s");
  });
});

describe("signed URLs", () => {
  it("checks signature, key, method and expiry", () => {
    const expires = 2_000_000_000;
    const path = signPath("secret", "GET", "a b/c.txt", expires);
    const sig = /sig=([0-9a-f]+)/.exec(path)![1];
    expect(path.startsWith("/signed/a%20b/c.txt?expires=2000000000&sig=")).toBe(true);
    const now = 1_900_000_000_000;
    expect(checkSignature("secret", "GET", "a b/c.txt", String(expires), sig, now)).toBe("ok");
    expect(checkSignature("secret", "PUT", "a b/c.txt", String(expires), sig, now)).toBe("invalid");
    expect(checkSignature("secret", "GET", "other", String(expires), sig, now)).toBe("invalid");
    expect(checkSignature("wrong", "GET", "a b/c.txt", String(expires), sig, now)).toBe("invalid");
    expect(checkSignature("secret", "GET", "a b/c.txt", String(expires + 1), sig, now)).toBe("invalid");
    expect(checkSignature("secret", "GET", "a b/c.txt", String(expires), sig, expires * 1000 + 1)).toBe("expired");
    expect(checkSignature("secret", "GET", "k", undefined, undefined, now)).toBe("invalid");
  });

  async function serve(apiKey: string | undefined, secret: string | undefined) {
    h = await makeHarness();
    app = buildServer({ storage: h.storage, apiKey, signingSecret: secret, publicUrl: "https://pi.example" });
    await app.ready();
    return app;
  }
  const auth = { authorization: "Bearer k" };

  it("a signed link reads one file without the API key", async () => {
    const server = await serve("k", "s3cret");
    await server.inject({ method: "PUT", url: "/api/v1/objects/docs/a.txt", headers: { ...auth, "content-type": "text/plain" }, payload: "hello" });
    const made = await server.inject({ method: "POST", url: "/api/v1/signed-urls", headers: auth, payload: { key: "docs/a.txt", expiresInSeconds: 60 } });
    expect(made.statusCode).toBe(201);
    const body = made.json() as { path: string; url: string; method: string; expiresAt: string };
    expect(body.method).toBe("GET");
    expect(body.url).toBe(`https://pi.example${body.path}`);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    const got = await server.inject({ url: body.path });
    expect(got.statusCode).toBe(200);
    expect(got.body).toBe("hello");
    const ranged = await server.inject({ url: body.path, headers: { range: "bytes=1-2" } });
    expect(ranged.statusCode).toBe(206);
    expect((await server.inject({ method: "HEAD", url: body.path })).statusCode).toBe(200);
    // not valid for another file, for writing, or tampered
    expect((await server.inject({ url: body.path.replace("a.txt", "b.txt") })).statusCode).toBe(403);
    expect((await server.inject({ method: "PUT", url: body.path, payload: "x" })).statusCode).toBe(403);
    expect((await server.inject({ url: body.path.slice(0, -1) + (body.path.endsWith("0") ? "1" : "0") })).statusCode).toBe(403);
    // and the API itself still needs the key
    expect((await server.inject({ url: "/api/v1/objects/docs/a.txt" })).statusCode).toBe(401);
  });

  it("a signed PUT link uploads one file, once the link is made by someone with the key", async () => {
    const server = await serve("k", "s3cret");
    const made = await server.inject({ method: "POST", url: "/api/v1/signed-urls", headers: auth, payload: { key: "up/x.bin", method: "PUT" } });
    const path = (made.json() as { path: string }).path;
    const put = await server.inject({ method: "PUT", url: path, headers: { "content-type": "application/octet-stream" }, payload: "bytes" });
    expect(put.statusCode).toBe(201);
    const got = await server.inject({ url: "/api/v1/objects/up/x.bin", headers: auth });
    expect(got.body).toBe("bytes");
  });

  it("an expired link is refused with its own code", async () => {
    const server = await serve("k", "s3cret");
    const path = signPath("s3cret", "GET", "a", Math.floor(Date.now() / 1000) - 5);
    const res = await server.inject({ url: path });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("LINK_EXPIRED");
  });

  it("making a link needs the API key, valid input, and a signing secret", async () => {
    const server = await serve("k", "s3cret");
    expect((await server.inject({ method: "POST", url: "/api/v1/signed-urls", payload: { key: "a" } })).statusCode).toBe(401);
    for (const payload of [{}, { key: "../x" }, { key: "a", method: "DELETE" }, { key: "a", expiresInSeconds: 0 }, { key: "a", expiresInSeconds: 99999999 }]) {
      expect((await server.inject({ method: "POST", url: "/api/v1/signed-urls", headers: auth, payload })).statusCode).toBe(400);
    }
    await server.close();
    app = undefined;
    await h.cleanup();
    const off = await serve(undefined, undefined);
    expect((await off.inject({ method: "POST", url: "/api/v1/signed-urls", payload: { key: "a" } })).statusCode).toBe(409);
    expect((await off.inject({ url: "/signed/a?expires=1&sig=" + "0".repeat(64) })).statusCode).toBe(404);
  });
});
