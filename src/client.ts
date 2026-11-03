/**
 * Small fetch-based client for pistorage. No dependencies; works on Node 24 and in browsers.
 *
 *   const store = new PiStorageClient({ baseUrl: "http://127.0.0.1:3700", apiKey });
 *   await store.put("exports/canva/slide-1.png", bytes, { contentType: "image/png" });
 *   const response = await store.get("exports/canva/slide-1.png");
 */

export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: string;
  expiresAt?: string;
  useAt?: string[];
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

export interface PutOptions {
  contentType?: string;
  /** Retention deadline; the object reads as missing after it and the retention sweep deletes it. */
  expiresAt?: Date | string;
  /**
   * When the object is meant to be used, so that pistorage can have it in the Pi cache beforehand:
   * 2026-11-08 (a day), 2026-11-08T10 (an hour), 2026-11-08T10:30 (a moment) or 2026-11-08/2026-11-10
   * (a range); a list or a comma separated string holds several.
   */
  useAt?: string | string[];
}

export interface GetOptions {
  /** Byte range: `{ start, end? }` (end inclusive) or a raw Range header value such as "bytes=0-99". */
  range?: { start: number; end?: number } | string;
}

export interface PiStorageClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Timeout for the small JSON calls (head, delete, list, status). Uploads and downloads have none. */
  timeoutMs?: number;
}

export class PiStorageClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PiStorageClientError";
  }
}

/** Percent-encodes each path segment of a key and keeps the "/" separators. */
export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export class PiStorageClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PiStorageClientOptions) {
    this.base = `${options.baseUrl.replace(/\/+$/, "")}/api/v1`;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Uploads an object. Strings, byte arrays and Blobs are sent with a known Content-Length. */
  /** Resolves with `pending: true` when the backend was down and the object is waiting in pistorage's local spool. */
  async put(key: string, body: string | Uint8Array | Blob, options: PutOptions = {}): Promise<ObjectInfo & { pending?: boolean }> {
    const headers: Record<string, string> = { "content-type": options.contentType ?? "application/octet-stream" };
    if (options.expiresAt !== undefined) {
      headers["x-pistorage-expires-at"] = typeof options.expiresAt === "string" ? options.expiresAt : options.expiresAt.toISOString();
    }
    if (options.useAt !== undefined) {
      headers["x-pistorage-use-at"] = typeof options.useAt === "string" ? options.useAt : options.useAt.join(", ");
    }
    const response = await this.fetchFn(this.objectUrl(key), {
      method: "PUT",
      headers: this.authHeaders(headers),
      body: body as BodyInit
    });
    await this.ensureOk(response);
    return (await response.json()) as ObjectInfo & { pending?: boolean };
  }

  /** Downloads an object. Returns the raw Response so that large bodies can be streamed. */
  async get(key: string, options: GetOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.range !== undefined) {
      headers.range = typeof options.range === "string" ? options.range : rangeHeader(options.range);
    }
    const response = await this.fetchFn(this.objectUrl(key), { method: "GET", headers: this.authHeaders(headers) });
    await this.ensureOk(response);
    return response;
  }

  /** Metadata of an object, or null when it does not exist. */
  async head(key: string): Promise<ObjectInfo | null> {
    const response = await this.fetchFn(this.objectUrl(key), {
      method: "HEAD",
      headers: this.authHeaders({}),
      signal: this.signal()
    });
    if (response.status === 404) return null;
    await this.ensureOk(response);
    return infoFromHeaders(key, response.headers);
  }

  async delete(key: string): Promise<void> {
    const response = await this.fetchFn(this.objectUrl(key), {
      method: "DELETE",
      headers: this.authHeaders({}),
      signal: this.signal()
    });
    await this.ensureOk(response);
  }

  async list(prefix = "", options: { limit?: number } = {}): Promise<ListResult> {
    const params = new URLSearchParams({ prefix });
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const response = await this.fetchFn(`${this.base}/objects?${params.toString()}`, {
      method: "GET",
      headers: this.authHeaders({}),
      signal: this.signal()
    });
    await this.ensureOk(response);
    return (await response.json()) as ListResult;
  }

  /**
   * A link for one key and method that works without the API key until it expires. `url` is set
   * when the server knows its public address (PISTORAGE_PUBLIC_URL); otherwise join `path` to the base URL.
   */
  async signUrl(
    key: string,
    options: { method?: "GET" | "PUT"; expiresInSeconds?: number } = {}
  ): Promise<{ method: "GET" | "PUT"; path: string; url?: string; expiresAt: string }> {
    const response = await this.fetchFn(`${this.base}/signed-urls`, {
      method: "POST",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ key, ...options }),
      signal: this.signal()
    });
    await this.ensureOk(response);
    return (await response.json()) as { method: "GET" | "PUT"; path: string; url?: string; expiresAt: string };
  }

  /**
   * Changes when an existing object is meant to be used (see use-at.ts) without uploading it again.
   * Pass null or an empty list to clear it. Throws on 404 when the object does not exist.
   */
  async setUseAt(key: string, useAt: string | readonly string[] | null): Promise<ObjectInfo> {
    const response = await this.fetchFn(`${this.base}/use-at`, {
      method: "POST",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ key, useAt }),
      signal: this.signal()
    });
    await this.ensureOk(response);
    return (await response.json()) as ObjectInfo;
  }

  /** Uploads the writes that waited in the local spool. */
  async flushSpool(): Promise<{ uploaded: number; waiting: number }> {
    return (await this.json("POST", "/spool/flush")) as { uploaded: number; waiting: number };
  }

  async status(): Promise<unknown> {
    return this.json("GET", "/status");
  }

  async pruneCache(): Promise<unknown> {
    return this.json("POST", "/cache/prune");
  }

  /** Fetches objects whose useAt is near into the Pi cache now (it also runs on a timer). */
  async prefetch(): Promise<unknown> {
    return this.json("POST", "/prefetch/sweep");
  }

  async sweepRetention(): Promise<unknown> {
    return this.json("POST", "/retention/sweep");
  }

  private async json(method: string, path: string): Promise<unknown> {
    const response = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: this.authHeaders({}),
      signal: this.signal()
    });
    await this.ensureOk(response);
    return response.json();
  }

  private objectUrl(key: string): string {
    return `${this.base}/objects/${encodeKey(key)}`;
  }

  private authHeaders(extra: Record<string, string>): Record<string, string> {
    return this.apiKey ? { ...extra, authorization: `Bearer ${this.apiKey}` } : extra;
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  private async ensureOk(response: Response): Promise<void> {
    if (response.ok) return;
    let code = "HTTP_ERROR";
    let message = `pistorage answered HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Not JSON: keep the generic message.
    }
    throw new PiStorageClientError(response.status, code, message);
  }
}

function rangeHeader(range: { start: number; end?: number }): string {
  return `bytes=${range.start}-${range.end ?? ""}`;
}

function infoFromHeaders(key: string, headers: Headers): ObjectInfo {
  const lastModified = headers.get("last-modified");
  const parsed = lastModified ? Date.parse(lastModified) : Number.NaN;
  const info: ObjectInfo = {
    key,
    size: Number(headers.get("content-length") ?? 0),
    contentType: headers.get("content-type") ?? "application/octet-stream",
    etag: (headers.get("etag") ?? "").replace(/"/g, ""),
    lastModified: Number.isNaN(parsed) ? "" : new Date(parsed).toISOString()
  };
  const expiresAt = headers.get("x-pistorage-expires-at");
  if (expiresAt) info.expiresAt = expiresAt;
  const useAt = headers.get("x-pistorage-use-at");
  if (useAt) info.useAt = useAt.split(",").map((e) => e.trim()).filter(Boolean);
  return info;
}
