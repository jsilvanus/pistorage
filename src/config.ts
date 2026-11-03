import { join } from "node:path";
import { normalizeKeyPrefix } from "./backends/prefixed.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface S3Settings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle: boolean;
}

export type BackendSettings = { kind: "s3"; s3: S3Settings } | { kind: "local"; dir: string };

export interface PiStorageConfig {
  port: number;
  host: string;
  apiKey?: string | undefined;
  maxUploadBytes: number;
  backend: BackendSettings;
  /** Prefix put on every key in the backend (default "pi/"); "" = none. */
  keyPrefix: string;
  /** Secret for signed URLs; undefined = signed URLs are off. Defaults to the API key. */
  signingSecret?: string | undefined;
  /** Public base URL of this service, used to return full signed URLs. */
  publicUrl?: string | undefined;
  /** Where writes wait while the backend is down; undefined = off (writes then fail with 503). */
  spool?: { dir: string; maxBytes: number; flushSeconds: number } | undefined;
  cache: {
    dir: string;
    ttlSeconds: number;
    maxBytes: number;
    sweepSeconds: number;
  };
  retention: {
    sweepEnabled: boolean;
    sweepSeconds: number;
  };
}

function intSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function boolSetting(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be 1, 0, true or false`);
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

/**
 * Reads the configuration from PISTORAGE_* variables. S3 is used when both
 * PISTORAGE_S3_ENDPOINT and PISTORAGE_S3_BUCKET are set; setting only one of them is an error,
 * so that a typo cannot silently send data to local disk. Otherwise local disk is used.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PiStorageConfig {
  const host = optional(env, "PISTORAGE_HOST") ?? "127.0.0.1";
  const apiKey = optional(env, "PISTORAGE_API_KEY");
  if (!apiKey && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("PISTORAGE_API_KEY is required when PISTORAGE_HOST is not a loopback address");
  }

  const endpoint = optional(env, "PISTORAGE_S3_ENDPOINT");
  const bucket = optional(env, "PISTORAGE_S3_BUCKET");
  if (Boolean(endpoint) !== Boolean(bucket)) {
    throw new Error("set both PISTORAGE_S3_ENDPOINT and PISTORAGE_S3_BUCKET, or neither");
  }

  let backend: BackendSettings;
  if (endpoint && bucket) {
    const accessKeyId = optional(env, "PISTORAGE_S3_ACCESS_KEY");
    const secretAccessKey = optional(env, "PISTORAGE_S3_SECRET_KEY");
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw new Error("set both PISTORAGE_S3_ACCESS_KEY and PISTORAGE_S3_SECRET_KEY, or neither (the AWS default chain is used then)");
    }
    backend = {
      kind: "s3",
      s3: {
        endpoint,
        bucket,
        region: optional(env, "PISTORAGE_S3_REGION") ?? "us-east-1",
        accessKeyId,
        secretAccessKey,
        forcePathStyle: boolSetting(env, "PISTORAGE_S3_FORCE_PATH_STYLE", true)
      }
    };
  } else {
    backend = { kind: "local", dir: optional(env, "PISTORAGE_LOCAL_DIR") ?? join(cwd, "data", "store") };
  }

  return {
    port: intSetting(env, "PISTORAGE_PORT", 3700, 1, 65535),
    host,
    apiKey,
    maxUploadBytes: intSetting(env, "PISTORAGE_MAX_BYTES", 500 * MB, 1, 64 * GB),
    backend,
    keyPrefix: normalizeKeyPrefix(optional(env, "PISTORAGE_KEY_PREFIX") ?? "pi/"),
    signingSecret: optional(env, "PISTORAGE_SIGNING_SECRET") ?? apiKey,
    publicUrl: optional(env, "PISTORAGE_PUBLIC_URL")?.replace(/\/+$/, ""),
    spool: boolSetting(env, "PISTORAGE_SPOOL", true)
      ? {
          dir: optional(env, "PISTORAGE_SPOOL_DIR") ?? join(cwd, "data", "spool"),
          maxBytes: intSetting(env, "PISTORAGE_SPOOL_MAX_BYTES", 2 * GB, 1, 64 * 1024 * GB),
          flushSeconds: intSetting(env, "PISTORAGE_SPOOL_FLUSH_SECONDS", 30, 1, 86400)
        }
      : undefined,
    cache: {
      dir: optional(env, "PISTORAGE_CACHE_DIR") ?? join(cwd, "data", "cache"),
      ttlSeconds: intSetting(env, "PISTORAGE_CACHE_TTL_SECONDS", 14 * 24 * 3600, 1, 10 * 365 * 24 * 3600),
      maxBytes: intSetting(env, "PISTORAGE_CACHE_MAX_BYTES", 5 * GB, 1, 64 * 1024 * GB),
      sweepSeconds: intSetting(env, "PISTORAGE_CACHE_SWEEP_SECONDS", 600, 1, 86400)
    },
    retention: {
      sweepEnabled: boolSetting(env, "PISTORAGE_RETENTION_SWEEP", false),
      sweepSeconds: intSetting(env, "PISTORAGE_RETENTION_SWEEP_SECONDS", 3600, 60, 7 * 86400)
    }
  };
}
