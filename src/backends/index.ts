import type { StorageBackend } from "../backend.js";
import type { BackendSettings } from "../config.js";
import { LocalBackend } from "./local.js";
import { createS3Client, S3Backend } from "./s3.js";

export { LocalBackend } from "./local.js";
export { S3Backend } from "./s3.js";

export function createBackend(settings: BackendSettings): StorageBackend {
  if (settings.kind === "s3") {
    return new S3Backend(createS3Client(settings.s3), settings.s3.bucket, settings.s3.endpoint);
  }
  return new LocalBackend(settings.dir);
}
