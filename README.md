# pistorage

Durable file storage for the church's Pi ecosystem. Other Pi apps (piprogram first) get one place for files that must survive a reboot of the Pi. The bytes live in any S3-compatible store; the Pi keeps a read-through disk cache so that recent files are served locally.

- **Backend:** S3 or any S3-compatible service (VersityGW on an operator PC now, Hetzner Object Storage later). Switching is configuration only.
- **Cache:** on the Pi, with a TTL counted from last access, a size cap with least-recently-used eviction, and stale serving when the backend is unreachable.
- **Writes are never silently lost:** a write goes to the backend first. If the backend is down it is kept in a local spool on the Pi (answer 202, served from there) and uploaded when the backend is back; if the spool is off or full the write fails with 503.
- **Key prefix:** every key is stored under `pi/` in the bucket (configurable), so the Pi ecosystem's files are recognisable in a shared bucket. Callers never see it.
- **Signed links:** a link for one key and one method (GET or PUT) that works without the API key until it expires.
- **Use date (`useAt`):** an object can say when it is meant to be used (a day, an hour, a moment, a range or several). pistorage fetches it into the Pi cache from 48 hours before and keeps it there until 6 hours after, so it is at hand if the internet is not.
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
| `PISTORAGE_KEY_PREFIX` | `pi/` | Prefix added to every key in the backend (S3 and local). `none` turns it off. Changing it later hides objects stored under the old prefix. |
| `PISTORAGE_SPOOL` | `1` | `0` turns the write spool off (a write while the backend is down is then a 503). |
| `PISTORAGE_SPOOL_DIR` | `./data/spool` | Where waiting writes are kept. They survive a restart. |
| `PISTORAGE_SPOOL_MAX_BYTES` | `2147483648` (2 GiB) | Most data that may wait; beyond it a write is a 503. |
| `PISTORAGE_SPOOL_FLUSH_SECONDS` | `30` | How often waiting writes are retried. |
| `PISTORAGE_SIGNING_SECRET` | the API key | Secret for signed links. With neither this nor an API key, signed links are off (409 / 404). Changing it invalidates all links. |
| `PISTORAGE_PUBLIC_URL` | unset | Public address of this service, so that signed links are returned as full URLs. |
| `PISTORAGE_LOCAL_DIR` | `./data/store` | Local-disk backend, used when S3 is not configured. For development and tests. |
| `PISTORAGE_CACHE_DIR` | `./data/cache` | Disk cache location. |
| `PISTORAGE_CACHE_TTL_SECONDS` | `1209600` (14 days) | Cache lifetime from last access. |
| `PISTORAGE_CACHE_MAX_BYTES` | `5368709120` (5 GiB) | Cache size cap; least recently used copies go first. |
| `PISTORAGE_CACHE_SWEEP_SECONDS` | `600` | How often the cache is pruned and access times are saved. |
| `PISTORAGE_TIMEZONE` | `Europe/Helsinki` | Zone for `useAt` dates that carry none. |
| `PISTORAGE_PREFETCH` | `1` | Fetch objects whose `useAt` is near into the cache on a timer. |
| `PISTORAGE_PREFETCH_SECONDS` | `900` | Interval of that sweep. |
| `PISTORAGE_PREFETCH_LEAD_HOURS` | `48` | How long before its time an object is fetched. |
| `PISTORAGE_PREFETCH_GRACE_HOURS` | `6` | How long after its time it stays pinned in the cache. |
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

## Moving to another backend (setup-time script)

`pnpm migrate` (or `pistorage-migrate`) copies every object from one backend to another: local disk to S3, or one S3 service to another. It is a script for setup time, not a service. Content type, retention expiry and `useAt` travel with each object. The source is only read, never changed or emptied. An object that the destination already has with the same size is skipped, so an interrupted run can simply be started again; each copy is checked by reading its size back. Failures are listed and the exit code is 1.

```
MIGRATE_FROM_LOCAL_DIR=/home/pi/apps/pistorage-data/store \
MIGRATE_TO_S3_ENDPOINT=http://192.168.1.50:7070 MIGRATE_TO_S3_BUCKET=pistorage \
MIGRATE_TO_S3_ACCESS_KEY=... MIGRATE_TO_S3_SECRET_KEY=... \
pnpm migrate --dry-run
```

Each side (`MIGRATE_FROM_` and `MIGRATE_TO_`) takes either `LOCAL_DIR`, or `S3_ENDPOINT` + `S3_BUCKET` (+ `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE` as in the table above), and `KEY_PREFIX` (default `pi/`, `none` for no prefix; use the same prefix on both sides unless you mean to change it). `--dry-run` lists what would be copied; `--overwrite` copies even when the size matches. Stop uploads while it runs, then change the `PISTORAGE_*` settings to the new backend and restart. The cache and spool on the Pi are not moved. Objects written to the old backend after the copy are not carried over: run it once more just before the switch. Not run against a real S3 service.

## HTTP API (`/api/v1`)

| Method and path | What it does |
|---|---|
| `PUT /objects/{key}` | Store the body. Needs `Content-Length` (411 otherwise). Optional `x-pistorage-expires-at` (ISO 8601, in the future). Answers 201 with the object info. |
| `GET /objects/{key}` | Read. Supports one `Range: bytes=…` (206, `Content-Range`); 416 when outside the object. Keeps `Content-Type`. |
| `HEAD /objects/{key}` | Headers only: size, type, ETag, `Last-Modified`, `x-pistorage-expires-at`. |
| `DELETE /objects/{key}` | Delete from the backend and cache. Idempotent (204). |
| `GET /objects?prefix=&limit=` | List keys under a prefix (limit 1 to 1000, default 1000). |
| `POST /signed-urls` | Body `{ key, method?: "GET"|"PUT", expiresInSeconds? }` (default GET, 3600 s, at most 7 days). Answers `{ method, path, url?, expiresAt }`. Needs the API key. |
| `GET/HEAD/PUT /signed/{key}?expires=&sig=` | The link itself: no API key, valid only for that key and method (HEAD uses the GET link) until it expires. 403 `SIGNATURE_INVALID` or `LINK_EXPIRED` otherwise. |
| `POST /spool/flush` | Upload the writes waiting in the spool now. |
| `GET /status` | Backend kind and reachability, cache bytes and count, stale responses served, last retention sweep. |
| `POST /cache/prune` | Prune the cache now. |
| `POST /prefetch/sweep` | Fetch objects whose `useAt` is near into the cache now. |
| `POST /retention/sweep` | Run the retention sweep now. 409 unless `PISTORAGE_RETENTION_SWEEP=1`. |
| `GET /health` | Liveness, no key needed. |

Keys: 1 to 512 characters; no leading `/`, no `..`, no backslash, no control characters, no empty or `.` path segments. In URLs each segment is percent-encoded and the `/` separators are kept.

Responses carry `x-pistorage-stale: 1` when the backend could not be reached and a copy past its TTL was served. Errors are `{ "error": { "code", "message" } }`. A write while the backend is down is kept in the spool: 202 with `x-pistorage-pending: 1` and `pending: true`, and reads of it carry the same header. Only with the spool off or full is it 503 `BACKEND_UNAVAILABLE`. `GET /status` shows how many writes wait and how old the oldest is.

The full contract is `openapi/openapi.yaml`.

## Behaviour in brief

- **Write:** the body is spooled to a temporary file (checked against `Content-Length`), sent to the backend, and only then moved into the cache. If the backend is down the file moves to the local spool instead (see above); nothing half-written reaches the cache.
- **Spool caveat:** until a waiting write is uploaded, the Pi's disk holds the only copy. A newer write to the same key replaces the waiting one; a delete drops it; a listing includes waiting keys.
- **Signed links:** the signature is an HMAC over method, key and expiry, so a link cannot be reused for another key or to write instead of read. Anyone holding a link can use it until it expires; there is no per-link revocation except changing the signing secret.
- **Read:** a cached copy within its TTL is served without contacting the backend. A copy past its TTL is revalidated with the backend; if the backend is unreachable, the copy is served and marked stale.
- **Eviction:** TTL-expired copies go only while the backend is reachable, so stale serving keeps working. The size cap always applies.
- **useAt:** sent as the header `x-pistorage-use-at` on `PUT` (`2026-11-08`, `2026-11-08T10`, `2026-11-08T10:30`, `2026-11-08/2026-11-10`, several separated by commas), stored with the object (S3 metadata `use-at`) and returned on `GET`, `HEAD` and in the JSON. The format is in `src/use-at.ts` (no dependencies, meant to be shared with other files such as rundowns). The sweep lists the backend and asks about an object's `useAt` only when its etag is new. Pinned objects are exempt from age and size eviction; if they alone are over `PISTORAGE_CACHE_MAX_BYTES` the cache stays over the cap. It does not change the `useAt` of an existing object: upload again to change it.
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
const link = await store.signUrl("piprogram/hymns/1.pdf", { expiresInSeconds: 600 }); // link.url or base + link.path
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
pistorage prefetch
pistorage put <key> <file> --use-at 2026-11-08/2026-11-09
pistorage spool flush
pistorage sign <key> [--method GET|PUT] [--expires-in seconds]
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

- `src/migrate.ts`, `src/migrate-main.ts` - the backend-to-backend copy script
- `src/backend.ts`, `src/backends/` - the backend interface, S3 and local disk
- `src/cache.ts` - the disk cache (index, TTL, LRU, flush)
- `src/storage.ts` - read-through, write-through and stale logic, retention
- `src/server.ts`, `src/main.ts` - the Fastify API and its entry point
- `src/client.ts`, `src/cli.ts`, `src/cli-main.ts` - client and CLI
- `openapi/openapi.yaml` - the API contract
- `test/` - vitest suites (fake offline backend, stub S3 client, in-process HTTP)
