// Memento's extras service (was ai-edit): starts everything up and shuts it down. The routes
// are in routes/, what each does in controllers/ and services/.

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

await initStore(); // also makes DATA_DIR, which the database file needs
await clearUploads(); // uploads of copies (Adjust, AI edits of an area) a crash left behind
await clearEditFiles(); // and AI edits' files (the photo, its mark, Gemini's result)
database(); // opened (and brought up to date) now, so a problem stops the start
recoverNoiseJobs(); // videos whose noise was being reduced: the line was in memory
startLiveAlbumChecks();
startThemedMemories();
startCreationWorker();

// The database copy the nightly backup picks up (db/database.ts).
function snapshot(): void {
  try {
    snapshotDatabase();
  } catch (error) {
    log({ event: "snapshot_failed", error: error instanceof Error ? error.message : String(error) });
  }
}
setTimeout(snapshot, config.snapshotFirstSeconds * 1000).unref();
setInterval(snapshot, 60 * 60_000).unref();
// Unsaved edit results are deleted after RESULT_TTL_MINUTES (an hour).
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
