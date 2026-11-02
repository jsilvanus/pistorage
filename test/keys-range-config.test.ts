import { describe, expect, it } from "vitest";
import { assertKey, keyProblem, prefixProblem } from "../src/keys.js";
import { resolveRange } from "../src/range.js";
import { loadConfig } from "../src/config.js";
import { RangeNotSatisfiableError, StorageError } from "../src/errors.js";

describe("key validation", () => {
  it.each(["a", "exports/canva/slide-1.png", "kirkko/ääkkö.pdf", "x".repeat(512)])("accepts %s", (key) => {
    expect(keyProblem(key)).toBeUndefined();
    expect(assertKey(key)).toBe(key);
  });

  it.each([
    ["", "empty"],
    ["/a", "leading slash"],
    ["a/../b", "dot-dot"],
    ["a..b", "dot-dot inside a segment"],
    ["a\\b", "backslash"],
    ["a//b", "empty segment"],
    ["a/", "trailing slash"],
    ["a/./b", "dot segment"],
    ["a\nb", "control character"],
    ["x".repeat(513), "too long"]
  ])("rejects %s (%s)", (key) => {
    expect(keyProblem(key)).toBeDefined();
    expect(() => assertKey(key)).toThrow(StorageError);
  });

  it("gives a 400 INVALID_KEY error", () => {
    try {
      assertKey("../etc");
      expect.unreachable();
    } catch (error) {
      expect((error as StorageError).status).toBe(400);
      expect((error as StorageError).code).toBe("INVALID_KEY");
    }
  });

  it("validates list prefixes, which may end with a slash and may be empty", () => {
    expect(prefixProblem("")).toBeUndefined();
    expect(prefixProblem("exports/")).toBeUndefined();
    expect(prefixProblem("/exports")).toBeDefined();
    expect(prefixProblem("a/../b")).toBeDefined();
  });
});

describe("range resolution", () => {
  const size = 1000;

  it("returns undefined without a header", () => {
    expect(resolveRange(undefined, size)).toBeUndefined();
  });

  it("resolves explicit, open-ended and suffix ranges", () => {
    expect(resolveRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
    expect(resolveRange("bytes=900-", size)).toEqual({ start: 900, end: 999 });
    expect(resolveRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
    expect(resolveRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("clips an end past the object", () => {
    expect(resolveRange("bytes=0-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("rejects ranges outside the object with 416", () => {
    expect(() => resolveRange("bytes=1000-", size)).toThrow(RangeNotSatisfiableError);
    expect(() => resolveRange("bytes=-0", size)).toThrow(RangeNotSatisfiableError);
    expect(() => resolveRange("bytes=0-0", 0)).toThrow(RangeNotSatisfiableError);
  });

  it("ignores malformed headers, several ranges and other units (serves the whole object)", () => {
    expect(resolveRange("bytes=5-2", size)).toBeUndefined();
    expect(resolveRange("bytes=0-1,4-5", size)).toBeUndefined();
    expect(resolveRange("items=0-1", size)).toBeUndefined();
    expect(resolveRange("bytes=-", size)).toBeUndefined();
  });
});

describe("configuration", () => {
  const cwd = "/srv/pistorage";

  it("uses local disk with defaults when no S3 variables are set", () => {
    const config = loadConfig({}, cwd);
    expect(config.backend).toEqual({ kind: "local", dir: "/srv/pistorage/data/store" });
    expect(config.port).toBe(3700);
    expect(config.host).toBe("127.0.0.1");
    expect(config.maxUploadBytes).toBe(500 * 1024 * 1024);
    expect(config.cache.dir).toBe("/srv/pistorage/data/cache");
    expect(config.cache.ttlSeconds).toBe(14 * 24 * 3600);
    expect(config.cache.maxBytes).toBe(5 * 1024 ** 3);
    expect(config.retention.sweepEnabled).toBe(false);
  });

  it("uses S3 when endpoint and bucket are both set, with path-style addressing by default", () => {
    const config = loadConfig(
      {
        PISTORAGE_S3_ENDPOINT: "http://10.0.0.5:7070",
        PISTORAGE_S3_BUCKET: "pi",
        PISTORAGE_S3_ACCESS_KEY: "k",
        PISTORAGE_S3_SECRET_KEY: "s"
      },
      cwd
    );
    expect(config.backend).toEqual({
      kind: "s3",
      s3: {
        endpoint: "http://10.0.0.5:7070",
        bucket: "pi",
        region: "us-east-1",
        accessKeyId: "k",
        secretAccessKey: "s",
        forcePathStyle: true
      }
    });
  });

  it("allows virtual-hosted addressing when asked", () => {
    const config = loadConfig({
      PISTORAGE_S3_ENDPOINT: "https://fsn1.example",
      PISTORAGE_S3_BUCKET: "pi",
      PISTORAGE_S3_FORCE_PATH_STYLE: "0"
    });
    expect(config.backend.kind === "s3" && config.backend.s3.forcePathStyle).toBe(false);
  });

  it("refuses a half-set S3 configuration instead of writing to local disk", () => {
    expect(() => loadConfig({ PISTORAGE_S3_ENDPOINT: "http://x" })).toThrow(/both/);
    expect(() => loadConfig({ PISTORAGE_S3_BUCKET: "b" })).toThrow(/both/);
    expect(() =>
      loadConfig({ PISTORAGE_S3_ENDPOINT: "http://x", PISTORAGE_S3_BUCKET: "b", PISTORAGE_S3_ACCESS_KEY: "k" })
    ).toThrow(/SECRET_KEY/);
  });

  it("requires an API key on a non-loopback host", () => {
    expect(() => loadConfig({ PISTORAGE_HOST: "0.0.0.0" })).toThrow(/PISTORAGE_API_KEY/);
    expect(loadConfig({ PISTORAGE_HOST: "0.0.0.0", PISTORAGE_API_KEY: "secret" }).apiKey).toBe("secret");
  });

  it("rejects malformed numbers and booleans", () => {
    expect(() => loadConfig({ PISTORAGE_PORT: "abc" })).toThrow(/PISTORAGE_PORT/);
    expect(() => loadConfig({ PISTORAGE_CACHE_TTL_SECONDS: "-1" })).toThrow(/PISTORAGE_CACHE_TTL_SECONDS/);
    expect(() => loadConfig({ PISTORAGE_RETENTION_SWEEP: "yes" })).toThrow(/PISTORAGE_RETENTION_SWEEP/);
    expect(loadConfig({ PISTORAGE_RETENTION_SWEEP: "1" }).retention.sweepEnabled).toBe(true);
  });
});
