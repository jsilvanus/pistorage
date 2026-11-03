import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "../src/backends/local.js";
import { EXPIRES_METADATA, S3Backend } from "../src/backends/s3.js";
import { BackendUnavailableError, StorageError } from "../src/errors.js";
import { readAll, streamOf } from "./helpers.js";

describe("LocalBackend", () => {
  let dir: string;
  let backend: LocalBackend;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pistorage-local-"));
    backend = new LocalBackend(join(dir, "store"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores, reads, heads and deletes an object", async () => {
    const info = await backend.put("docs/a.txt", streamOf("hello"), { size: 5, contentType: "text/plain" });
    expect(info).toMatchObject({ key: "docs/a.txt", size: 5, contentType: "text/plain" });
    expect(info.etag).toHaveLength(32);

    const got = await backend.get("docs/a.txt");
    expect(got?.info.size).toBe(5);
    expect((await readAll(got!.body)).toString()).toBe("hello");

    expect((await backend.head("docs/a.txt"))?.contentType).toBe("text/plain");
    await backend.delete("docs/a.txt");
    expect(await backend.head("docs/a.txt")).toBeNull();
    expect(await backend.get("docs/a.txt")).toBeNull();
    await expect(backend.delete("docs/a.txt")).resolves.toBeUndefined();
  });

  it("reads a byte range and reports the full size", async () => {
    await backend.put("r", streamOf("0123456789"), { size: 10, contentType: "application/octet-stream" });
    const got = await backend.get("r", { start: 2, end: 4 });
    expect(got?.info.size).toBe(10);
    expect((await readAll(got!.body)).toString()).toBe("234");
  });

  it("keeps the retention deadline and lists by prefix in key order", async () => {
    const expiresAt = "2030-01-01T00:00:00.000Z";
    await backend.put("exports/b", streamOf("b"), { size: 1, contentType: "x/y", expiresAt });
    await backend.put("exports/a", streamOf("a"), { size: 1, contentType: "x/y" });
    await backend.put("other/c", streamOf("c"), { size: 1, contentType: "x/y" });
    expect((await backend.head("exports/b"))?.expiresAt).toBe(expiresAt);

    const listing = await backend.list("exports/");
    expect(listing.items.map((item) => item.key)).toEqual(["exports/a", "exports/b"]);
    expect(listing.truncated).toBe(false);

    const limited = await backend.list("", 2);
    expect(limited.items).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it("answers ping true for a writable directory", async () => {
    expect(await backend.ping()).toBe(true);
  });

  it("stores keys that would be unsafe as file names", async () => {
    const key = "../../weird key/ää?#%.bin";
    await backend.put(key, streamOf("x"), { size: 1, contentType: "x/y" });
    expect((await backend.head(key))?.key).toBe(key);
  });
});

/** A stub S3 client: records commands and answers from a script. */
function stubClient(answer: (command: unknown) => unknown | Promise<unknown>) {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return answer(command);
    },
    destroy: () => undefined
  };
  return { client: client as unknown as S3Client, sent };
}

function awsError(name: string, httpStatusCode?: number): Error & { $metadata?: { httpStatusCode?: number } } {
  const error = new Error(name) as Error & { $metadata?: { httpStatusCode?: number } };
  error.name = name;
  if (httpStatusCode !== undefined) error.$metadata = { httpStatusCode };
  return error;
}

describe("S3Backend (stub client, no network)", () => {
  it("sends the length, type and retention metadata on put", async () => {
    const { client, sent } = stubClient(() => ({ ETag: '"abc"' }));
    const backend = new S3Backend(client, "pi", "http://s3.test");
    const info = await backend.put("k", streamOf("xyz"), {
      size: 3,
      contentType: "image/png",
      expiresAt: "2031-02-03T00:00:00.000Z"
    });
    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "pi",
      Key: "k",
      ContentLength: 3,
      ContentType: "image/png",
      Metadata: { [EXPIRES_METADATA]: "2031-02-03T00:00:00.000Z" }
    });
    expect(info).toMatchObject({ etag: "abc", size: 3, expiresAt: "2031-02-03T00:00:00.000Z" });
  });

  it("asks for a byte range and takes the full size from Content-Range", async () => {
    const { client, sent } = stubClient(() => ({
      Body: Readable.from([Buffer.from("234")]),
      ContentLength: 3,
      ContentRange: "bytes 2-4/10",
      ContentType: "text/plain",
      ETag: '"e"'
    }));
    const backend = new S3Backend(client, "pi", "http://s3.test");
    const got = await backend.get("k", { start: 2, end: 4 });
    expect((sent[0] as GetObjectCommand).input.Range).toBe("bytes=2-4");
    expect(got?.info.size).toBe(10);
    expect((await readAll(got!.body)).toString()).toBe("234");
  });

  it("maps a missing object to null, and connectivity or 5xx errors to 503", async () => {
    const missing = new S3Backend(stubClient(() => Promise.reject(awsError("NoSuchKey", 404))).client, "pi", "x");
    expect(await missing.get("k")).toBeNull();
    expect(await missing.head("k")).toBeNull();

    const network = new S3Backend(stubClient(() => Promise.reject(awsError("TimeoutError"))).client, "pi", "x");
    await expect(network.head("k")).rejects.toBeInstanceOf(BackendUnavailableError);

    const server = new S3Backend(stubClient(() => Promise.reject(awsError("InternalError", 500))).client, "pi", "x");
    await expect(server.delete("k")).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it("maps a refusal (for example a bad signature) to a 502 backend error, not to unavailable", async () => {
    const refused = new S3Backend(stubClient(() => Promise.reject(awsError("SignatureDoesNotMatch", 403))).client, "pi", "x");
    const error = await refused.head("k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).status).toBe(502);
  });

  it("follows continuation tokens and honours the limit when listing", async () => {
    const pages = [
      { Contents: [{ Key: "a", Size: 1 }, { Key: "b", Size: 2 }], IsTruncated: true, NextContinuationToken: "t1" },
      { Contents: [{ Key: "c", Size: 3 }], IsTruncated: false }
    ];
    let page = 0;
    const { client, sent } = stubClient(() => pages[page++]);
    const backend = new S3Backend(client, "pi", "x");
    const all = await backend.list("");
    expect(all.items.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect((sent[1] as ListObjectsV2Command).input.ContinuationToken).toBe("t1");

    page = 0;
    const limited = await backend.list("", 2);
    expect(limited.items).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it("reports ping false when the bucket cannot be reached", async () => {
    const backend = new S3Backend(stubClient(() => Promise.reject(awsError("NetworkingError"))).client, "pi", "x");
    expect(await backend.ping()).toBe(false);
    const ok = new S3Backend(stubClient(() => ({})).client, "pi", "x");
    expect(await ok.ping()).toBe(true);
  });

  it("uses a HeadObject for head", async () => {
    const { client, sent } = stubClient(() => ({ ContentLength: 4, ContentType: "a/b", ETag: '"z"', Metadata: {} }));
    const backend = new S3Backend(client, "pi", "x");
    const info = await backend.head("k");
    expect(sent[0]).toBeInstanceOf(HeadObjectCommand);
    expect(info).toMatchObject({ size: 4, contentType: "a/b", etag: "z", expiresAt: undefined });
  });

  it("changes useAt with a metadata-replacing copy onto itself and keeps type and retention", async () => {
    let call = 0;
    const { client, sent } = stubClient(() =>
      call++ === 0
        ? { ContentLength: 4, ContentType: "a/b", ETag: '"z"', Metadata: { "expires-at": "2027-01-01T00:00:00.000Z", "use-at": "2026-12-24" } }
        : { CopyObjectResult: { ETag: '"y"' } }
    );
    const backend = new S3Backend(client, "bkt", "x");
    const info = await backend.setUseAt("pi/dir/a b.txt", ["2026-11-08", "2026-11-09"]);
    const copy = sent[1] as CopyObjectCommand;
    expect(copy).toBeInstanceOf(CopyObjectCommand);
    expect(copy.input).toMatchObject({
      Bucket: "bkt",
      Key: "pi/dir/a b.txt",
      CopySource: "bkt/pi/dir/a%20b.txt",
      MetadataDirective: "REPLACE",
      ContentType: "a/b",
      Metadata: { "expires-at": "2027-01-01T00:00:00.000Z", "use-at": "2026-11-08, 2026-11-09" }
    });
    expect(info).toMatchObject({ etag: "y", useAt: ["2026-11-08", "2026-11-09"], expiresAt: "2027-01-01T00:00:00.000Z" });

    call = 0;
    const cleared = stubClient(() => (call++ === 0 ? { ContentLength: 4, ContentType: "a/b", ETag: '"z"', Metadata: { "use-at": "2026-12-24" } } : {}));
    const b2 = new S3Backend(cleared.client, "bkt", "x");
    expect((await b2.setUseAt("k", []))?.useAt).toBeUndefined();
    expect((cleared.sent[1] as CopyObjectCommand).input.Metadata).toEqual({});
  });

  it("answers null from setUseAt when the object is missing", async () => {
    const backend = new S3Backend(stubClient(() => Promise.reject(awsError("NotFound", 404))).client, "bkt", "x");
    expect(await backend.setUseAt("k", ["2026-11-08"])).toBeNull();
  });
});
