# pistorage

Durable file storage for the church's Pi ecosystem. Other Pi apps (piprogram first) get one place for files that must survive a reboot of the Pi. The bytes live in any S3-compatible store; the Pi keeps a read-through disk cache so that recent files are served locally.

- **Backend:** S3 or any S3-compatible service (VersityGW on an operator PC now, Hetzner Object Storage later). Switching is configuration only.
- **Cache:** on the Pi, with a TTL counted from last access, a size cap with least-recently-used eviction, and stale serving when the backend is unreachable.
- **Writes are never silently lost:** a write goes to the backend first and fails with 503 while the backend is down.
- **Retention:** an object can carry a deadline (for example Canva exports kept 60 days); a sweep deletes it.

Status: first version. Nothing has been run against a real S3 service (VersityGW or Hetzner). The local-disk backend and the fake-offline tests are the only verified paths.

Port: pistorage listens on `PISTORAGE_PORT`, default **3700**. Port 3700 is reserved for pistorage in the piecosystem port table (`docs/inter-service-matrix.md` in `piecosystem`). Do not use 3300 for it.

## Requirements

Node.js 24 or later (`engines` in `package.json`), pnpm.

## Build and test

```bash
pnpm install
pnpm run build      # generates src/generated from openapi/openapi.yaml, then tsc -> dist/
pnpm test           # vitest, no network
pnpm run typecheck  # also checks the tests
```

## Configuration

All variables use the `PISTORAGE_` prefix.

| Variable | Default | Meaning |
|---|---|---|
| `PISTORAGE_PORT` | `3700` | HTTP port. |
| `PISTORAGE_HOST` | `127.0.0.1` | Bind address. A non-loopback address requires `PISTORAGE_API_KEY`. |
| `PISTORAGE_API_KEY` | unset (open) | When set, every `/api/v1/` request needs `Authorization: Bearer <key>` or `x-api-key`, reads included. `/health` stays open. |
| `PISTORAGE_MAX_BYTES` | `524288000` (500 MB) | Largest accepted upload; bigger ones get 413. |
| `PISTORAGE_S3_ENDPOINT` | unset | S3 endpoint URL. S3 is used when this and `PISTORAGE_S3_BUCKET` are both set. Setting only one is an error. |
| `PISTORAGE_S3_BUCKET` | unset | Bucket name. |
| `PISTORAGE_S3_REGION` | `us-east-1` | Region string sent to the endpoint. |
| `PISTORAGE_S3_ACCESS_KEY` / `PISTORAGE_S3_SECRET_KEY` | unset | Credentials. Set both or neither; with neither, the AWS default credential chain is used (`AWS_*` variables). |
| `PISTORAGE_S3_FORCE_PATH_STYLE` | `1` | Path-style addressing (`endpoint/bucket/key`). Set `0` for virtual-hosted style. |
| `PISTORAGE_LOCAL_DIR` | `./data/store` | Local-disk backend, used when S3 is not configured. For development and tests. |
| `PISTORAGE_CACHE_DIR` | `./data/cache` | Disk cache location. |
| `PISTORAGE_CACHE_TTL_SECONDS` | `1209600` (14 days) | Cache lifetime from last access. |
| `PISTORAGE_CACHE_MAX_BYTES` | `5368709120` (5 GiB) | Cache size cap; least recently used copies go first. |
| `PISTORAGE_CACHE_SWEEP_SECONDS` | `600` | How often the cache is pruned and access times are saved. |
| `PISTORAGE_RETENTION_SWEEP` | `0` | `1` runs the retention sweep on a timer. Off by default. |
| `PISTORAGE_RETENTION_SWEEP_SECONDS` | `3600` | Sweep interval when enabled. |

## Pointing it at a backend

**VersityGW on an operator PC:**

```bash
PISTORAGE_S3_ENDPOINT=http://192.168.1.50:7070
PISTORAGE_S3_BUCKET=pistorage
PISTORAGE_S3_ACCESS_KEY=...
PISTORAGE_S3_SECRET_KEY=...
PISTORAGE_S3_FORCE_PATH_STYLE=1
```

**Hetzner Object Storage later:** only the endpoint, bucket and keys change. Use the endpoint of the bucket's region (for example `https://fsn1.your-objectstorage.com`) and, if Hetzner requires it, `PISTORAGE_S3_FORCE_PATH_STYLE=0`. Nothing else in the code depends on the provider.

The client sends no streaming checksums (`requestChecksumCalculation: WHEN_REQUIRED`), because several S3-compatible stores reject them. Uploads need a `Content-Length`.

## HTTP API (`/api/v1`)

| Method and path | What it does |
|---|---|
| `PUT /objects/{key}` | Store the body. Needs `Content-Length` (411 otherwise). Optional `x-pistorage-expires-at` (ISO 8601, in the future). Answers 201 with the object info. |
| `GET /objects/{key}` | Read. Supports one `Range: bytes=…` (206, `Content-Range`); 416 when outside the object. Keeps `Content-Type`. |
| `HEAD /objects/{key}` | Headers only: size, type, ETag, `Last-Modified`, `x-pistorage-expires-at`. |
| `DELETE /objects/{key}` | Delete from the backend and cache. Idempotent (204). |
| `GET /objects?prefix=&limit=` | List keys under a prefix (limit 1 to 1000, default 1000). |
| `GET /status` | Backend kind and reachability, cache bytes and count, stale responses served, last retention sweep. |
| `POST /cache/prune` | Prune the cache now. |
| `POST /retention/sweep` | Run the retention sweep now. 409 unless `PISTORAGE_RETENTION_SWEEP=1`. |
| `GET /health` | Liveness, no key needed. |

Keys: 1 to 512 characters; no leading `/`, no `..`, no backslash, no control characters, no empty or `.` path segments. In URLs each segment is percent-encoded and the `/` separators are kept.

Responses carry `x-pistorage-stale: 1` when the backend could not be reached and a copy past its TTL was served. Errors are `{ "error": { "code", "message" } }`. A write while the backend is down is 503 `BACKEND_UNAVAILABLE`.

The full contract is `openapi/openapi.yaml`.

## Behaviour in brief

- **Write:** the body is spooled to a temporary file (checked against `Content-Length`), sent to the backend, and only then moved into the cache. A failed backend write leaves nothing in the cache.
- **Read:** a cached copy within its TTL is served without contacting the backend. A copy past its TTL is revalidated with the backend; if the backend is unreachable, the copy is served and marked stale.
- **Eviction:** TTL-expired copies go only while the backend is reachable, so stale serving keeps working. The size cap always applies.
- **Retention:** past its deadline an object reads as missing. The sweep lists the backend and deletes expired objects from the backend and the cache. Each sweep makes one HEAD request per object, which is fine for a church's file count and costs time on a large bucket.
- **Objects larger than the cache cap** are served but not kept on the Pi.
- **Caveat:** a cached copy within its TTL is trusted without checking the backend, so a change made directly in the bucket (not through pistorage) is not seen until the TTL passes.

## Client module

`src/client.ts` is a fetch-based client with no dependencies:

```ts
import { PiStorageClient } from "pistorage";

const store = new PiStorageClient({ baseUrl: "http://127.0.0.1:3700", apiKey: process.env.PISTORAGE_API_KEY });
await store.put("piprogram/hymns/1.pdf", bytes, { contentType: "application/pdf" });
const response = await store.get("piprogram/hymns/1.pdf", { range: { start: 0, end: 1023 } });
const info = await store.head("piprogram/hymns/1.pdf"); // null when absent
await store.delete("piprogram/hymns/1.pdf");
const listing = await store.list("piprogram/");
```

Errors are `PiStorageClientError` with `status` and `code`.

## CLI

```bash
pistorage status
pistorage put <key> <file> [--content-type t] [--expires-at iso]
pistorage get <key> <file> [--range bytes=0-99]
pistorage head <key>
pistorage rm <key>
pistorage ls [prefix] [--limit n]
pistorage cache prune
pistorage retention sweep
```

Set `PISTORAGE_URL` (default `http://127.0.0.1:3700`) and `PISTORAGE_API_KEY`. The admin commands use the client generated from the OpenAPI file (`src/generated`, rebuilt by `pnpm run generate`).

## Running as a user service (example, not deployed)

`~/.config/systemd/user/pistorage.service`:

```ini
[Unit]
Description=pistorage
After=network-online.target

[Service]
WorkingDirectory=%h/pistorage
EnvironmentFile=%h/pistorage/.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now pistorage`. The `.env` file holds the `PISTORAGE_*` variables above and is not committed.

## Layout

- `src/backend.ts`, `src/backends/` - the backend interface, S3 and local disk
- `src/cache.ts` - the disk cache (index, TTL, LRU, flush)
- `src/storage.ts` - read-through, write-through and stale logic, retention
- `src/server.ts`, `src/main.ts` - the Fastify API and its entry point
- `src/client.ts`, `src/cli.ts`, `src/cli-main.ts` - client and CLI
- `openapi/openapi.yaml` - the API contract
- `test/` - vitest suites (fake offline backend, stub S3 client, in-process HTTP)
