/**
 * `pistorage` CLI. JSON admin calls (status, list, cache prune, retention sweep) use the client
 * generated from openapi/openapi.yaml (src/generated, `pnpm run generate`). Object bytes go through
 * src/client.ts, because the generated client reads bodies as text.
 * Set PISTORAGE_URL (default http://127.0.0.1:3700) and PISTORAGE_API_KEY.
 */

import { readFile, writeFile } from "node:fs/promises";
import { ApiError, ObjectsService, OpenAPI, SystemService } from "./generated/index.js";
import { PiStorageClient, PiStorageClientError } from "./client.js";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  baseUrl: string;
  apiKey?: string | undefined;
}

const USAGE = `Usage: pistorage <command>

  pistorage status
  pistorage put <key> <file> [--content-type <type>] [--expires-at <ISO 8601>] [--use-at <dates>]
  pistorage get <key> <file> [--range bytes=0-99]
  pistorage head <key>
  pistorage rm <key>
  pistorage ls [prefix] [--limit n]
  pistorage cache prune
  pistorage retention sweep
  pistorage prefetch
  pistorage spool flush
  pistorage sign <key> [--method GET|PUT] [--expires-in seconds]

Environment: PISTORAGE_URL (default http://127.0.0.1:3700), PISTORAGE_API_KEY.
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

/** Positional arguments with the flags and their values removed. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function need(values: string[], index: number, name: string): string {
  const value = values[index];
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}

function configure(io: CliIo): void {
  OpenAPI.BASE = io.baseUrl;
  OpenAPI.HEADERS = io.apiKey ? { authorization: `Bearer ${io.apiKey}` } : undefined;
}

function print(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

/** Runs one CLI command and returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 1;
  }
  const client = new PiStorageClient({ baseUrl: io.baseUrl, apiKey: io.apiKey });
  try {
    configure(io);
    const values = positionals(rest);
    switch (command) {
      case "status":
        print(io, await SystemService.getStatus());
        return 0;
      case "put": {
        const key = need(values, 0, "key");
        const file = need(values, 1, "file");
        const body = await readFile(file);
        const info = await client.put(key, body, {
          contentType: flag(rest, "--content-type"),
          expiresAt: flag(rest, "--expires-at"),
          ...(flag(rest, "--use-at") === undefined ? {} : { useAt: flag(rest, "--use-at")! })
        });
        print(io, info);
        return 0;
      }
      case "get": {
        const key = need(values, 0, "key");
        const file = need(values, 1, "file");
        const response = await client.get(key, { range: flag(rest, "--range") });
        await writeFile(file, Buffer.from(await response.arrayBuffer()));
        io.out(`wrote ${file}`);
        return 0;
      }
      case "head": {
        const info = await client.head(need(values, 0, "key"));
        if (!info) {
          io.err("not found");
          return 1;
        }
        print(io, info);
        return 0;
      }
      case "rm":
        await client.delete(need(values, 0, "key"));
        io.out("deleted");
        return 0;
      case "ls": {
        const limit = flag(rest, "--limit");
        print(io, await ObjectsService.listObjects(values[0] ?? "", limit === undefined ? 1000 : Number(limit)));
        return 0;
      }
      case "cache":
        if (values[0] !== "prune") throw new Error("expected: cache prune");
        print(io, await SystemService.pruneCache());
        return 0;
      case "retention":
        if (values[0] !== "sweep") throw new Error("expected: retention sweep");
        print(io, await SystemService.sweepRetention());
        return 0;
      case "prefetch":
        print(io, await client.prefetch());
        return 0;
      case "spool":
        if (values[0] !== "flush") throw new Error("expected: spool flush");
        print(io, await client.flushSpool());
        return 0;
      case "sign": {
        const method = flag(rest, "--method") ?? "GET";
        if (method !== "GET" && method !== "PUT") throw new Error("--method must be GET or PUT");
        const seconds = flag(rest, "--expires-in");
        print(io, await client.signUrl(need(values, 0, "key"), { method, ...(seconds === undefined ? {} : { expiresInSeconds: Number(seconds) }) }));
        return 0;
      }
      default:
        io.err(`unknown command: ${command}\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const body = error.body as { error?: { code?: string; message?: string } } | undefined;
      io.err(`pistorage: HTTP ${error.status} ${body?.error?.code ?? ""}: ${body?.error?.message ?? error.message}`.replace("  ", " "));
    } else if (error instanceof PiStorageClientError) {
      io.err(`pistorage: HTTP ${error.status} ${error.code}: ${error.message}`);
    } else {
      io.err(`pistorage: ${(error as Error).message}`);
    }
    return 1;
  }
}
