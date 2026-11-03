import type { Readable } from "node:stream";
import type {
  ByteRange,
  GetResult,
  ListResult,
  ObjectInfo,
  PutRequest,
  StorageBackend
} from "../backend.js";

/**
 * Puts every key under a fixed prefix in the backend (for example "pi/") and hides it from the
 * callers: they send and receive keys without the prefix. It marks everything that comes from the
 * Pi ecosystem when the bucket is shared with other things.
 */
export class PrefixedBackend implements StorageBackend {
  constructor(
    private readonly inner: StorageBackend,
    readonly prefix: string
  ) {}

  get kind(): "s3" | "local" {
    return this.inner.kind;
  }
  get location(): string {
    return `${this.inner.location} (key prefix ${this.prefix})`;
  }

  private to(key: string): string {
    return `${this.prefix}${key}`;
  }
  private strip<T extends { key: string }>(item: T): T {
    return { ...item, key: item.key.startsWith(this.prefix) ? item.key.slice(this.prefix.length) : item.key };
  }

  async put(key: string, body: Readable, request: PutRequest): Promise<ObjectInfo> {
    return this.strip(await this.inner.put(this.to(key), body, request));
  }
  async get(key: string, range?: ByteRange): Promise<GetResult | null> {
    const got = await this.inner.get(this.to(key), range);
    return got ? { ...got, info: this.strip(got.info) } : null;
  }
  async head(key: string): Promise<ObjectInfo | null> {
    const info = await this.inner.head(this.to(key));
    return info ? this.strip(info) : null;
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(this.to(key));
  }
  async list(prefix: string, limit?: number): Promise<ListResult> {
    const listing = await this.inner.list(this.to(prefix), limit);
    return { ...listing, items: listing.items.map((item) => this.strip(item)) };
  }
  ping(): Promise<boolean> {
    return this.inner.ping();
  }
  close(): void {
    this.inner.close?.();
  }
}

/** "pi" and "pi/" both mean "pi/"; "none" (or "-") means no prefix; anything else is checked like a key. */
export function normalizeKeyPrefix(raw: string): string {
  const value = raw.trim();
  if (value === "none" || value === "-") return "";
  const prefix = value.endsWith("/") ? value : `${value}/`;
  if (prefix.startsWith("/") || prefix.includes("..") || prefix.includes("\\") || /[\u0000-\u001f\u007f]/.test(prefix) || prefix.includes("//")) {
    throw new Error("PISTORAGE_KEY_PREFIX must be a plain path such as pi/ (or none)");
  }
  return prefix;
}
