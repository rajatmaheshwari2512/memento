// Backup quality: each person's choice for backups from Memento's phone app, which makes the smaller copy before uploading. Off (the storageSaver flag) refuses choosing a Storage saver level; choosing original still works.

import { STORAGE_SAVER_OFF } from "../constants/backup.constants.ts";
import { getFlags } from "./flags.service.ts";
import { saveQuality, storedQuality } from "./repositories/backup.repository.ts";
import type { BackupQuality, BackupSettings } from "../types/backup.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";

export function settingsOf(userId: string): BackupSettings {
  return { quality: storedQuality(userId) ?? "original" };
}

export function changeSettings(userId: string, quality: BackupQuality): BackupSettings {
  if (quality !== "original" && !getFlags().storageSaver.enabled) throw new HttpError(403, STORAGE_SAVER_OFF);
  saveQuality(userId, quality);
  log({ event: "backup_quality_changed", user: userId, quality });
  return settingsOf(userId);
}
