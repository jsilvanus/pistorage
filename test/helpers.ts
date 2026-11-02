import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ByteRange, GetResult, ListResult, ObjectInfo, PutRequest, StorageBackend } from "../src/backend.js";
import { DiskCache } from "../src/cache.js";
import { BackendUnavailableError } from "../src/errors.js";
import { LocalBackend } from "../src/backends/local.js";
import { buildServer } from "../src/server.js";
import { PiStorage } from "../src/storage.js";

/**
 * Wraps a real backend and can be switched offline. While offline every call throws
 * BackendUnavailableError, as an unreachable S3 endpoint would. `calls` records every call
 * that reached the wrapper, so tests can assert that the cache did not ask the backend.
 */
export class FakeBackend implements StorageBackend {
  readonly kind: "s3" | "local";
  readonly location: string;
  offline = false;
  calls: string[] = [];

  constructor(readonly inner: StorageBackend) {
    this.kind = inner.kind;
    this.location = `fake(${inner.location})`;
  }

  private gate(name: string): void {
    this.calls.push(name);
    if (this.offline) throw new BackendUnavailableError("fake backend is offline");
  }

  put(key: string, body: Readable, request: PutRequest): Promise<ObjectInfo> {
    this.gate("put");
    return this.inner.put(key, body, request);
  }

  get(key: string, range?: ByteRange): Promise<GetResult | null> {
    this.gate("get");
    return this.inner.get(key, range);
  }

  head(key: string): Promise<ObjectInfo | null> {
    this.gate("head");
    return this.inner.head(key);
  }

  delete(key: string): Promise<void> {
    this.gate("delete");
    return this.inner.delete(key);
  }

  list(prefix: string, limit?: number): Promise<ListResult> {
    this.gate("list");
    return this.inner.list(prefix, limit);
  }

  async ping(): Promise<boolean> {
    this.calls.push("ping");
    if (this.offline) return false;
    return this.inner.ping();
  }
}

export interface Harness {
  dir: string;
  backend: FakeBackend;
  cache: DiskCache;
  storage: PiStorage;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

export const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
export const DAY_MS = 24 * 3600 * 1000;

/** A storage stack on a temporary directory with a controllable clock. */
export async function makeHarness(
  options: { ttlMs?: number; maxBytes?: number; maxUploadBytes?: number; retentionSweepEnabled?: boolean } = {}
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pistorage-test-"));
  const clock = { now: T0 };
  const now = () => clock.now;
  const backend = new FakeBackend(new LocalBackend(join(dir, "store")));
  const cache = await DiskCache.open({
    dir: join(dir, "cache"),
    ttlMs: options.ttlMs ?? 14 * DAY_MS,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    now
  });
  const storage = new PiStorage({
    backend,
    cache,
    maxUploadBytes: options.maxUploadBytes ?? 1024 * 1024,
    retentionSweepEnabled: options.retentionSweepEnabled ?? false,
    now
  });
  return {
    dir,
    backend,
    cache,
    storage,
    clock,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

export function appFor(storage: PiStorage, apiKey?: string) {
  return buildServer({ storage, apiKey });
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** A Readable that emits the given bytes in one chunk. */
export function streamOf(bytes: Buffer | string): Readable {
  return Readable.from([Buffer.from(bytes)]);
}
