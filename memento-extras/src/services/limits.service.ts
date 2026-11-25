// Limits on AI edits: a slot is reserved BEFORE Google is called, in one write-locked
// transaction, so two edits at the same moment can't both slip under the limit. Failed
// attempts don't count. The limits themselves are feature flags (flags.service.ts), so an
// admin can change them in the admin panel; DAILY_LIMIT_PER_USER and MONTHLY_LIMIT_TOTAL are
// their defaults. An admin can also set one person's daily limit (Memento admin in the app).
// The edit log is kept by repositories/limits.repository.ts.

import { config } from "../config.ts";
import { immediately } from "../db/database.ts";
import { getFlags } from "./flags.service.ts";
import {
  addReservedEdit, editsBetween, editsByPerson, editsOn, finishEdit, ownDailyLimit, ownDailyLimits, removeOwnDailyLimit,
  saveOwnDailyLimit,
} from "./repositories/limits.repository.ts";
import type { EveryonesUsage, Usage } from "../types/limits.types.ts";
import { dayIn } from "../utils/local-date.ts";

// Today, and this month's first and last day, in the limits' time zone.
function today(): { day: string; monthFrom: string; monthTo: string } {
  const day = dayIn(new Date(), config.timeZone);
  return { day, monthFrom: `${day.slice(0, 7)}-01`, monthTo: `${day.slice(0, 7)}-31` };
}

const usd = (amount: number) => Math.round(amount * 100) / 100;

export function usage(userId: string): Usage {
  const { day, monthFrom, monthTo } = today();
  const month = editsBetween(monthFrom, monthTo);
  const { dailyLimitPerUser, monthlyLimitTotal } = getFlags().gemini;
  return {
    today: { used: editsOn(userId, day), limit: ownDailyLimit(userId) ?? dailyLimitPerUser },
    thisMonth: { used: month.count, limit: monthlyLimitTotal, estimatedCostUsd: usd(month.costUsd) },
  };
}

// Everyone's AI edits, for Memento admin: each person who edited this month or has their own
// limit, and the month's total against the server's limit.
export function everyonesUsage(): EveryonesUsage {
  const { day, monthFrom, monthTo } = today();
  const rows = editsByPerson(day, monthFrom, monthTo);
  const own = ownDailyLimits();
  const { dailyLimitPerUser, monthlyLimitTotal } = getFlags().gemini;
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const users = [...new Set([...byUser.keys(), ...own.keys()])].map((userId) => {
    const row = byUser.get(userId);
    return {
      userId, today: row?.today ?? 0, thisMonth: row?.thisMonth ?? 0, costUsd: usd(row?.costUsd ?? 0),
      dailyLimit: own.get(userId) ?? dailyLimitPerUser, ownDailyLimit: own.get(userId) ?? null,
    };
  });
  const total = rows.reduce((sum, r) => ({ used: sum.used + r.thisMonth, cost: sum.cost + r.costUsd }), { used: 0, cost: 0 });
  return { users, month: { used: total.used, limit: monthlyLimitTotal, costUsd: usd(total.cost) }, defaultDailyLimit: dailyLimitPerUser };
}

// Sets one person's daily limit (checked by the caller against the daily limit flag's
// range), or back to everyone's default with null.
export function setOwnDailyLimit(userId: string, dailyEdits: number | null, adminUserId: string): void {
  if (dailyEdits === null) removeOwnDailyLimit(userId);
  else saveOwnDailyLimit(userId, dailyEdits, adminUserId);
}

// Returns null if a slot was reserved, or the reason it wasn't. `model`: the provider's, recorded
// with the edit.
export function reserve(id: string, userId: string, assetId: string, promptChars: number, model: string): string | null {
  const { day } = today();
  return immediately(() => {
    const now = usage(userId);
    if (now.today.used >= now.today.limit) return `You've reached today's limit of ${now.today.limit} AI edits. It resets at midnight.`;
    if (now.thisMonth.used >= now.thisMonth.limit) return `This server's monthly limit of ${now.thisMonth.limit} AI edits is used up.`;
    addReservedEdit({ id, userId, assetId, day, model, promptChars });
    return null;
  });
}

// costUsd: the estimated price of this edit (by size), or 0 if it failed.
export function finish(id: string, ok: boolean, durationMs: number, costUsd: number): void {
  finishEdit(id, ok ? "done" : "failed", ok ? costUsd : 0, durationMs);
}
