// What PUT /backup/settings may contain (services/backup.service.ts).

import { QUALITIES } from "../constants/backup.constants.ts";
import type { BackupQuality } from "../types/backup.types.ts";
import { HttpError } from "../utils/http-error.ts";

// { quality: "original" | "saverHigh" | "saver" }, nothing else.
export function parseBackupSettings(body: Record<string, unknown>): BackupQuality {
  for (const key of Object.keys(body)) if (key !== "quality") throw new HttpError(400, `Unknown setting: ${key}.`);
  const quality = QUALITIES.find((q) => q === body.quality);
  if (!quality) throw new HttpError(400, `quality must be one of: ${QUALITIES.join(", ")}.`);
  return quality;
}
