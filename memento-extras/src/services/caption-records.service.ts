// Captions already written: loading a results file into the database, and removing the
// captions of photos gone from Immich for good. Kept apart from captions.service.ts, which
// must not touch the database (the backlog script runs it on its own). Storage:
// repositories/captions.repository.ts.

import { readFileSync } from "node:fs";
import { atomically } from "../db/database.ts";
import { parseRecord } from "../schemas/captions.schema.ts";
import { captionCount, captionedAssetIds, captionFailures, deleteCaptions, saveCaption } from "./repositories/captions.repository.ts";
import type { GoneCaptions, ImportResult } from "../types/captions.types.ts";

// A results file from the backlog (one JSON object per line) → the tables, all in one go:
// either every good line is saved or, on an error, none are. Lines that fail the checks in
// schemas/captions.schema.ts are skipped and counted.
export function importCaptions(file: string): ImportResult {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  let imported = 0;
  atomically(() => {
    for (const line of lines) {
      const record = parseRecord(line);
      if (!record) continue;
      saveCaption(record);
      imported++;
    }
  });
  return { imported, skipped: lines.length - imported, total: captionCount() };
}

// Captions of photos gone from Immich for good (not in `existing`, a list of every photo
// Immich still has, in any state) are removed, with their tags, search-index entries and
// failure records. Trashed and Locked Folder photos are still there, so theirs stay.
// Removes nothing when there would be more than `max`: a broken list mustn't wipe them.
export function removeGoneCaptions(existing: Set<string>, max: number): GoneCaptions {
  const gone = [...captionedAssetIds(), ...captionFailures().keys()].filter((id) => !existing.has(id));
  if (gone.length === 0 || gone.length > max) return { gone: gone.length, removed: false };
  deleteCaptions(gone);
  return { gone: gone.length, removed: true };
}
