/**
 * HTTP API for pistorage under /api/v1 (see openapi/openapi.yaml).
 *
 * Auth: when PISTORAGE_API_KEY is set, every request under /api/v1/ needs
 * `Authorization: Bearer <key>` or `x-api-key`, reads included. /health stays open.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ObjectInfo } from "./backend.js";
import { RangeNotSatisfiableError, StorageError } from "./errors.js";
import { assertKey, prefixProblem } from "./keys.js";
import { contentRange, type ByteRange } from "./range.js";
import type { OpenedObject, PiStorage } from "./storage.js";

export interface ServerOptions {
  storage: PiStorage;
  apiKey?: string | undefined;
  logger?: boolean;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const EXPIRES_HEADER = "x-pistorage-expires-at";
const STALE_HEADER = "x-pistorage-stale";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function presentedKey(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = request.headers["x-api-key"];
  return typeof header === "string" ? header.trim() : undefined;
}

function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  return timingSafeEqual(digest(expected), digest(presented));
}

/** Parses the x-pistorage-expires-at header: an ISO 8601 instant that must lie in the future. */
export function parseExpiresHeader(value: string | undefined, now: number = Date.now()): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new StorageError(400, "INVALID_EXPIRES_AT", "x-pistorage-expires-at must be an ISO 8601 date");
  if (time <= now) throw new StorageError(400, "INVALID_EXPIRES_AT", "x-pistorage-expires-at must be in the future");
  return new Date(time).toISOString();
}

function quoteEtag(etag: string): string {
  return `"${etag.replace(/"/g, "")}"`;
}

function lastModifiedOf(info: ObjectInfo): string {
  const time = Date.parse(info.lastModified);
  return Number.isNaN(time) ? new Date(0).toUTCString() : new Date(time).toUTCString();
}

function objectHeaders(reply: FastifyReply, info: ObjectInfo, stale: boolean): void {
  reply.header("content-type", info.contentType);
  reply.header("etag", quoteEtag(info.etag));
  reply.header("last-modified", lastModifiedOf(info));
  reply.header("accept-ranges", "bytes");
  if (info.expiresAt) reply.header(EXPIRES_HEADER, info.expiresAt);
  if (stale) reply.header(STALE_HEADER, "1");
}

function objectJson(info: ObjectInfo) {
  return {
    key: info.key,
    size: info.size,
    contentType: info.contentType,
    etag: info.etag,
    lastModified: info.lastModified,
    ...(info.expiresAt ? { expiresAt: info.expiresAt } : {})
  };
}

function sendOpened(reply: FastifyReply, opened: OpenedObject, head: boolean) {
  const range: ByteRange | undefined = opened.range;
  objectHeaders(reply, opened.info, opened.stale);
  if (range) {
    reply.code(206);
    reply.header("content-range", contentRange(range, opened.info.size));
    reply.header("content-length", String(range.end - range.start + 1));
  } else {
    reply.header("content-length", String(opened.info.size));
  }
  if (head) {
    opened.body.destroy();
    return reply.send();
  }
  return reply.send(opened.body);
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { storage, apiKey } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    exposeHeadRoutes: false
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!apiKey || !path.startsWith("/api/v1/")) return;
    if (keyMatches(apiKey, presentedKey(request))) return;
    return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key required" } });
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof RangeNotSatisfiableError) {
      reply.header("content-range", `bytes */${error.size}`);
      return reply.code(416).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof StorageError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) request.log.error(error);
    return reply.code(status).send({
      error: {
        code: status === 500 ? "INTERNAL" : (error.code ?? "BAD_REQUEST"),
        message: status === 500 ? "internal error" : error.message
      }
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Unknown route" } });
  });

  app.get("/health", async () => ({ status: "ok", service: "pistorage" }));

  // Object routes: the request body is read from the raw request, so no Fastify body parser may
  // consume it. The parser is replaced only inside this scope (JSON uploads must stay bytes).
  app.register(async (objects) => {
    objects.removeAllContentTypeParsers();
    objects.addContentTypeParser("*", (request, _payload, done) => done(null, request));

    objects.put<{ Params: { "*": string } }>("/api/v1/objects/*", async (request, reply) => {
      const key = assertKey(request.params["*"]);
      const declared = request.headers["content-length"];
      if (declared === undefined || request.headers["transfer-encoding"] !== undefined) {
        throw new StorageError(411, "LENGTH_REQUIRED", "Content-Length is required");
      }
      const size = /^\d+$/.test(declared) ? Number(declared) : Number.NaN;
      if (!Number.isSafeInteger(size)) throw new StorageError(400, "INVALID_LENGTH", "Content-Length must be a whole number");
      if (size > storage.maxUploadBytes) {
        throw new StorageError(413, "TOO_LARGE", `object is larger than the ${storage.maxUploadBytes} byte limit`);
      }
      const info = await storage.put(key, {
        size,
        contentType: request.headers["content-type"] || DEFAULT_CONTENT_TYPE,
        expiresAt: parseExpiresHeader(request.headers[EXPIRES_HEADER] as string | undefined),
        body: request.raw as Readable
      });
      reply.header("etag", quoteEtag(info.etag));
      return reply.code(201).send(objectJson(info));
    });

    objects.get<{ Params: { "*": string } }>("/api/v1/objects/*", async (request, reply) => {
      const key = assertKey(request.params["*"]);
      const opened = await storage.open(key, request.headers.range);
      if (!opened) throw new StorageError(404, "NOT_FOUND", `no object at ${key}`);
      return sendOpened(reply, opened, false);
    });

    objects.head<{ Params: { "*": string } }>("/api/v1/objects/*", async (request, reply) => {
      const key = assertKey(request.params["*"]);
      const found = await storage.head(key);
      if (!found) return reply.code(404).send();
      objectHeaders(reply, found.info, found.stale);
      reply.header("content-length", String(found.info.size));
      return reply.code(200).send();
    });

    objects.delete<{ Params: { "*": string } }>("/api/v1/objects/*", async (request, reply) => {
      const key = assertKey(request.params["*"]);
      await storage.delete(key);
      return reply.code(204).send();
    });

    objects.get<{ Querystring: { prefix?: string; limit?: string } }>("/api/v1/objects", async (request) => {
      const prefix = request.query.prefix ?? "";
      const problem = prefixProblem(prefix);
      if (problem) throw new StorageError(400, "INVALID_PREFIX", problem);
      const limit = request.query.limit === undefined ? 1000 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new StorageError(400, "INVALID_LIMIT", "limit must be a whole number from 1 to 1000");
      }
      const listing = await storage.list(prefix, limit);
      return { items: listing.items, truncated: listing.truncated };
    });
  });

  app.get("/api/v1/status", async () => {
    const status = await storage.status();
    return status;
  });

  app.post("/api/v1/cache/prune", async () => {
    const result = await storage.prune();
    return result;
  });

  app.post("/api/v1/retention/sweep", async (_request, reply) => {
    if (!storage.retentionSweepEnabled) {
      throw new StorageError(409, "RETENTION_SWEEP_DISABLED", "set PISTORAGE_RETENTION_SWEEP=1 to enable retention sweeps");
    }
    return reply.code(200).send(await storage.sweepRetention());
  });

  return app;
}
