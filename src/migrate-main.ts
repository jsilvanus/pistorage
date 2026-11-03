#!/usr/bin/env node
import { backendFromEnv, migrate } from "./migrate.js";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`pistorage-migrate: copy all objects from one backend to another (setup-time script).

Usage: MIGRATE_FROM_... MIGRATE_TO_... pistorage-migrate [--dry-run] [--overwrite]

Each side takes MIGRATE_FROM_ / MIGRATE_TO_ plus one of:
  LOCAL_DIR=/path                      local-disk backend
  S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, [S3_REGION], [S3_FORCE_PATH_STYLE]
and optionally KEY_PREFIX (default pi/, "none" for no prefix).

The source is only read. Objects already in the destination with the same size are skipped.
Stop pistorage (or at least stop uploads) while it runs, then point pistorage at the new backend.`);
  process.exit(0);
}

const source = backendFromEnv(process.env, "MIGRATE_FROM");
const destination = backendFromEnv(process.env, "MIGRATE_TO");
const dryRun = args.has("--dry-run");

console.log(`from ${source.location}\nto   ${destination.location}${dryRun ? "\n(dry run, nothing is written)" : ""}`);
const report = await migrate(source, destination, {
  dryRun,
  overwrite: args.has("--overwrite"),
  onProgress: (event) => console.log(`${event.action.padEnd(10)} ${event.key} (${event.size} bytes)${event.error ? ` - ${event.error}` : ""}`)
});
source.close?.();
destination.close?.();
console.log(`\n${report.total} objects: ${report.copied} ${dryRun ? "to copy" : "copied"}, ${report.skipped} skipped, ${report.failed} failed, ${report.bytes} bytes`);
process.exitCode = report.failed > 0 ? 1 : 0;
