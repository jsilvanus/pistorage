import { loadConfig } from "./config.js";
import { createBackend } from "./backends/index.js";
import { DiskCache } from "./cache.js";
import { PiStorage } from "./storage.js";
import { buildServer } from "./server.js";

/**
 * Starts the pistorage HTTP API. Configuration comes from PISTORAGE_* variables (see README.md).
 * The port is PISTORAGE_PORT (default 3700).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const backend = createBackend(config.backend);
  const cache = await DiskCache.open({
    dir: config.cache.dir,
    ttlMs: config.cache.ttlSeconds * 1000,
    maxBytes: config.cache.maxBytes
  });
  const storage = new PiStorage({
    backend,
    cache,
    maxUploadBytes: config.maxUploadBytes,
    retentionSweepEnabled: config.retention.sweepEnabled
  });
  const app = buildServer({ storage, apiKey: config.apiKey, logger: true });

  const log = (message: string, error: unknown) => app.log.error({ err: error }, message);
  const timers = [
    setInterval(() => {
      storage
        .prune()
        .then(() => cache.flush())
        .catch((error: unknown) => log("cache sweep failed", error));
    }, config.cache.sweepSeconds * 1000)
  ];
  if (config.retention.sweepEnabled) {
    timers.push(
      setInterval(() => {
        storage.sweepRetention().catch((error: unknown) => log("retention sweep failed", error));
      }, config.retention.sweepSeconds * 1000)
    );
  }
  for (const timer of timers) timer.unref();

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    void app
      .close()
      .then(() => cache.flush())
      .catch((error: unknown) => app.log.error({ err: error }, "shutdown error"))
      .finally(() => {
        backend.close?.();
        process.exit(0);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error("pistorage failed to start:", error);
  process.exitCode = 1;
});
