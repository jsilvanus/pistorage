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
import { formatUseAt, parseUseAt, UseAtError } from "./use-at.js";
import { checkSignature, MAX_SIGNED_SECONDS, signPath, type SignedMethod } from "./signing.js";

export interface ServerOptions {
  storage: PiStorage;
  apiKey?: string | undefined;
  /** Secret for signed URLs. Undefined = signed URLs are off. */
  signingSecret?: string | undefined;
  /** Public base URL, so that signed URLs can be returned in full. */
  publicUrl?: string | undefined;
  logger?: boolean;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const EXPIRES_HEADER = "x-pistorage-expires-at";
const USE_AT_HEADER = "x-pistorage-use-at";
const STALE_HEADER = "x-pistorage-stale";
const PENDING_HEADER = "x-pistorage-pending";

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

/** Parses the x-pistorage-use-at header: dates, hours or ranges separated by commas (see use-at.ts). */
export function parseUseAtHeader(value: string | undefined, timezone: string): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const entries = parseUseAt(value, timezone);
    return entries.length ? entries : undefined;
  } catch (error) {
    if (error instanceof UseAtError) throw new StorageError(400, "INVALID_USE_AT", `x-pistorage-use-at: ${error.message}`);
    throw error;
  }
}

function quoteEtag(etag: string): string {
  return `"${etag.replace(/"/g, "")}"`;
}

function lastModifiedOf(info: ObjectInfo): string {
  const time = Date.parse(info.lastModified);
  return Number.isNaN(time) ? new Date(0).toUTCString() : new Date(time).toUTCString();
}

function objectHeaders(reply: FastifyReply, info: ObjectInfo, stale: boolean, pending = false): void {
  if (pending) reply.header(PENDING_HEADER, "1");
  reply.header("content-type", info.contentType);
  reply.header("etag", quoteEtag(info.etag));
  reply.header("last-modified", lastModifiedOf(info));
  reply.header("accept-ranges", "bytes");
  if (info.expiresAt) reply.header(EXPIRES_HEADER, info.expiresAt);
  if (info.useAt?.length) reply.header(USE_AT_HEADER, formatUseAt(info.useAt));
  if (stale) reply.header(STALE_HEADER, "1");
}

function objectJson(info: ObjectInfo) {
  return {
    key: info.key,
    size: info.size,
    contentType: info.contentType,
    etag: info.etag,
    lastModified: info.lastModified,
    ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}),
    ...(info.useAt?.length ? { useAt: info.useAt } : {})
  };
}

function sendOpened(reply: FastifyReply, opened: OpenedObject, head: boolean) {
  const range: ByteRange | undefined = opened.range;
  objectHeaders(reply, opened.info, opened.stale, opened.pending);
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
  const { storage, apiKey, signingSecret } = options;
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

  // Signed links work without the API key (they are outside /api/v1) but only for the one key and method they were made for.
  const SIGNED_PREFIX = "/signed/";
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith(SIGNED_PREFIX)) return;
    if (!signingSecret) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Unknown route" } });
    }
    let key: string;
    try {
      key = decodeURIComponent(path.slice(SIGNED_PREFIX.length));
    } catch {
      return reply.code(400).send({ error: { code: "INVALID_KEY", message: "bad key encoding" } });
    }
    const method: SignedMethod | undefined = request.method === "PUT" ? "PUT" : request.method === "GET" || request.method === "HEAD" ? "GET" : undefined;
    const query = request.query as { expires?: string; sig?: string };
    const verdict = method ? checkSignature(signingSecret, method, key, query.expires, query.sig, Date.now()) : "invalid";
    if (verdict === "expired") return reply.code(403).send({ error: { code: "LINK_EXPIRED", message: "this link has expired" } });
    if (verdict !== "ok") return reply.code(403).send({ error: { code: "SIGNATURE_INVALID", message: "the link is not valid for this key and method" } });
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

    const doPut = async (request: FastifyRequest, reply: FastifyReply, rawKey: string) => {
      const key = assertKey(rawKey);
      const declared = request.headers["content-length"];
      if (declared === undefined || request.headers["transfer-encoding"] !== undefined) {
        throw new StorageError(411, "LENGTH_REQUIRED", "Content-Length is required");
      }
      const size = /^\d+$/.test(declared) ? Number(declared) : Number.NaN;
      if (!Number.isSafeInteger(size)) throw new StorageError(400, "INVALID_LENGTH", "Content-Length must be a whole number");
      if (size > storage.maxUploadBytes) {
        throw new StorageError(413, "TOO_LARGE", `object is larger than the ${storage.maxUploadBytes} byte limit`);
      }
      const result = await storage.put(key, {
        size,
        contentType: request.headers["content-type"] || DEFAULT_CONTENT_TYPE,
        expiresAt: parseExpiresHeader(request.headers[EXPIRES_HEADER] as string | undefined),
        useAt: parseUseAtHeader(request.headers[USE_AT_HEADER] as string | undefined, storage.timezone),
        body: request.raw as Readable
      });
      reply.header("etag", quoteEtag(result.info.etag));
      // 202: accepted into the local spool while the backend is down; uploaded when it is back.
      if (result.pending) reply.header(PENDING_HEADER, "1");
      return reply.code(result.pending ? 202 : 201).send({ ...objectJson(result.info), ...(result.pending ? { pending: true } : {}) });
    };
    const doGet = async (request: FastifyRequest, reply: FastifyReply, rawKey: string) => {
      const key = assertKey(rawKey);
      const opened = await storage.open(key, request.headers.range);
      if (!opened) throw new StorageError(404, "NOT_FOUND", `no object at ${key}`);
      return sendOpened(reply, opened, false);
    };
    const doHead = async (_request: FastifyRequest, reply: FastifyReply, rawKey: string) => {
      const key = assertKey(rawKey);
      const found = await storage.head(key);
      if (!found) return reply.code(404).send();
      objectHeaders(reply, found.info, found.stale, found.pending);
      reply.header("content-length", String(found.info.size));
      return reply.code(200).send();
    };
    objects.put<{ Params: { "*": string } }>("/api/v1/objects/*", (request, reply) => doPut(request, reply, request.params["*"]));
    objects.get<{ Params: { "*": string } }>("/api/v1/objects/*", (request, reply) => doGet(request, reply, request.params["*"]));
    objects.head<{ Params: { "*": string } }>("/api/v1/objects/*", (request, reply) => doHead(request, reply, request.params["*"]));
    objects.put<{ Params: { "*": string } }>("/signed/*", (request, reply) => doPut(request, reply, request.params["*"]));
    objects.get<{ Params: { "*": string } }>("/signed/*", (request, reply) => doGet(request, reply, request.params["*"]));
    objects.head<{ Params: { "*": string } }>("/signed/*", (request, reply) => doHead(request, reply, request.params["*"]));

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

  app.post<{ Body: { key?: unknown; method?: unknown; expiresInSeconds?: unknown } }>("/api/v1/signed-urls", async (request, reply) => {
    if (!signingSecret) {
      throw new StorageError(409, "SIGNING_DISABLED", "set PISTORAGE_SIGNING_SECRET (or PISTORAGE_API_KEY) to make signed URLs");
    }
    const body = request.body ?? {};
    if (typeof body.key !== "string") throw new StorageError(400, "INVALID_BODY", "key is required");
    const key = assertKey(body.key);
    const method = body.method ?? "GET";
    if (method !== "GET" && method !== "PUT") throw new StorageError(400, "INVALID_METHOD", "method must be GET or PUT");
    const seconds = body.expiresInSeconds === undefined ? 3600 : body.expiresInSeconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SIGNED_SECONDS) {
      throw new StorageError(400, "INVALID_EXPIRY", `expiresInSeconds must be a whole number from 1 to ${MAX_SIGNED_SECONDS}`);
    }
    const expires = Math.floor(Date.now() / 1000) + seconds;
    const path = signPath(signingSecret, method, key, expires);
    return reply.code(201).send({
      method,
      path,
      ...(options.publicUrl ? { url: `${options.publicUrl}${path}` } : {}),
      expiresAt: new Date(expires * 1000).toISOString()
    });
  });

  app.post("/api/v1/spool/flush", async () => storage.flushSpool());

  app.post("/api/v1/cache/prune", async () => {
    const result = await storage.prune();
    return result;
  });

  app.post("/api/v1/prefetch/sweep", async (_request, reply) => {
    return reply.code(200).send(await storage.prefetchDue());
  });

  app.post("/api/v1/retention/sweep", async (_request, reply) => {
    if (!storage.retentionSweepEnabled) {
      throw new StorageError(409, "RETENTION_SWEEP_DISABLED", "set PISTORAGE_RETENTION_SWEEP=1 to enable retention sweeps");
    }
    return reply.code(200).send(await storage.sweepRetention());
  });

  return app;
}
