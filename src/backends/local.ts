import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { constants } from "node:fs";
import type { ByteRange, GetResult, ListedObject, ListResult, ObjectInfo, PutRequest, StorageBackend } from "../backend.js";

/** File name stem for a key: a hash, so any key fits in a file name. */
export function objectStem(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Stores each object as `<stem>.bin` plus a `<stem>.json` metadata file in `<dir>/objects/`.
 * Writes go to a temporary file first and are renamed into place. Meant for development and tests.
 */
export class LocalBackend implements StorageBackend {
  readonly kind = "local" as const;
  readonly location: string;
  private readonly objectsDir: string;

  constructor(dir: string) {
    this.location = dir;
    this.objectsDir = join(dir, "objects");
  }

  async put(key: string, body: Readable, request: PutRequest): Promise<ObjectInfo> {
    await mkdir(this.objectsDir, { recursive: true });
    const digest = createHash("sha256");
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      }
    });
    const tmp = join(this.objectsDir, `${randomUUID()}.tmp`);
    try {
      await pipeline(body, tap, createWriteStream(tmp));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    const stem = join(this.objectsDir, objectStem(key));
    await rename(tmp, `${stem}.bin`);
    const info: ObjectInfo = {
      key,
      size,
      contentType: request.contentType,
      etag: digest.digest("hex").slice(0, 32),
      lastModified: new Date().toISOString(),
      expiresAt: request.expiresAt
    };
    await this.writeMeta(stem, info);
    return info;
  }

  async get(key: string, range?: ByteRange): Promise<GetResult | null> {
    const stem = join(this.objectsDir, objectStem(key));
    const info = await this.readMeta(stem);
    if (!info) return null;
    try {
      await stat(`${stem}.bin`);
    } catch {
      return null;
    }
    const body = createReadStream(`${stem}.bin`, range ? { start: range.start, end: range.end } : undefined);
    return { info, body, range };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    return this.readMeta(join(this.objectsDir, objectStem(key)));
  }

  async delete(key: string): Promise<void> {
    const stem = join(this.objectsDir, objectStem(key));
    await rm(`${stem}.json`, { force: true });
    await rm(`${stem}.bin`, { force: true });
  }

  async list(prefix: string, limit?: number): Promise<ListResult> {
    let names: string[];
    try {
      names = await readdir(this.objectsDir);
    } catch {
      return { items: [], truncated: false };
    }
    const items: ListedObject[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const info = await this.readMeta(join(this.objectsDir, name.slice(0, -".json".length)));
      if (!info || !info.key.startsWith(prefix)) continue;
      items.push({ key: info.key, size: info.size, etag: info.etag, lastModified: info.lastModified });
    }
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (limit !== undefined && items.length > limit) {
      return { items: items.slice(0, limit), truncated: true };
    }
    return { items, truncated: false };
  }

  async ping(): Promise<boolean> {
    try {
      await mkdir(this.objectsDir, { recursive: true });
      await access(this.location, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async readMeta(stem: string): Promise<ObjectInfo | null> {
    try {
      return JSON.parse(await readFile(`${stem}.json`, "utf8")) as ObjectInfo;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeMeta(stem: string, info: ObjectInfo): Promise<void> {
    const tmp = `${stem}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(info));
    await rename(tmp, `${stem}.json`);
  }
}
