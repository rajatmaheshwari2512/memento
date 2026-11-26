// Each person's backup quality, in data.db (the backup_settings table: db/migrations.ts, step 13).
// What it does: services/backup.service.ts.

import { database } from "../../db/database.ts";
import type { BackupQuality } from "../../types/backup.types.ts";

export function storedQuality(userId: string): BackupQuality | undefined {
  const row = database().prepare("SELECT quality FROM backup_settings WHERE user_id = ?").get(userId) as { quality: BackupQuality } | undefined;
  return row?.quality;
}

export function saveQuality(userId: string, quality: BackupQuality): void {
  database().prepare(
    "INSERT INTO backup_settings (user_id, quality, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (user_id) DO UPDATE SET quality = excluded.quality, updated_at = excluded.updated_at",
  ).run(userId, quality, new Date().toISOString());
}
