// Creations as stored in data.db (tables defined in db/migrations.ts, steps 6–11):
//   creation_jobs   the queue of collages, recap videos, animations and cinematic photos; the record of those made
//   creation_cards  Sunday's memory card with the week's creations
//   asset_quality   each photo's measured sharpness and exposure
//   memory_users    (collages_album_id, recaps_album_id, animations_album_id, cinematic_album_id) each person's four albums
// What they do: services/creations.service.ts, creation-render.service.ts, memory-quality.service.ts.

import { database } from "../../db/database.ts";
import type { CardRow, CreationKind, Job, JobInputs, Quality, WaitingCard } from "../../types/creations.types.ts";
import type { Theme } from "../../types/memories.types.ts";

// --- the queue ---

export function queuedCount(userId?: string): number {
  const sql = "SELECT COUNT(*) AS n FROM creation_jobs WHERE state IN ('queued', 'running')" + (userId ? " AND user_id = ?" : "");
  return (database().prepare(sql).get(...(userId ? [userId] : [])) as { n: number }).n;
}

// What a new themed memory could get; Sunday's pick decides (pickWeek). `rank` is the memory's
// photo score, kept for the record. Returns the new proposal's id, or null if the memory already
// had one of this kind.
export function propose(userId: string, themedMemoryId: number, kind: CreationKind, inputs: JobInputs, rank: number): number | null {
  const now = new Date().toISOString();
  const result = database().prepare(
    `INSERT OR IGNORE INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
  ).run(userId, themedMemoryId, kind, JSON.stringify(inputs), rank, now, now, now);
  return result.changes ? Number(result.lastInsertRowid) : null;
}

// Whether this person got a card on or after the local day `since` (one a week): the week's own
// card, or (`extra`) one made by hand (creationsNow).
export function cardSince(userId: string, since: string, extra = false): boolean {
  return database().prepare("SELECT 1 FROM creation_cards WHERE user_id = ? AND week >= ? AND extra = ?").get(userId, since, extra ? 1 : 0) !== undefined;
}

// The kinds this person's cards since `since` have (made, waiting or dropped).
export function kindsCarded(userId: string, since: string): Set<CreationKind> {
  const rows = database().prepare(
    "SELECT DISTINCT j.kind FROM creation_jobs j JOIN creation_cards c ON c.id = j.card_id WHERE c.user_id = ? AND c.week >= ?",
  ).all(userId, since) as Array<{ kind: CreationKind }>;
  return new Set(rows.map((r) => r.kind));
}

// This person's themed memories made (and in Immich) on or after the local day `since`, newest
// first, with what's needed to read their photos again.
export type MadeMemory = { id: number; theme: Theme; person_id: string | null; first_day: string | null; last_day: string | null; score: number | null };
export function memoriesMadeSince(userId: string, since: string): MadeMemory[] {
  return database().prepare(
    `SELECT id, theme, person_id, first_day, last_day, score FROM themed_memories
     WHERE user_id = ? AND status = 'created' AND made_on >= ? ORDER BY made_on DESC, id DESC`,
  ).all(userId, since) as MadeMemory[];
}

// The photos and videos in a themed memory.
export function memoryAssetIds(themedMemoryId: number): string[] {
  return (database().prepare("SELECT asset_id FROM themed_memory_assets WHERE themed_memory_id = ?").all(themedMemoryId) as Array<{ asset_id: string }>).map((r) => r.asset_id);
}

// Whether a memory already has (or had) a job of this kind, in any state.
export function hasJob(themedMemoryId: number, kind: CreationKind): boolean {
  return database().prepare("SELECT 1 FROM creation_jobs WHERE themed_memory_id = ? AND kind = ?").get(themedMemoryId, kind) !== undefined;
}

// Memories ranked for the week's creations: theme first (`themeRank`), then how good their
// photos are, then the newest. Both picks (pickWeek, queueExtraCard) use it.
function ranked<T extends { id: number; theme: Theme; score: number | null }>(memories: T[], themeRank: Record<Theme, number>): T[] {
  return [...memories].sort((a, b) => themeRank[b.theme] - themeRank[a.theme] || (b.score ?? 0) - (a.score ?? 0) || b.id - a.id);
}

// A new card for this person on `day`, made from a themed memory: the week's own, or (`extra`)
// one made by hand. Returns its id.
function openCard(userId: string, themedMemoryId: number, day: string, extra: boolean): number {
  const now = new Date().toISOString();
  return (database().prepare(
    "INSERT INTO creation_cards (user_id, themed_memory_id, week, status, extra, created_at, updated_at) VALUES (?, ?, ?, 'waiting', ?, ?, ?) RETURNING id",
  ).get(userId, themedMemoryId, day, extra ? 1 : 0, now, now) as { id: number }).id;
}

// Queues these proposals (those still proposed) in a card. Returns how many.
function queueInCard(cardId: number, day: string, jobIds: number[]): number {
  const now = new Date().toISOString();
  const queue = database().prepare(
    "UPDATE creation_jobs SET state = 'queued', card_id = ?, queued_on = ?, next_at = ?, updated_at = ? WHERE id = ? AND state = 'proposed'",
  );
  return jobIds.reduce((n, id) => n + Number(queue.run(cardId, day, now, now, id).changes), 0);
}

// What the card made by hand (creationsNow) could get: a kind of creation for a memory, as
// proposalFor (creations.service.ts) worked it out, not saved yet.
export type ExtraProposal = { memory: MadeMemory; kind: CreationKind; inputs: JobInputs };

// The card made by hand, all or nothing: every proposal is saved, the best memory's of each kind
// (ranked) queued in a new extra card for `today` (made from the best-ranked of them), the
// rest skipped. A memory that has meanwhile got a job of that kind keeps it, untouched, and the
// next-best memory's proposal of that kind is queued instead. Returns the card and how many were
// queued. Call inside immediately().
export function queueExtraCard(userId: string, proposals: ExtraProposal[], today: string, themeRank: Record<Theme, number>): { card: number | null; queued: number } {
  const order = ranked([...new Map(proposals.map((p) => [p.memory.id, p.memory])).values()], themeRank).map((m) => m.id);
  const saved = proposals.map((p) => ({ kind: p.kind, memoryId: p.memory.id, id: propose(userId, p.memory.id, p.kind, p.inputs, p.memory.score ?? 0), picked: false }));
  // The best of each kind among those saved (a proposal not saved, because its memory got a job of
  // that kind in the meantime, passes the turn to the next-ranked one).
  const best = new Set<CreationKind>();
  for (const s of [...saved].sort((a, b) => order.indexOf(a.memoryId) - order.indexOf(b.memoryId))) {
    if (s.id !== null && !best.has(s.kind)) {
      best.add(s.kind);
      s.picked = true;
    }
  }
  // The card is made from (and titled like) the best-ranked memory that supplied something.
  const toQueue = saved.filter((s) => s.picked).sort((a, b) => order.indexOf(a.memoryId) - order.indexOf(b.memoryId));
  let card: number | null = null;
  let queued = 0;
  if (toQueue.length > 0) {
    card = openCard(userId, toQueue[0]!.memoryId, today, true);
    queued = queueInCard(card, today, toQueue.map((s) => s.id!));
  }
  const skip = database().prepare("UPDATE creation_jobs SET state = 'skipped', updated_at = ? WHERE id = ? AND state = 'proposed'");
  const now = new Date().toISOString();
  for (const s of saved) if (!s.picked && s.id !== null) skip.run(now, s.id);
  return { card, queued };
}

// The week's pick, all or nothing: the best memory made on or after the local day `since` that
// has something proposed (ranked) gets a card for `today`, and its proposals are queued for it;
// every other proposal of this person is skipped. Returns how many were queued. Call inside
// atomically().
export function pickWeek(userId: string, since: string, today: string, themeRank: Record<Theme, number>): number {
  const db = database();
  const candidates = db.prepare(
    `SELECT DISTINCT m.id, m.theme, m.score FROM themed_memories m JOIN creation_jobs j ON j.themed_memory_id = m.id
     WHERE m.user_id = ? AND m.status = 'created' AND m.made_on >= ? AND j.state = 'proposed'`,
  ).all(userId, since) as Array<{ id: number; theme: Theme; score: number | null }>;
  const best = ranked(candidates, themeRank)[0];
  let queued = 0;
  if (best) {
    const ids = (db.prepare("SELECT id FROM creation_jobs WHERE themed_memory_id = ? AND state = 'proposed'").all(best.id) as Array<{ id: number }>).map((r) => r.id);
    queued = queueInCard(openCard(userId, best.id, today, false), today, ids);
  }
  db.prepare("UPDATE creation_jobs SET state = 'skipped', updated_at = ? WHERE user_id = ? AND state = 'proposed'").run(new Date().toISOString(), userId);
  return queued;
}

// The oldest job that's due; with `renderedOnly`, the oldest whose render is done (its upload left to retry).
export function nextDue(now: string, renderedOnly = false): Job | undefined {
  const rendered = renderedOnly ? " AND (rendered_at IS NOT NULL OR asset_id IS NOT NULL)" : "";
  return database().prepare(`SELECT * FROM creation_jobs WHERE state = 'queued' AND next_at <= ?${rendered} ORDER BY next_at, id LIMIT 1`).get(now) as Job | undefined;
}

// Counted as an attempt when it starts, so a job that stops the service can't loop forever. Its
// work folder is named once, on its first start, and kept until it's uploaded.
export function markRunning(id: number, workId: string): void {
  database().prepare(
    "UPDATE creation_jobs SET state = 'running', attempts = attempts + 1, work_id = COALESCE(work_id, ?), updated_at = ? WHERE id = ?",
  ).run(workId, new Date().toISOString(), id);
}

// The container finished it (true), or what's in its folder can't be trusted any more (false).
export function markRendered(id: number, rendered: boolean): void {
  database().prepare("UPDATE creation_jobs SET rendered_at = ?, updated_at = ? WHERE id = ?").run(rendered ? new Date().toISOString() : null, new Date().toISOString(), id);
}

export function recordAsset(id: number, assetId: string): void {
  database().prepare("UPDATE creation_jobs SET asset_id = ?, updated_at = ? WHERE id = ?").run(assetId, new Date().toISOString(), id);
}

export function markDone(id: number): void {
  database().prepare("UPDATE creation_jobs SET state = 'done', last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function retryLater(id: number, at: string, error: string): void {
  database().prepare("UPDATE creation_jobs SET state = 'queued', next_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(at, error, new Date().toISOString(), id);
}

// Not done for a reason that isn't the job's (the container busy or down, Immich down): back in
// the queue, the attempt not counted.
export function release(id: number, at: string, reason: string): void {
  database().prepare(
    "UPDATE creation_jobs SET state = 'queued', attempts = attempts - 1, next_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
  ).run(at, reason, new Date().toISOString(), id);
}

export function drop(id: number, error: string): void {
  database().prepare("UPDATE creation_jobs SET state = 'dropped', last_error = ?, updated_at = ? WHERE id = ?").run(error, new Date().toISOString(), id);
}

// At start: jobs a crash left running go back in the queue.
export function requeueRunning(): number {
  return database().prepare("UPDATE creation_jobs SET state = 'queued' WHERE state = 'running'").run().changes as number;
}

// The work folders of jobs still to finish (kept at start; every other folder is a leftover).
export function liveWorkIds(): Set<string> {
  const rows = database().prepare("SELECT work_id FROM creation_jobs WHERE state IN ('queued', 'running') AND work_id IS NOT NULL").all() as Array<{ work_id: string }>;
  return new Set(rows.map((r) => r.work_id));
}

// --- Sunday's cards ---

// Cards waiting whose jobs are all finished and that aren't waiting out a server error: ready to
// become a memory (or not).
export function cardsToFinish(now: string): WaitingCard[] {
  return database().prepare(
    `SELECT c.id, c.user_id, c.week, c.themed_memory_id, c.attempts, c.extra, m.memory_at AS source_memory_at FROM creation_cards c
     JOIN themed_memories m ON m.id = c.themed_memory_id
     WHERE c.status = 'waiting' AND (c.next_at IS NULL OR c.next_at <= ?)
       AND NOT EXISTS (SELECT 1 FROM creation_jobs j WHERE j.card_id = c.id AND j.state IN ('queued', 'running'))`,
  ).all(now) as WaitingCard[];
}

// A server error: one more try counted, the next not before `at`.
export function retryCardLater(id: number, at: string): void {
  database().prepare("UPDATE creation_cards SET attempts = attempts + 1, next_at = ?, updated_at = ? WHERE id = ?").run(at, new Date().toISOString(), id);
}

// What goes in a card: its creations (collage, recap, animation, cinematic photo: those made),
// then its memory's photos (not in an extra card: the week's own card showed them). Immich shows
// them in the order they were taken (each creation's date places it).
export function cardAssets(card: CardRow): { creations: string[]; photos: string[] } {
  const db = database();
  const creations = db.prepare(
    `SELECT asset_id FROM creation_jobs WHERE card_id = ? AND state = 'done' AND asset_id IS NOT NULL
     ORDER BY CASE kind WHEN 'collage' THEN 0 WHEN 'recap' THEN 1 ELSE 2 END, id`,
  ).all(card.id) as Array<{ asset_id: string }>;
  const photos = card.extra ? [] : db.prepare("SELECT asset_id FROM themed_memory_assets WHERE themed_memory_id = ?").all(card.themed_memory_id) as Array<{ asset_id: string }>;
  return { creations: creations.map((r) => r.asset_id), photos: photos.map((r) => r.asset_id) };
}

export function setCard(id: number, status: "created" | "empty" | "late" | "failed", memoryId: string | null = null): void {
  database().prepare("UPDATE creation_cards SET status = ?, memory_id = ?, updated_at = ? WHERE id = ?").run(status, memoryId, new Date().toISOString(), id);
}

// The person's cards in Immich, with the label of the memory each was made from.
export function cardsOf(userId: string, limit: number): Array<CardRow & { memory_id: string; theme: Theme; label: string }> {
  return database().prepare(
    `SELECT c.id, c.user_id, c.week, c.themed_memory_id, c.memory_id, c.extra, m.theme, m.label, m.memory_at AS source_memory_at FROM creation_cards c
     JOIN themed_memories m ON m.id = c.themed_memory_id WHERE c.user_id = ? AND c.status = 'created' ORDER BY c.week DESC LIMIT ?`,
  ).all(userId, limit) as Array<CardRow & { memory_id: string; theme: Theme; label: string }>;
}

// Every collage and video Memento uploaded, for this person or everyone: never a source photo,
// never added to a live album, never captioned.
export function creationAssetIds(userId?: string): Set<string> {
  const rows = database().prepare(`SELECT asset_id FROM creation_jobs WHERE asset_id IS NOT NULL${userId ? " AND user_id = ?" : ""}`)
    .all(...(userId ? [userId] : [])) as Array<{ asset_id: string }>;
  return new Set(rows.map((r) => r.asset_id));
}

// --- photo quality ---

export function qualityOf(assetIds: string[]): Map<string, Quality> {
  const out = new Map<string, Quality>();
  const get = database().prepare("SELECT sharpness, brightness, p2, p98 FROM asset_quality WHERE asset_id = ?");
  for (const id of assetIds) {
    const row = get.get(id) as Quality | undefined;
    if (row) out.set(id, row);
  }
  return out;
}

export function saveQuality(assetId: string, q: Quality): void {
  database().prepare(
    `INSERT INTO asset_quality (asset_id, sharpness, brightness, p2, p98, measured_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (asset_id) DO UPDATE SET sharpness = excluded.sharpness, brightness = excluded.brightness, p2 = excluded.p2,
       p98 = excluded.p98, measured_at = excluded.measured_at`,
  ).run(assetId, q.sharpness, q.brightness, q.p2, q.p98, new Date().toISOString());
}

// --- each person's albums ---

const ALBUM_COLUMN: Record<CreationKind, string> = {
  collage: "collages_album_id", recap: "recaps_album_id", animation: "animations_album_id", cinematic: "cinematic_album_id",
};

export function albumId(userId: string, kind: CreationKind): string | null {
  const row = database().prepare(`SELECT ${ALBUM_COLUMN[kind]} AS id FROM memory_users WHERE user_id = ?`).get(userId) as { id: string | null } | undefined;
  return row?.id ?? null;
}

export function saveAlbumId(userId: string, kind: CreationKind, id: string): void {
  database().prepare(`UPDATE memory_users SET ${ALBUM_COLUMN[kind]} = ? WHERE user_id = ?`).run(id, userId);
}
