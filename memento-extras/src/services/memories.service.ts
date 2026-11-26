// Themed memories: Spotlight on a person, Best of last month, trips and big days, made each morning for everyone who turned them on, and shown with Immich's own memories in every app. Each is a normal Immich "on this day" memory (POST /api/memories) with its label kept here (GET /memories/labels). Off (the themedMemories flag) stops the day's runs; nothing is deleted. Logs carry ids, themes and counts only.

import { createMemory, deleteApiKey, ImmichRefused } from "../clients/immich.client.ts";
import { config } from "../config.ts";
import {
  BIG_DAY, CARD_SHOW_DAYS, KEY_BROKEN, LIMITS, MANUAL_RUN_MINUTES, MAX_NEW_PER_DAY, MEMORIES_OFF, MONTH, PICK, RETRY_MINUTES, SHOW_DAYS, SPOTLIGHT, TRIP,
} from "../constants/memories.constants.ts";
import { atomically } from "../db/database.ts";
import { kickWorker, proposeCreations, queueWeekly } from "./creations.service.ts";
import { getFlags } from "./flags.service.ts";
import { ensureKey, keyProblem, readKey } from "./memory-key.service.ts";
import { candidatesForDays, candidatesForPerson, loadAllCounts, loadRecent, loadSpotlightPeople } from "./memory-library.service.ts";
import { pickPhotos, score, usable } from "./memory-picks.service.ts";
import { runBudget, qualityFor } from "./memory-quality.service.ts";
import { duePlans, labelFor, memoryDates, pastBigDayDue, spotlightDue } from "./memory-themes.service.ts";
import { cardsOf, creationAssetIds } from "./repositories/creations.repository.ts";
import {
  clearMemoryKey, type Due, forget, history, insertPending, insertSkipped, markCreated, markFailed, memoryUser, pauseMemories, recentlyUsed,
  recordAttempt, recordRunDay, setCreationsChoice, themedMemories, usersDue,
} from "./repositories/memories.repository.ts";
import { inQuietHours, markRunDone, runTimeReached, today, withRunLock } from "./schedule.service.ts";
import type { Credential, User } from "../types/immich.types.ts";
import type { Quality } from "../types/creations.types.ts";
import type { Candidate, MemorySettings, Plan, RunOptions, RunSummary, SettingsChange, ThemedMemory } from "../types/memories.types.ts";
import { secretConfigured } from "../utils/crypto-box.ts";
import { HttpError } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";
import { addDays, daysBetween, startOfDay } from "../utils/local-date.ts";

const lastManualRun = new Map<string, number>();

// Looks every few minutes whether the day's run is due.
export function startThemedMemories(): void {
  if (config.memoriesCheckSeconds === 0) return;
  const tick = () => {
    dailyPass().catch((error: unknown) => log({ event: "themed_memories_pass_failed", error: error instanceof Error ? error.message : String(error) }));
  };
  setTimeout(tick, Math.min(60, config.memoriesCheckSeconds) * 1000).unref();
  setInterval(tick, config.memoriesCheckSeconds * 1000).unref();
}

// Everyone whose run for today hasn't happened, one at a time. Skipped while switched off, and while another run is going.
export async function dailyPass(): Promise<void> {
  if (!runTimeReached()) return;
  const day = today();
  if (!getFlags().themedMemories.enabled || !secretConfigured()) return markRunDone(day);
  const done = await withRunLock(async () => {
    const retryBefore = new Date(Date.now() - RETRY_MINUTES * 60_000).toISOString();
    for (const userId of usersDue(day, retryBefore)) await runForUser(userId, day);
  });
  if (done === null) return;
  markRunDone(day);
  kickWorker();
}

// --- One person's run ---

// Makes what's due today for one person. Never throws: problems are logged. Called under the run lock.
async function runForUser(userId: string, day: string): Promise<RunSummary> {
  const summary: RunSummary = { day, made: [], skipped: [], creationsQueued: 0 };
  const read = readKey(userId);
  if ("reason" in read) {
    if (read.reason !== "off") pauseMemories(userId, read.reason);
    return summary;
  }
  recordAttempt(userId);
  const started = Date.now();
  try {
    await makeThemedMemories(userId, read.cred, day, summary);
    summary.creationsQueued = queueWeekly(userId, day);
    recordRunDay(userId, day);
    log({
      event: "themed_memories_run", user: userId, day, made: summary.made.length, themes: summary.made.map((m) => m.theme),
      skipped: summary.skipped.length, ms: Date.now() - started,
    });
  } catch (error) {
    if (keyProblem(error)) {
      pauseMemories(userId, KEY_BROKEN);
      log({ event: "themed_memories_paused", user: userId, reason: "key rejected" });
    } else {
      log({ event: "themed_memories_failed", user: userId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}

function photoCount(plan: Plan): number {
  switch (plan.theme) {
    case "trip": return Math.min(TRIP.maxCount, 8 + 4 * (daysBetween(plan.first, plan.last) + 1));
    case "month": return MONTH.count;
    case "big_day": return BIG_DAY.count;
    case "spotlight": return SPOTLIGHT.count;
  }
}

// Everything a memory can be made from (stacked photos too). Also read by creations-now.service.ts.
export async function candidatesFor(cred: Credential, userId: string, scope: { personId: string } | { first: string; last: string }): Promise<Candidate[]> {
  return "personId" in scope
    ? candidatesForPerson(cred, userId, scope.personId)
    : candidatesForDays(cred, userId, scope.first, scope.last, config.timeZone);
}

// The stretch of time a memory's photos are spread across.
function span(plan: Plan, all: Candidate[]): { start: number; end: number } {
  if (plan.theme === "spotlight") {
    const start = all.reduce((t, c) => Math.min(t, c.takenAt), Infinity);
    const end = all.reduce((t, c) => Math.max(t, c.takenAt), -Infinity);
    return { start, end: end + 1 };
  }
  return { start: startOfDay(plan.first, config.timeZone), end: startOfDay(addDays(plan.last, 1), config.timeZone) };
}

async function makeThemedMemories(userId: string, cred: Credential, day: string, summary: RunSummary): Promise<void> {
  const past = history(userId, day);
  if (past.madeToday >= MAX_NEW_PER_DAY) return;

  const { items, months } = await loadRecent(cred, userId, day);
  const people = spotlightDue(past, day) ? await loadSpotlightPeople(cred) : undefined;
  const olderCounts = pastBigDayDue(past, day) ? await loadAllCounts(cred, userId, months, items, day) : undefined;
  const plans = duePlans({ today: day, items, olderCounts, people, history: past });
  if (plans.length === 0) return;

  const never = creationAssetIds(userId);
  const avoid = recentlyUsed(userId, new Date(Date.now() - PICK.cooldownDays * 86_400_000).toISOString());
  const budget = runBudget();
  let made = past.madeToday;
  for (const plan of plans.slice(0, LIMITS.plansTried)) {
    if (made >= MAX_NEW_PER_DAY) break;
    const due = dueOf(userId, plan, day);
    const library = await candidatesFor(cred, userId, plan.theme === "spotlight" ? { personId: plan.person.id } : plan);
    const all = library.filter((c) => !c.stacked);
    const focusPersonId = plan.theme === "spotlight" ? plan.person.id : undefined;
    const quality: Map<string, Quality> = all.length > 0 && !inQuietHours() ? await qualityFor(cred, all, { avoid, never, focusPersonId }, budget) : new Map();
    const chosen = all.length > 0 ? pickPhotos(all, { count: photoCount(plan), ...span(plan, all), avoid, never, focusPersonId, quality }) : [];
    if (chosen.length === 0) {
      insertSkipped(due);
      summary.skipped.push({ theme: plan.theme, reason: "too few good photos" });
      continue;
    }
    const label = labelFor(plan, all, day);
    const memoryScore = chosen.reduce((sum, c) => sum + score(c, focusPersonId, quality.get(c.id)), 0) / chosen.length;
    const published = await publish(due, cred, chosen, label, memoryScore);
    if (!published) {
      summary.skipped.push({ theme: plan.theme, reason: "Immich refused it" });
      continue;
    }
    made++;
    for (const c of chosen) avoid.add(c.id);
    const videos = all.filter((c) => !c.isImage && !never.has(c.id) && usable(c, quality.get(c.id)));
    proposeCreations(userId, published.rowId, plan.theme, { chosen, quality, videos, library, never }, memoryScore);
    summary.made.push({ memoryId: published.memoryId, theme: plan.theme, label, assets: chosen.length });
  }
}

// A plan as recorded: its key, whose (Spotlight) and the days it covers.
function dueOf(userId: string, plan: Plan, day: string): Due {
  const days = plan.theme === "spotlight" ? { firstDay: null, lastDay: null } : { firstDay: plan.first, lastDay: plan.last };
  return { userId, theme: plan.theme, key: plan.key, personId: plan.theme === "spotlight" ? plan.person.id : null, ...days, madeOn: day };
}

// Creates the memory in Immich and records it.
async function publish(due: Due, cred: Credential, chosen: Candidate[], label: string, score: number): Promise<{ memoryId: string; rowId: number } | null> {
  const dates = memoryDates(chosen[0]!.day, due.madeOn, SHOW_DAYS[due.theme]);
  const assetIds = chosen.map((c) => c.id);
  const id = atomically(() => insertPending({ ...due, label, score, memoryAt: dates.memoryAt, showAt: dates.showAt, hideAt: dates.hideAt, assetIds }));
  try {
    const memory = await createMemory(cred, {
      type: "on_this_day", data: { year: dates.year }, memoryAt: dates.memoryAt, showAt: dates.showAt, hideAt: dates.hideAt, assetIds, isSaved: false,
    });
    markCreated(id, memory.id);
    log({ event: "themed_memory_created", user: due.userId, memory: memory.id, theme: due.theme, assets: memory.assets });
    return { memoryId: memory.id, rowId: id };
  } catch (error) {
    if (error instanceof ImmichRefused) {
      forget(id);
      return null;
    }
    markFailed(id);
    throw error;
  }
}

// --- What the apps call ---

export function requireThemedMemories(): void {
  if (!getFlags().themedMemories.enabled) throw new HttpError(403, MEMORIES_OFF);
  if (!secretConfigured()) throw new HttpError(503, "Themed memories aren't set up on this server (MEMENTO_SECRET is missing).");
}

export function settingsOf(userId: string): MemorySettings {
  const row = memoryUser(userId);
  return {
    enabled: Boolean(row?.sealed),
    creations: row ? row.creations === 1 : true,
    pausedReason: row?.paused_reason ?? null,
    lastRunDay: row?.last_run_day ?? null,
  };
}

// On: a key (made now if needed). Off: the key is deleted in Immich; memories made stay.
// creations: the person's own choice about collages and videos.
export async function changeSettings(user: User, cred: Credential, change: SettingsChange): Promise<MemorySettings> {
  if (change.enabled === true) {
    requireThemedMemories();
    await ensureKey(user, cred);
  } else if (change.enabled === false) {
    const row = memoryUser(user.id);
    if (row?.key_id) {
      await deleteApiKey(cred, row.key_id, "themed memories").then(
        () => log({ event: "themed_memories_key_deleted", user: user.id, keyId: row.key_id }),
        (error: unknown) => log({ event: "themed_memories_key_delete_failed", user: user.id, error: String(error) }),
      );
    }
    if (row) clearMemoryKey(user.id);
  }
  if (change.creations !== undefined) setCreationsChoice(user.id, change.creations);
  return settingsOf(user.id);
}

// Labels of the person's themed memories and Sunday cards, newest first, for Memento's apps.
export function listThemedMemories(userId: string): ThemedMemory[] {
  const memories = themedMemories(userId, 200).map((r) => ({
    memoryId: r.memory_id!, theme: r.theme, label: r.label!, memoryAt: r.memory_at!, showAt: r.show_at!, hideAt: r.hide_at!,
  }));
  const cards = cardsOf(userId, 50).map((c) => {
    const dates = memoryDates(c.source_memory_at.slice(0, 10), c.week, CARD_SHOW_DAYS);
    return { memoryId: c.memory_id, theme: c.theme, label: c.label, memoryAt: dates.memoryAt, showAt: dates.showAt, hideAt: dates.hideAt };
  });
  return [...memories, ...cards].sort((a, b) => b.showAt.localeCompare(a.showAt));
}

// "Make my memories now": whatever's due today that wasn't made yet. With `creations`, also this week's collage and video now. One run at a time for everyone; each person at most once in MANUAL_RUN_MINUTES.
export async function runNow(user: User, { creations }: RunOptions): Promise<RunSummary> {
  requireThemedMemories();
  const settings = settingsOf(user.id);
  if (!settings.enabled) throw new HttpError(409, "Turn themed memories on first.");
  if (settings.pausedReason) throw new HttpError(409, settings.pausedReason);
  const last = lastManualRun.get(user.id) ?? 0;
  if (Date.now() - last < MANUAL_RUN_MINUTES * 60_000) throw new HttpError(429, `You made your memories a moment ago. Try again in ${MANUAL_RUN_MINUTES} minutes.`);
  const summary = await withRunLock(async () => {
    const day = today();
    const done = await runForUser(user.id, day);
    if (creations) done.creationsQueued += queueWeekly(user.id, day, true);
    return done;
  });
  if (!summary) throw new HttpError(429, "Memories are being made for someone right now. Try again in a minute.");
  lastManualRun.set(user.id, Date.now());
  kickWorker();
  return summary;
}
