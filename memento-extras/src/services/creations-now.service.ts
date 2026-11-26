// By hand, once (scripts/creations-now.ts): this week's new kinds of creation for someone whose Sunday card was made before they existed. Proposes as a themed memory does and queues the best of each kind through the normal queue, in one extra card. Nothing is saved until the end, so a run that fails part-way can be run again.

import { KINDS_FOR, THEME_RANK, WEEKLY } from "../constants/creations.constants.ts";
import { immediately } from "../db/database.ts";
import { creationsWanted, type MemoryForCreations, proposalFor, queueFull } from "./creations.service.ts";
import { candidatesFor } from "./memories.service.ts";
import { readKey } from "./memory-key.service.ts";
import {
  cardSince, creationAssetIds, type ExtraProposal, hasJob, kindsCarded, type MadeMemory, memoriesMadeSince, memoryAssetIds, qualityOf,
  queueExtraCard,
} from "./repositories/creations.repository.ts";
import type { CreationKind } from "../types/creations.types.ts";
import { addDays } from "../utils/local-date.ts";

const NEW_KINDS: CreationKind[] = ["animation", "cinematic"];
const ANIMATION_DAYS = 30;

// A memory's photos again, as its creations need them, or null if none can be read.
export type ReadMemory = (memory: MadeMemory) => Promise<MemoryForCreations | null>;

export type NowResult =
  | { done: false; reason: "creations off" | "already made this week" | "nothing missing" | "queue full" | "no working key" }
  | { done: true; memoriesRead: number; proposed: number; queued: number; card: number | null };

// Reads a memory's photos from Immich with the person's own key, as the day's run read them (memories.service.ts).
function fromImmich(userId: string): ReadMemory | null {
  const key = readKey(userId);
  if ("reason" in key) return null;
  return async (m) => {
    const scope = m.theme === "spotlight"
      ? (m.person_id ? { personId: m.person_id } : null)
      : (m.first_day && m.last_day ? { first: m.first_day, last: m.last_day } : null);
    if (!scope) return null;
    const library = await candidatesFor(key.cred, userId, scope);
    const ids = new Set(memoryAssetIds(m.id));
    const chosen = library.filter((c) => ids.has(c.id) && !c.stacked).sort((a, b) => a.takenAt - b.takenAt);
    if (chosen.length === 0) return null;
    return { chosen, quality: qualityOf(library.map((c) => c.id)), library, never: creationAssetIds(userId) };
  };
}

export async function creationsNow(userId: string, today: string, read?: ReadMemory): Promise<NowResult> {
  if (!creationsWanted(userId)) return { done: false, reason: "creations off" };
  const since = addDays(today, -(WEEKLY.days - 1));
  if (cardSince(userId, since, true)) return { done: false, reason: "already made this week" };
  const had = kindsCarded(userId, since);
  const kinds = NEW_KINDS.filter((k) => !had.has(k));
  if (kinds.length === 0) return { done: false, reason: "nothing missing" };
  if (queueFull(userId)) return { done: false, reason: "queue full" };
  const reader = read ?? fromImmich(userId);
  if (!reader) return { done: false, reason: "no working key" };

  // Every memory read, and what each kind would be made from worked out; nothing saved yet.
  const proposals: ExtraProposal[] = [];
  let memoriesRead = 0;
  const consider = async (m: MadeMemory, wanted: CreationKind[]) => {
    const todo = wanted.filter((k) => KINDS_FOR[m.theme].includes(k) && !hasJob(m.id, k));
    if (todo.length === 0) return;
    const memory = await reader(m);
    memoriesRead++;
    if (!memory) return;
    for (const kind of todo) {
      const inputs = proposalFor(kind, memory, m.theme);
      if (inputs) proposals.push({ memory: m, kind, inputs });
    }
  };
  const week = memoriesMadeSince(userId, since);
  for (const m of week) await consider(m, kinds);
  // No burst among this week's memories: the most recent one of the last few weeks that has one.
  const older = memoriesMadeSince(userId, addDays(today, -(ANIMATION_DAYS - 1))).filter((m) => !week.some((w) => w.id === m.id));
  for (const m of older) {
    if (!kinds.includes("animation") || proposals.some((p) => p.kind === "animation")) break;
    await consider(m, ["animation"]);
  }

  const made = immediately(() => (cardSince(userId, since, true) ? null : queueExtraCard(userId, proposals, today, THEME_RANK)));
  if (!made) return { done: false, reason: "already made this week" };
  return { done: true, memoriesRead, proposed: proposals.length, queued: made.queued, card: made.card };
}
