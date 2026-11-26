// Captions already written: loading a results file into the database, and removing the captions of photos gone from Immich for good.

import { readFileSync } from "node:fs";
import { atomically } from "../db/database.ts";
import { parseRecord } from "../schemas/captions.schema.ts";
import { captionCount, captionedAssetIds, captionFailures, deleteCaptions, saveCaption } from "./repositories/captions.repository.ts";
import type { GoneCaptions, ImportResult } from "../types/captions.types.ts";

// A results file from the backlog (one JSON object per line) → the tables, all in one go. Lines that fail the checks are skipped and counted.
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

// Captions of photos gone from Immich for good (not in `existing`, a list of every photo Immich still has) are removed. Removes nothing when there would be more than `max`.
export function removeGoneCaptions(existing: Set<string>, max: number): GoneCaptions {
  const gone = [...captionedAssetIds(), ...captionFailures().keys()].filter((id) => !existing.has(id));
  if (gone.length === 0 || gone.length > max) return { gone: gone.length, removed: false };
  deleteCaptions(gone);
  return { gone: gone.length, removed: true };
}
