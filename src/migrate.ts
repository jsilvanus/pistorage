import type { StorageBackend } from "./backend.js";
import { createBackend } from "./backends/index.js";
import { PrefixedBackend } from "./backends/prefixed.js";
import { loadConfig } from "./config.js";

export interface MigrateOptions {
  /** Report what would be copied, change nothing. */
  dryRun?: boolean;
  /** Copy again even when the destination already has an object of the same size. */
  overwrite?: boolean;
  /** Called once per object. */
  onProgress?: (event: MigrateEvent) => void;
}

export interface MigrateEvent {
  key: string;
  action: "copied" | "skipped" | "would-copy" | "failed";
  size: number;
  error?: string;
}

export interface MigrateReport {
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  failures: { key: string; error: string }[];
}

/**
 * Copies every object from one backend to another, with its content type, expiry (`expiresAt`)
 * and `useAt`. The source is only read, never changed. An object that the destination already has
 * with the same size is skipped, so the run can be repeated after an interruption. Each copy is
 * checked by reading its size back from the destination.
 */
export async function migrate(source: StorageBackend, destination: StorageBackend, options: MigrateOptions = {}): Promise<MigrateReport> {
  const listing = await source.list("");
  const report: MigrateReport = { total: listing.items.length, copied: 0, skipped: 0, failed: 0, bytes: 0, failures: [] };
  const emit = (event: MigrateEvent) => options.onProgress?.(event);

  for (const item of listing.items) {
    try {
      const existing = await destination.head(item.key);
      if (existing && existing.size === item.size && !options.overwrite) {
        report.skipped += 1;
        emit({ key: item.key, action: "skipped", size: item.size });
        continue;
      }
      if (options.dryRun) {
        report.copied += 1;
        report.bytes += item.size;
        emit({ key: item.key, action: "would-copy", size: item.size });
        continue;
      }
      const got = await source.get(item.key);
      if (!got) throw new Error("object vanished from the source during the run");
      const written = await destination.put(item.key, got.body, {
        size: got.info.size,
        contentType: got.info.contentType,
        expiresAt: got.info.expiresAt,
        useAt: got.info.useAt
      });
      const check = await destination.head(item.key);
      if (!check || check.size !== got.info.size || written.size !== got.info.size) {
        throw new Error(`size mismatch after copy (source ${got.info.size}, destination ${check?.size ?? "missing"})`);
      }
      report.copied += 1;
      report.bytes += got.info.size;
      emit({ key: item.key, action: "copied", size: got.info.size });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed += 1;
      report.failures.push({ key: item.key, error: message });
      emit({ key: item.key, action: "failed", size: item.size, error: message });
    }
  }
  return report;
}

/** Variables of one side: `${side}_LOCAL_DIR`, `${side}_S3_ENDPOINT`, `_S3_BUCKET`, `_S3_ACCESS_KEY`, `_S3_SECRET_KEY`, `_S3_REGION`, `_S3_FORCE_PATH_STYLE`, `_KEY_PREFIX`. */
export function backendFromEnv(env: NodeJS.ProcessEnv, side: "MIGRATE_FROM" | "MIGRATE_TO"): StorageBackend {
  const get = (name: string) => env[`${side}_${name}`]?.trim() || undefined;
  if (!get("LOCAL_DIR") && !get("S3_ENDPOINT")) {
    throw new Error(`${side}: set ${side}_LOCAL_DIR, or ${side}_S3_ENDPOINT with ${side}_S3_BUCKET`);
  }
  if (get("LOCAL_DIR") && get("S3_ENDPOINT")) {
    throw new Error(`${side}: set only one of ${side}_LOCAL_DIR and ${side}_S3_ENDPOINT`);
  }
  const mapped: NodeJS.ProcessEnv = {};
  for (const name of ["LOCAL_DIR", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_REGION", "S3_FORCE_PATH_STYLE", "KEY_PREFIX"]) {
    const value = get(name);
    if (value !== undefined) mapped[`PISTORAGE_${name}`] = value;
  }
  const config = loadConfig(mapped);
  const raw = createBackend(config.backend);
  return config.keyPrefix ? new PrefixedBackend(raw, config.keyPrefix) : raw;
}
