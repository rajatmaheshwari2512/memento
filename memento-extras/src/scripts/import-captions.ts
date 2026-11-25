// Imports a caption results file into the service's database. Run inside the running
// container, so it uses the same settings and data folder (docs/runbooks.md):
//
//   sudo docker exec memento_extras node --disable-warning=ExperimentalWarning \
//     src/scripts/import-captions.ts /data/import/captions.jsonl
//
// Safe to run again: a photo's caption is replaced, not duplicated.

import { closeDatabase } from "../db/database.ts";
import { importCaptions } from "../services/caption-records.service.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node src/scripts/import-captions.ts <results.jsonl>");
  process.exit(2);
}

const result = importCaptions(file);
closeDatabase();
console.log(JSON.stringify({ event: "captions_imported", file, ...result }));
