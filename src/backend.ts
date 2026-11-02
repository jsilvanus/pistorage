import type { Readable } from "node:stream";

/** Metadata of one stored object. `expiresAt` (ISO 8601) is set only for retention objects. */
export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: string;
  expiresAt?: string | undefined;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

export interface ListResult {
  items: ListedObject[];
  truncated: boolean;
}

/** Inclusive byte range, both ends resolved against the object size. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface PutRequest {
  size: number;
  contentType: string;
  expiresAt?: string | undefined;
}

export interface GetResult {
  /** Metadata of the whole object (size is the full size even for a range). */
  info: ObjectInfo;
  /** Only the requested range when `range` is set. */
  body: Readable;
  range?: ByteRange | undefined;
}

/**
 * What the storage layer needs from a durable store. Implementations: S3 (any S3-compatible
 * service) and local disk (development and tests). Connectivity problems must be reported as
 * BackendUnavailableError; a missing object is `null`, not an error.
 */
export interface StorageBackend {
  readonly kind: "s3" | "local";
  /** Human-readable location without credentials, for status output. */
  readonly location: string;
  put(key: string, body: Readable, request: PutRequest): Promise<ObjectInfo>;
  get(key: string, range?: ByteRange): Promise<GetResult | null>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, limit?: number): Promise<ListResult>;
  /** True when the store answers right now. Never throws. */
  ping(): Promise<boolean>;
  close?(): void;
}
