// The edit log and per-person daily limits, in data.db (the edits and user_limits tables:
// db/migrations.ts). One row per edit attempt; prompts aren't stored, only their length.
// The rules about them: services/limits.service.ts.

import { database } from "../../db/database.ts";
import type { EditTotals, NewEdit, PersonEditTotals } from "../../types/limits.types.ts";

// What counts as an edit, for the limits and for Memento admin: everything but failed attempts.
const COUNTED = "status != 'failed'";

// One person's counted edits on one day.
export function editsOn(userId: string, day: string): number {
  const row = database().prepare(`SELECT COUNT(*) AS n FROM edits WHERE user_id = ? AND day = ? AND ${COUNTED}`).get(userId, day) as { n: number };
  return row.n;
}

// Everyone's counted edits from one day to another, and their estimated cost.
export function editsBetween(from: string, to: string): EditTotals {
  const row = database()
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM edits WHERE day BETWEEN ? AND ? AND ${COUNTED}`)
    .get(from, to) as { n: number; cost: number };
  return { count: row.n, costUsd: row.cost };
}

// Each person's counted edits from one day to another, with how many were on `day`.
export function editsByPerson(day: string, from: string, to: string): PersonEditTotals[] {
  const rows = database().prepare(`
    SELECT user_id,
           SUM(day = ?) AS today,
           COUNT(*) AS this_month,
           COALESCE(SUM(cost_usd), 0) AS cost
    FROM edits WHERE day BETWEEN ? AND ? AND ${COUNTED}
    GROUP BY user_id
  `).all(day, from, to) as Array<{ user_id: string; today: number; this_month: number; cost: number }>;
  return rows.map((r) => ({ userId: r.user_id, today: r.today, thisMonth: r.this_month, costUsd: r.cost }));
}

// A daily limit set just for this person, or null to follow everyone's default.
export function ownDailyLimit(userId: string): number | null {
  const row = database().prepare("SELECT daily_edits FROM user_limits WHERE user_id = ?").get(userId) as { daily_edits: number } | undefined;
  return row?.daily_edits ?? null;
}

// Every person's own daily limit, by user ID.
export function ownDailyLimits(): Map<string, number> {
  const rows = database().prepare("SELECT user_id, daily_edits FROM user_limits").all() as Array<{ user_id: string; daily_edits: number }>;
  return new Map(rows.map((r) => [r.user_id, r.daily_edits]));
}

export function saveOwnDailyLimit(userId: string, dailyEdits: number, adminUserId: string): void {
  database().prepare(`
    INSERT INTO user_limits (user_id, daily_edits, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET daily_edits = excluded.daily_edits, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(userId, dailyEdits, new Date().toISOString(), adminUserId);
}

export function removeOwnDailyLimit(userId: string): void {
  database().prepare("DELETE FROM user_limits WHERE user_id = ?").run(userId);
}

export function addReservedEdit(edit: NewEdit): void {
  database().prepare(
    "INSERT INTO edits (id, user_id, asset_id, day, created_at, model, status, prompt_chars) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)",
  ).run(edit.id, edit.userId, edit.assetId, edit.day, new Date().toISOString(), edit.model, edit.promptChars);
}

export function finishEdit(id: string, status: "done" | "failed", costUsd: number, durationMs: number): void {
  database().prepare("UPDATE edits SET status = ?, cost_usd = ?, duration_ms = ? WHERE id = ?").run(status, costUsd, durationMs, id);
}
