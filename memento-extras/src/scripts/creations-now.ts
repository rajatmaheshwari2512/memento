// By hand, once, for one person: this week's animation and cinematic photo now (services/creations-now.service.ts). Run on the server by an admin:
//
//   sudo docker exec memento_extras node --disable-warning=ExperimentalWarning src/scripts/creations-now.ts <Immich user id>
//
// It only proposes and queues: the service's own worker makes them. Running it again does nothing. Prints ids and counts only.

import { parseArgs } from "node:util";
import { closeDatabase } from "../db/database.ts";
import { creationsNow } from "../services/creations-now.service.ts";
import { inQuietHours, today } from "../services/schedule.service.ts";
import { isUuid } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";

const { positionals } = parseArgs({ allowPositionals: true });
const userId = positionals[0];
if (positionals.length !== 1 || !userId || !isUuid(userId)) {
  console.error("Usage: node src/scripts/creations-now.ts <Immich user id>");
  process.exit(2);
}
if (inQuietHours()) {
  console.error("Not during the night captions' hours: try again after them.");
  process.exit(1);
}

try {
  const result = await creationsNow(userId, today());
  log({ event: "creations_now", user: userId, ...result });
} finally {
  closeDatabase();
}
