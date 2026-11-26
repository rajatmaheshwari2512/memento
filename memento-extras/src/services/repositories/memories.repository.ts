// Themed memories as stored in data.db (tables defined in db/migrations.ts, step 5):
//   memory_users          who turned them on: their encrypted key, their creations choice, last run
//   themed_memories       every themed memory made: Immich's id, the theme, its label
//   themed_memory_assets  the photos each used (the cooldown)
// What they do: services/memories.service.ts.

import { database } from "../../db/database.ts";
import type { History, MemoryUserRow, Theme, ThemedMemoryRow } from "../../types/memories.types.ts";
import { addDays } from "../../utils/local-date.ts";

// --- people who turned them on ---

export function memoryUser(userId: string): MemoryUserRow | undefined {
  return database().prepare("SELECT * FROM memory_users WHERE user_id = ?").get(userId) as MemoryUserRow | undefined;
}

// People with a key, whose run for `today` hasn't happened, and who didn't fail in the last
// `retryMinutes`.
export function usersDue(today: string, retryBefore: string): string[] {
  const rows = database().prepare(
    `SELECT user_id FROM memory_users
     WHERE sealed IS NOT NULL AND paused_reason IS NULL
       AND (last_run_day IS NULL OR last_run_day < ?)
       AND (last_attempt_at IS NULL OR last_attempt_at < ?)
     ORDER BY created_at`,
  ).all(today, retryBefore) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

function ensureRow(userId: string): void {
  const now = new Date().toISOString();
  database().prepare("INSERT OR IGNORE INTO memory_users (user_id, created_at, updated_at) VALUES (?, ?, ?)").run(userId, now, now);
}

export function saveMemoryKey(userId: string, key: { keyId: string; sealed: string; permissions: string }): void {
  ensureRow(userId);
  database().prepare(
    "UPDATE memory_users SET key_id = ?, sealed = ?, permissions = ?, paused_reason = NULL, updated_at = ? WHERE user_id = ?",
  ).run(key.keyId, key.sealed, key.permissions, new Date().toISOString(), userId);
}

export function clearMemoryKey(userId: string): void {
  database().prepare(
    "UPDATE memory_users SET key_id = NULL, sealed = NULL, permissions = NULL, paused_reason = NULL, updated_at = ? WHERE user_id = ?",
  ).run(new Date().toISOString(), userId);
}

export function setCreationsChoice(userId: string, on: boolean): void {
  ensureRow(userId);
  database().prepare("UPDATE memory_users SET creations = ?, updated_at = ? WHERE user_id = ?").run(on ? 1 : 0, new Date().toISOString(), userId);
}

export function pauseMemories(userId: string, reason: string): void {
  database().prepare("UPDATE memory_users SET paused_reason = ?, updated_at = ? WHERE user_id = ?").run(reason, new Date().toISOString(), userId);
}

export function recordAttempt(userId: string): void {
  database().prepare("UPDATE memory_users SET last_attempt_at = ? WHERE user_id = ?").run(new Date().toISOString(), userId);
}

export function recordRunDay(userId: string, day: string): void {
  database().prepare("UPDATE memory_users SET last_run_day = ?, last_attempt_at = NULL WHERE user_id = ?").run(day, userId);
}

// --- themed memories ---

// What's been made (or skipped) before, for deciding what's due.
export function history(userId: string, today: string): History {
  const rows = database().prepare(
    "SELECT theme, theme_key, status, person_id, first_day, last_day, made_on FROM themed_memories WHERE user_id = ?",
  ).all(userId) as Array<{ theme: Theme; theme_key: string; status: string; person_id: string | null; first_day: string | null; last_day: string | null; made_on: string }>;
  const spotlightPeople = new Map<string, string>();
  const trips: Array<{ first: string; last: string }> = [];
  let lastSpotlight: string | null = null;
  let lastPastBigDay: string | null = null;
  let madeToday = 0;
  for (const r of rows) {
    const made = r.status !== "skipped";
    if (made && r.made_on === today) madeToday++;
    if (r.theme === "spotlight") {
      if (made && (!lastSpotlight || r.made_on > lastSpotlight)) lastSpotlight = r.made_on;
      if (r.person_id && (spotlightPeople.get(r.person_id) ?? "") < r.made_on) spotlightPeople.set(r.person_id, r.made_on);
    }
    if (r.theme === "trip") trips.push({ first: r.first_day ?? r.theme_key.slice(5), last: r.last_day ?? r.theme_key.slice(5) });
    // An older big day: made more than a few days after the day itself.
    if (r.theme === "big_day" && r.theme_key.slice(4) < addDays(r.made_on, -7) && (!lastPastBigDay || r.made_on > lastPastBigDay)) {
      lastPastBigDay = r.made_on;
    }
  }
  return { keys: new Set(rows.map((r) => r.theme_key)), madeToday, lastSpotlight, spotlightPeople, lastPastBigDay, trips };
}

// Photos used in this person's themed memories since `since` (an ISO time).
export function recentlyUsed(userId: string, since: string): Set<string> {
  const rows = database().prepare(
    `SELECT a.asset_id FROM themed_memory_assets a JOIN themed_memories m ON m.id = a.themed_memory_id
     WHERE m.user_id = ? AND m.created_at >= ?`,
  ).all(userId, since) as Array<{ asset_id: string }>;
  return new Set(rows.map((r) => r.asset_id));
}

// A theme due tonight, as recorded: which, its key, whose (Spotlight) and the days it covers.
export type Due = { userId: string; theme: Theme; key: string; personId: string | null; firstDay: string | null; lastDay: string | null; madeOn: string };

export type NewThemedMemory = Due & { label: string; score: number; memoryAt: string; showAt: string; hideAt: string; assetIds: string[] };

// Recorded before Immich is asked, with its photos. Call inside atomically().
export function insertPending(m: NewThemedMemory): number {
  const db = database();
  const row = db.prepare(
    `INSERT INTO themed_memories (user_id, theme, theme_key, status, label, person_id, first_day, last_day, score, memory_at, show_at, hide_at, made_on, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(
    m.userId, m.theme, m.key, m.label, m.personId, m.firstDay, m.lastDay, m.score, m.memoryAt, m.showAt, m.hideAt, m.madeOn, new Date().toISOString(),
  ) as { id: number };
  const add = db.prepare("INSERT OR IGNORE INTO themed_memory_assets (themed_memory_id, asset_id) VALUES (?, ?)");
  for (const id of m.assetIds) add.run(row.id, id);
  return row.id;
}

// Due, but too few good photos: not tried again (the key), and counted for its cooldown.
export function insertSkipped(d: Due): void {
  database().prepare(
    `INSERT OR IGNORE INTO themed_memories (user_id, theme, theme_key, status, person_id, first_day, last_day, made_on, created_at)
     VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?, ?)`,
  ).run(d.userId, d.theme, d.key, d.personId, d.firstDay, d.lastDay, d.madeOn, new Date().toISOString());
}

export function markCreated(id: number, memoryId: string): void {
  database().prepare("UPDATE themed_memories SET status = 'created', memory_id = ? WHERE id = ?").run(memoryId, id);
}

// Immich may or may not have made it (no answer): never tried again.
export function markFailed(id: number): void {
  database().prepare("UPDATE themed_memories SET status = 'failed' WHERE id = ?").run(id);
}

// Immich clearly refused: forgotten, so it can be tried again on a later night.
export function forget(id: number): void {
  database().prepare("DELETE FROM themed_memories WHERE id = ?").run(id);
}

export function themedMemories(userId: string, limit: number): ThemedMemoryRow[] {
  return database().prepare(
    "SELECT * FROM themed_memories WHERE user_id = ? AND status = 'created' ORDER BY show_at DESC, id DESC LIMIT ?",
  ).all(userId, limit) as ThemedMemoryRow[];
}
