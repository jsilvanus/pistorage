import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "../src/backends/local.js";
import { backendFromEnv, migrate } from "../src/migrate.js";

const dirs: string[] = [];
async function local(): Promise<LocalBackend> {
  const dir = await mkdtemp(join(tmpdir(), "pistorage-migrate-"));
  dirs.push(dir);
  return new LocalBackend(dir);
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function text(backend: LocalBackend, key: string): Promise<string> {
  const got = await backend.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of got!.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

describe("migrate", () => {
  it("copies objects with content type, expiry and useAt, and leaves the source alone", async () => {
    const from = await local();
    const to = await local();
    await from.put("a/one.txt", Readable.from(["hello"]), { size: 5, contentType: "text/plain", useAt: ["2026-11-08", "2026-11-09/2026-11-10"] });
    await from.put("two.bin", Readable.from(["xy"]), { size: 2, contentType: "application/octet-stream", expiresAt: "2027-01-01T00:00:00.000Z" });

    const report = await migrate(from, to);
    expect(report).toMatchObject({ total: 2, copied: 2, skipped: 0, failed: 0, bytes: 7 });
    expect(await text(to, "a/one.txt")).toBe("hello");
    expect(await to.head("a/one.txt")).toMatchObject({ contentType: "text/plain", useAt: ["2026-11-08", "2026-11-09/2026-11-10"] });
    expect(await to.head("two.bin")).toMatchObject({ expiresAt: "2027-01-01T00:00:00.000Z" });
    expect((await from.list("")).items).toHaveLength(2);
  });

  it("skips what the destination already has, so a run can be repeated", async () => {
    const from = await local();
    const to = await local();
    await from.put("k", Readable.from(["abc"]), { size: 3, contentType: "text/plain" });
    await migrate(from, to);
    const again = await migrate(from, to);
    expect(again).toMatchObject({ copied: 0, skipped: 1, failed: 0 });
    const forced = await migrate(from, to, { overwrite: true });
    expect(forced.copied).toBe(1);
  });

  it("writes nothing on a dry run", async () => {
    const from = await local();
    const to = await local();
    await from.put("k", Readable.from(["abc"]), { size: 3, contentType: "text/plain" });
    const report = await migrate(from, to, { dryRun: true });
    expect(report).toMatchObject({ total: 1, copied: 1, bytes: 3 });
    expect(await to.head("k")).toBeNull();
  });

  it("reports a failing object and carries on with the rest", async () => {
    const from = await local();
    const to = await local();
    await from.put("a", Readable.from(["1"]), { size: 1, contentType: "text/plain" });
    await from.put("b", Readable.from(["2"]), { size: 1, contentType: "text/plain" });
    const realPut = to.put.bind(to);
    to.put = async (key, body, request) => {
      if (key === "a") throw new Error("disk full");
      return realPut(key, body, request);
    };
    const report = await migrate(from, to);
    expect(report).toMatchObject({ copied: 1, failed: 1 });
    expect(report.failures).toEqual([{ key: "a", error: "disk full" }]);
  });
});

describe("backendFromEnv", () => {
  it("builds a prefixed local backend and rejects missing or mixed settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pistorage-migrate-env-"));
    dirs.push(dir);
    const backend = backendFromEnv({ MIGRATE_FROM_LOCAL_DIR: dir }, "MIGRATE_FROM");
    expect(backend.location).toContain("key prefix pi/");
    expect(() => backendFromEnv({}, "MIGRATE_TO")).toThrow(/MIGRATE_TO_LOCAL_DIR/);
    expect(() => backendFromEnv({ MIGRATE_TO_LOCAL_DIR: dir, MIGRATE_TO_S3_ENDPOINT: "http://x" }, "MIGRATE_TO")).toThrow(/only one/);
    expect(() => backendFromEnv({ MIGRATE_TO_S3_ENDPOINT: "http://x" }, "MIGRATE_TO")).toThrow(/both/);
  });
});
