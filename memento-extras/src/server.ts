// Memento's extras service: starts everything up and shuts it down. Routes are in routes/.

import { createServer } from "node:http";
import { config } from "./config.ts";
import { REQUEST_TIMEOUT_MS } from "./constants/http.constants.ts";
import { closeDatabase, database, snapshotDatabase } from "./db/database.ts";
import { sendError } from "./middleware/errors.middleware.ts";
import { setSecurityHeaders } from "./middleware/security-headers.middleware.ts";
import { handle } from "./routes/index.ts";
import { clearUploads } from "./services/copies.service.ts";
import { clearEditFiles, removeExpiredEdits } from "./services/edits.service.ts";
import { startLiveAlbumChecks } from "./services/live-albums.service.ts";
import { startCreationWorker } from "./services/creations.service.ts";
import { startThemedMemories } from "./services/memories.service.ts";
import { recoverNoiseJobs } from "./services/reduce-noise.service.ts";
import { initStore } from "./services/repositories/edits.repository.ts";
import { log } from "./utils/http.ts";

const server = createServer((req, res) => {
  setSecurityHeaders(res);
  handle(req, res).catch((error: unknown) => sendError(req, res, error));
});
server.requestTimeout = REQUEST_TIMEOUT_MS;

await initStore();
await clearUploads();
await clearEditFiles();
database();
recoverNoiseJobs();
startLiveAlbumChecks();
startThemedMemories();
startCreationWorker();

function snapshot(): void {
  try {
    snapshotDatabase();
  } catch (error) {
    log({ event: "snapshot_failed", error: error instanceof Error ? error.message : String(error) });
  }
}
setTimeout(snapshot, config.snapshotFirstSeconds * 1000).unref();
setInterval(snapshot, 60 * 60_000).unref();
setInterval(() => {
  removeExpiredEdits()
    .then((n) => n > 0 && log({ event: "cleanup", removed: n }))
    .catch((error: unknown) => log({ event: "cleanup_failed", error: String(error) }));
}, 5 * 60_000).unref();

server.listen(config.port, () => {
  log({ event: "started", port: config.port, model: config.geminiModel, imageSize: config.imageSize, source: config.source, immich: config.immichUrl });
});

function shutdown(): void {
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
