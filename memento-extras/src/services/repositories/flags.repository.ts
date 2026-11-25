// Admins' overrides of Memento's switches, in data.db (the flags table: db/migrations.ts).
// Only overrides are stored; the defaults and the rules are in services/flags.service.ts.

import { database } from "../../db/database.ts";
import type { StoredFlag } from "../../types/flags.types.ts";

export function storedFlags(): StoredFlag[] {
  return database().prepare("SELECT key, value FROM flags").all() as StoredFlag[];
}

export function saveFlag(key: string, value: unknown, adminUserId: string): void {
  database().prepare(
    "INSERT INTO flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  ).run(key, JSON.stringify(value), new Date().toISOString(), adminUserId);
}

export function removeFlag(key: string): void {
  database().prepare("DELETE FROM flags WHERE key = ?").run(key);
}
