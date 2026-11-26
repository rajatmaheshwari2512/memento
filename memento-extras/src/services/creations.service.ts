// Collages, recap videos, animations and cinematic photos for themed memories. Once a week per person (WEEKLY) the week's best memory gets a card and its proposals are queued; one worker makes queued jobs later, one at a time (creation-render.service.ts).

import { randomUUID } from "node:crypto";
import { CreationsBusy, CreationsUnreachable, ready, RenderUnsuitable } from "../clients/creations.client.ts";
import { createMemory, ImmichRefused, ImmichUnreachable } from "../clients/immich.client.ts";
import { config } from "../config.ts";
import { AROUND_MS, collageSize, KINDS_FOR, QUEUE, RECAP, RECAP_MOODS, THEME_RANK, TIMEOUT_MS, WEEKLY } from "../constants/creations.constants.ts";
import { CARD_SHOW_DAYS } from "../constants/memories.constants.ts";
import { atomically } from "../db/database.ts";
import { JobGone, makeCreation } from "./creation-render.service.ts";
import { getFlags } from "./flags.service.ts";
import { videosWaiting } from "./reduce-noise.service.ts";
import { keyProblem, readKey } from "./memory-key.service.ts";
import { animationFrames, bestSpread, cinematicPhoto } from "./memory-picks.service.ts";
import { memoryDates } from "./memory-themes.service.ts";
import {
  cardAssets, cardSince, cardsToFinish, drop, liveWorkIds, markDone, markRunning, nextDue, pickWeek, propose, queuedCount, release,
  requeueRunning, retryCardLater, retryLater, setCard,
} from "./repositories/creations.repository.ts";
import { memoryUser } from "./repositories/memories.repository.ts";
import { fitsBeforeQuiet, rendersMayStart, today } from "./schedule.service.ts";
import type { CreationKind, CreationStamp, Job, JobInputs, Quality, WaitingCard } from "../types/creations.types.ts";
import type { Candidate, Theme } from "../types/memories.types.ts";
import type { Mood } from "../../creations/src/job.ts";
import { secretConfigured } from "../utils/crypto-box.ts";
import { log } from "../utils/http.ts";
import { addDays } from "../utils/local-date.ts";
import { localDateWithOffset } from "../utils/photo-time.ts";
import { clearWorkFolder, removeJobFolder } from "../utils/work-folder.ts";

let draining = false;
let startup: Promise<unknown> = Promise.resolve();

// At start: jobs a crash left running go back in the queue, leftover folders go, and the worker looks for work every CREATIONS_CHECK_SECONDS.
export function startCreationWorker(): void {
  const requeued = requeueRunning();
  const onError = (name: string, error: unknown) => log({ event: "creations_leftover_kept", name, error: error instanceof Error ? error.message : String(error) });
  startup = clearWorkFolder(liveWorkIds(), onError)
    .then((cleared) => (requeued || cleared) && log({ event: "creations_recovered", requeued, foldersCleared: cleared }))
    .catch((error: unknown) => log({ event: "creations_clear_failed", error: error instanceof Error ? error.message : String(error) }));
  if (config.creationsCheckSeconds === 0) return;
  setInterval(kickWorker, config.creationsCheckSeconds * 1000).unref();
}

// Makes whatever's due now, in the background. Never throws (a failure is logged).
export function kickWorker(): void {
  drain().catch((error: unknown) => log({ event: "creations_worker_failed", error: error instanceof Error ? error.message : String(error) }));
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  const allowed = () => getFlags().creations.enabled && secretConfigured() && rendersMayStart();
  try {
    await startup;
    if (!allowed()) return;
    await finishCards();
    for (let n = 0; n < QUEUE.perDrain && allowed(); n++) {
      // A person's video waiting: only a job whose render is already done (its upload to retry).
      const job = nextDue(new Date().toISOString(), videosWaiting());
      if (!job || !fitsBeforeQuiet(TIMEOUT_MS[job.kind] + AROUND_MS)) return;
      if (!(await runOne(job))) return;
      await finishCards();
    }
  } finally {
    draining = false;
  }
}

function later(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function stop(job: Job, reason: string, fields: Record<string, unknown>): void {
  drop(job.id, reason);
  void removeJobFolder(job.work_id).catch(() => {});
  log({ event: "creation_dropped", ...fields, reason });
}

// Runs one job. False when the worker should stop until its next look.
async function runOne(job: Job): Promise<boolean> {
  const fields = { job: job.id, user: job.user_id, kind: job.kind };
  const unwanted = memoryUser(job.user_id)?.creations !== 1 ? "turned off by its owner"
    : job.attempts >= QUEUE.attempts ? "stopped the service too often"
    : null;
  if (unwanted) {
    stop(job, unwanted, fields);
    return true;
  }
  const key = readKey(job.user_id);
  if ("reason" in key) {
    stop(job, "no working key", fields);
    return true;
  }
  if (!job.asset_id && !job.rendered_at) {
    try {
      await ready();
    } catch (error) {
      if (error instanceof CreationsBusy || error instanceof CreationsUnreachable) return false;
      throw error;
    }
  }
  const workId = job.work_id ?? randomUUID();
  markRunning(job.id, workId);
  const started = Date.now();
  try {
    const asset = await makeCreation({ ...job, work_id: workId }, key.cred);
    markDone(job.id);
    await removeJobFolder(workId);
    log({ event: "creation_done", ...fields, asset, ms: Date.now() - started });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CreationsBusy || error instanceof CreationsUnreachable || error instanceof ImmichUnreachable) {
      release(job.id, later(5), message);
      log({ event: "creation_postponed", ...fields, error: message });
      return false;
    }
    const ran = { ...job, work_id: workId };
    if (error instanceof JobGone || error instanceof RenderUnsuitable) stop(ran, message, fields);
    else if (keyProblem(error)) stop(ran, "key rejected", fields);
    else if (job.attempts + 1 >= QUEUE.attempts) stop(ran, message, { ...fields, attempts: job.attempts + 1 });
    else {
      retryLater(job.id, later(QUEUE.backoffMinutes * 2 ** job.attempts), message);
      log({ event: "creation_failed", ...fields, attempt: job.attempts + 1, error: message });
    }
    return true;
  }
}

// --- Sunday's cards ---

// Every card whose jobs are all finished becomes a memory.
async function finishCards(): Promise<void> {
  for (const card of cardsToFinish(new Date().toISOString())) {
    try {
      await finishCard(card);
    } catch (error) {
      if (error instanceof ImmichUnreachable) return;
      setCard(card.id, "failed");
      log({ event: "creation_card_failed", card: card.id, user: card.user_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function finishCard(card: WaitingCard): Promise<void> {
  const { creations, photos } = cardAssets(card);
  // None made, or the person turned creations off meanwhile: no card.
  if (creations.length === 0 || memoryUser(card.user_id)?.creations !== 1) return setCard(card.id, "empty");
  if (today() > addDays(card.week, CARD_SHOW_DAYS - 1)) return setCard(card.id, "late");
  const key = readKey(card.user_id);
  if ("reason" in key) return setCard(card.id, "failed");
  const dates = memoryDates(card.source_memory_at.slice(0, 10), card.week, CARD_SHOW_DAYS);
  try {
    const memory = await createMemory(key.cred, {
      type: "on_this_day", data: { year: dates.year }, memoryAt: dates.memoryAt, showAt: dates.showAt, hideAt: dates.hideAt,
      assetIds: [...creations, ...photos], isSaved: false,
    });
    setCard(card.id, "created", memory.id);
    log({ event: "creation_card_created", card: card.id, user: card.user_id, memory: memory.id, creations: creations.length });
  } catch (error) {
    if (error instanceof ImmichRefused && error.status < 500) return setCard(card.id, "failed");
    if (error instanceof ImmichRefused) return retryCard(card, error.status);
    throw error;
  }
}

// Immich's own trouble (5xx): tried again after 30, then 60 minutes, then given up.
function retryCard(card: WaitingCard, status: number): void {
  const attempt = card.attempts + 1;
  if (attempt >= QUEUE.attempts) setCard(card.id, "failed");
  else retryCardLater(card.id, later(QUEUE.backoffMinutes * 2 ** card.attempts));
  log({ event: attempt >= QUEUE.attempts ? "creation_card_failed" : "creation_card_postponed", card: card.id, user: card.user_id, status, attempt });
}

// --- Proposals and the weekly pick ---

// `secondsBefore` the first of `chosen`, where it was taken: its wall-clock time and UTC offset there, and the first place among them.
export function stampFor(chosen: Candidate[], secondsBefore: number): CreationStamp {
  const first = chosen[0]!;
  const utc = new Date(first.takenAt - secondsBefore * 1000).toISOString();
  const local = new Date(Date.parse(first.localDateTime) - secondsBefore * 1000).toISOString();
  const withOffset = localDateWithOffset(utc, local); // "2026-10-20T08:59:58.000+05:30"
  const place = chosen.find((c) => c.lat !== null && c.lon !== null);
  return {
    local: withOffset.slice(0, 19), offset: /[+-]\d\d:\d\d$/.exec(withOffset)?.[0] ?? "+00:00", utc,
    gps: place ? { lat: place.lat!, lon: place.lon! } : null,
  };
}

// What a themed memory gives its creations: its photos (oldest first) and their measured quality, the event's other usable videos (`videos`), and for an animation everything the event has (`library`) but never these (`never`).
export type MemoryForCreations = { chosen: Candidate[]; quality: Map<string, Quality>; videos?: Candidate[]; library?: Candidate[]; never?: Set<string> };

// The photos (and, for a recap, videos) a kind of creation would use; none if the memory hasn't enough.
export function itemsFor(kind: CreationKind, { chosen, quality, videos = [], library = [], never = new Set() }: MemoryForCreations): Candidate[] {
  const images = chosen.filter((c) => c.isImage).length;
  switch (kind) {
    case "collage": {
      const n = collageSize(images);
      return n > 0 ? bestSpread(chosen, n, true, quality) : [];
    }
    case "recap": {
      if (images < RECAP.minPhotos) return [];
      const clips = new Map(
        [...chosen, ...videos].filter((c) => !c.isImage && (c.megapixels ?? 0) <= RECAP.maxVideoMegapixels).map((c) => [c.id, c]),
      );
      return [...bestSpread(chosen, RECAP.maxPhotos, true, quality), ...bestSpread([...clips.values()], RECAP.videos, false, quality)]
        .sort((a, b) => a.takenAt - b.takenAt);
    }
    case "animation":
      return chosen.length > 0 ? animationFrames(library, chosen[0]!.takenAt, never, quality) : [];
    case "cinematic":
      return cinematicPhoto(chosen, quality);
  }
}

// When and where each is dated (`memory`: the memory's first place; `own`: its own place).
const DATED: Record<CreationKind, { at: "memory" | "own"; secondsBefore: number }> = {
  collage: { at: "memory", secondsBefore: 2 }, recap: { at: "memory", secondsBefore: 1 },
  animation: { at: "own", secondsBefore: 0 }, cinematic: { at: "own", secondsBefore: 0 },
};

// Whether creations are on, for everyone (the admins' switch) and for this person (their own).
export function creationsWanted(userId: string): boolean {
  return getFlags().creations.enabled && memoryUser(userId)?.creations === 1;
}

// What a new themed memory could get (KINDS_FOR), proposed for Sunday's pick, if creations are wanted.
export function proposeCreations(userId: string, themedMemoryId: number, theme: Theme, memory: MemoryForCreations, score: number): void {
  if (!creationsWanted(userId)) return;
  for (const kind of KINDS_FOR[theme]) {
    const inputs = proposalFor(kind, memory, theme);
    if (inputs) propose(userId, themedMemoryId, kind, inputs, score);
  }
}

// What a kind of creation would be made from for a memory, with the date and place it carries, or null. Nothing is saved.
export function proposalFor(kind: CreationKind, memory: MemoryForCreations, theme: Theme, now = Date.now()): JobInputs | null {
  const items = itemsFor(kind, memory);
  if (items.length === 0) return null;
  const { at, secondsBefore } = DATED[kind];
  return {
    items: items.map((c) => ({ id: c.id, image: c.isImage, ...(c.isImage ? {} : { durationMs: c.durationMs ?? 0 }) })),
    stamp: stampFor(at === "own" ? items : memory.chosen, secondsBefore),
    ...(kind === "recap" ? { moods: recapMoods(theme, memory.chosen, now) } : {}),
  };
}

// A recap's music moods (RECAP_MOODS): its theme's, or nostalgic ones if even the memory's newest photo is over a year before `now` (ms).
function recapMoods(theme: Theme, chosen: Candidate[], now: number): Mood[] {
  const newest = Math.max(...chosen.map((c) => c.takenAt));
  return RECAP_MOODS[now - newest > 365 * 86_400_000 ? "old" : theme];
}

// Whether the queue has no room for this person's creations (QUEUE: theirs, or everyone's).
export function queueFull(userId: string): boolean {
  return queuedCount(userId) >= QUEUE.perUser || queuedCount() >= QUEUE.total;
}

// The weekly pick (WEEKLY): on its day, or when asked (`now`), the week's best memory gets a card and its proposals are queued. Returns how many were queued.
export function queueWeekly(userId: string, day: string, now = false): number {
  if (!now && new Date(`${day}T00:00:00Z`).getUTCDay() !== WEEKLY.weekday) return 0;
  if (!creationsWanted(userId)) return 0;
  if (cardSince(userId, addDays(day, -(WEEKLY.days - 1)))) return 0;
  if (queueFull(userId)) {
    log({ event: "creation_queue_full", user: userId });
    return 0;
  }
  const queued = atomically(() => pickWeek(userId, addDays(day, -WEEKLY.days), day, THEME_RANK));
  if (queued > 0) log({ event: "creation_queued", user: userId, jobs: queued });
  return queued;
}
