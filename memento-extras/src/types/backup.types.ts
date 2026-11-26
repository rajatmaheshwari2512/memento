// Backup quality: each person's choice for backups from Memento's Android app (services/backup.service.ts).

import type { QUALITIES } from "../constants/backup.constants.ts";

export type BackupQuality = (typeof QUALITIES)[number];

// What GET/PUT /backup/settings answer.
export type BackupSettings = { quality: BackupQuality };
