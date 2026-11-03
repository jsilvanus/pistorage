import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { BackendUnavailableError, StorageError } from "../errors.js";
import type { ByteRange, GetResult, ListedObject, ListResult, ObjectInfo, PutRequest, StorageBackend } from "../backend.js";
import type { S3Settings } from "../config.js";

/** User-metadata name that carries the retention deadline (sent as x-amz-meta-expires-at). */
export const EXPIRES_METADATA = "expires-at";
/** User-metadata name that carries the useAt entries, joined with ", " (x-amz-meta-use-at). */
export const USE_AT_METADATA = "use-at";

const PING_TIMEOUT_MS = 3000;

/** Builds the S3 client. Checksums are only sent when required, because several S3-compatible stores reject the default streaming checksums. */
export function createS3Client(settings: S3Settings): S3Client {
  return new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials:
      settings.accessKeyId && settings.secretAccessKey
        ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }
        : undefined,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3
  });
}

interface AwsError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

function isNotFound(error: unknown): boolean {
  const aws = error as AwsError;
  return aws?.name === "NoSuchKey" || aws?.name === "NotFound" || aws?.$metadata?.httpStatusCode === 404;
}

/** Network failures and 5xx answers mean "unreachable"; other refusals are reported as a backend error. */
function toStorageError(error: unknown, action: string): Error {
  if (error instanceof StorageError) return error;
  const aws = error as AwsError;
  const status = aws?.$metadata?.httpStatusCode;
  const name = aws?.name ?? "error";
  if (status === undefined || status >= 500) {
    return new BackendUnavailableError(`${action}: the object store is unreachable (${name})`);
  }
  return new StorageError(502, "BACKEND_ERROR", `${action}: the object store refused the request (${name}, HTTP ${status})`);
}

function totalFromContentRange(contentRange: string | undefined): number | undefined {
  const match = /\/(\d+)$/.exec(contentRange ?? "");
  return match ? Number(match[1]) : undefined;
}

/** S3 or any S3-compatible service (VersityGW, Hetzner Object Storage). */
export class S3Backend implements StorageBackend {
  readonly kind = "s3" as const;
  readonly location: string;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    endpoint: string
  ) {
    this.location = `${endpoint} bucket=${bucket}`;
  }

  async put(key: string, body: Readable, request: PutRequest): Promise<ObjectInfo> {
    const out = await this.run<{ ETag?: string }>(
      "put",
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: request.size,
        ContentType: request.contentType,
        Metadata:
          request.expiresAt || request.useAt?.length
            ? {
                ...(request.expiresAt ? { [EXPIRES_METADATA]: request.expiresAt } : {}),
                ...(request.useAt?.length ? { [USE_AT_METADATA]: request.useAt.join(", ") } : {})
              }
            : undefined
      })
    );
    return {
      key,
      size: request.size,
      contentType: request.contentType,
      etag: (out?.ETag ?? "").replace(/"/g, ""),
      lastModified: new Date().toISOString(),
      expiresAt: request.expiresAt,
      ...(request.useAt?.length ? { useAt: request.useAt } : {})
    };
  }

  async get(key: string, range?: ByteRange): Promise<GetResult | null> {
    const out = await this.run<{
      Body?: unknown;
      ContentLength?: number;
      ContentRange?: string;
      ContentType?: string;
      ETag?: string;
      LastModified?: Date;
      Metadata?: Record<string, string>;
    }>(
      "get",
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined
      }),
      true
    );
    if (!out) return null;
    if (!out.Body) throw new StorageError(502, "BACKEND_ERROR", `get: empty body for ${key}`);
    const size = range ? (totalFromContentRange(out.ContentRange) ?? out.ContentLength ?? 0) : (out.ContentLength ?? 0);
    return {
      info: this.toInfo(key, size, out),
      body: out.Body as Readable,
      range
    };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const out = await this.run<{
      ContentLength?: number;
      ContentType?: string;
      ETag?: string;
      LastModified?: Date;
      Metadata?: Record<string, string>;
    }>("head", new HeadObjectCommand({ Bucket: this.bucket, Key: key }), true);
    if (!out) return null;
    return this.toInfo(key, out.ContentLength ?? 0, out);
  }

  async delete(key: string): Promise<void> {
    await this.run("delete", new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string, limit?: number): Promise<ListResult> {
    const items: ListedObject[] = [];
    let token: string | undefined;
    let truncated = false;
    do {
      const remaining = limit === undefined ? 1000 : limit - items.length;
      const out = await this.run<{
        Contents?: { Key?: string; Size?: number; ETag?: string; LastModified?: Date }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      }>(
        "list",
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1000, remaining),
          ContinuationToken: token
        })
      );
      for (const item of out?.Contents ?? []) {
        if (item.Key === undefined) continue;
        if (limit !== undefined && items.length >= limit) {
          truncated = true;
          break;
        }
        items.push({
          key: item.Key,
          size: item.Size ?? 0,
          etag: (item.ETag ?? "").replace(/"/g, ""),
          lastModified: item.LastModified?.toISOString() ?? ""
        });
      }
      token = out?.IsTruncated ? out.NextContinuationToken : undefined;
      if (token && limit !== undefined && items.length >= limit) truncated = true;
    } while (token && (limit === undefined || items.length < limit));
    return { items, truncated };
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS)
      });
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.client.destroy();
  }

  private toInfo(
    key: string,
    size: number,
    out: { ContentType?: string; ETag?: string; LastModified?: Date; Metadata?: Record<string, string> }
  ): ObjectInfo {
    return {
      key,
      size,
      contentType: out.ContentType ?? "application/octet-stream",
      etag: (out.ETag ?? "").replace(/"/g, ""),
      lastModified: out.LastModified?.toISOString() ?? new Date(0).toISOString(),
      expiresAt: out.Metadata?.[EXPIRES_METADATA],
      ...(out.Metadata?.[USE_AT_METADATA] ? { useAt: out.Metadata[USE_AT_METADATA]!.split(",").map((e) => e.trim()).filter(Boolean) } : {})
    };
  }

  /** Sends one command. Returns null for a missing object when `allowNotFound` is set. */
  private async run<T = void>(action: string, command: object, allowNotFound = false): Promise<T | null> {
    try {
      return (await this.client.send(command as never)) as T;
    } catch (error) {
      if (allowNotFound && isNotFound(error)) return null;
      throw toStorageError(error, action);
    }
  }
}
