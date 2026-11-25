// Choosing a themed memory's photos (FEATURES.md, section 7, "Choose the photos"). Pure: no
// requests, no database, so the tests can feed it made-up photos.
//
//   1. Leave out what doesn't belong in a memory: screenshots and documents (by their details,
//      not their contents), photos with someone the user hid, rejected photos, tiny images,
//      very short or very long videos, creations Memento made itself, photos tucked
//      under another in a stack, and (where measured) blurred or badly exposed shots.
//   2. Score the rest: favourites, star ratings, people you've named, a real camera, size,
//      sharpness where measured.
//   3. Near-identical shots count once: one per moment (an Immich duplicate group, or a burst
//      of shots seconds apart), the best of each. A moment used lately is skipped whole.
//   4. Spread across the event: its time is cut into as many equal parts as photos wanted,
//      and each part gives its best; empty parts are filled by the best of the rest. Picks are
//      kept a minute or two apart, and at most a fifth are videos.
//   5. Moments used in another themed memory lately are only used if too few are left otherwise.
//
// And for an animation, the opposite of 3: the best burst, all of its near-identical shots; for
// a cinematic photo, the one best photo with a clear subject.

import { ANIMATION } from "../constants/creations.constants.ts";
import { CREATION_FILE, NON_CAMERA_TYPES, PICK, QUALITY, SAVED_COPY, SCREENSHOT_NAME } from "../constants/memories.constants.ts";
import type { Quality } from "../types/creations.types.ts";
import type { Candidate, PickOptions } from "../types/memories.types.ts";

// A screenshot, screen recording, document, sticker or forwarded image, from its details only.
export function isScreenshotOrDocument(c: Candidate): boolean {
  if (SCREENSHOT_NAME.test(c.fileName)) return true;
  if (c.hasCamera) return false;
  if (c.mime && NON_CAMERA_TYPES.has(c.mime)) return true;
  // No camera details (WhatsApp strips them, downloads and scans have none): kept only if
  // it's a favourite or someone you named is in it.
  return !(c.isFavorite || c.people.some((p) => p.named));
}

// Clearly blurred, too dark or blown out (only when it was measured and could be read).
export function poorQuality(q: Quality | undefined): boolean {
  if (!q || q.sharpness === null) return false;
  return q.sharpness < QUALITY.blurBelow || q.p98 < QUALITY.darkBelow || q.p2 > QUALITY.blownAbove;
}

// Whether a photo or video can be in a memory at all.
export function usable(c: Candidate, q?: Quality): boolean {
  if (c.hiddenPerson || c.rating === -1 || CREATION_FILE.test(c.fileName) || isScreenshotOrDocument(c) || poorQuality(q)) return false;
  if (c.isImage) return c.megapixels === null || c.megapixels >= PICK.minMegapixels;
  return c.durationMs !== null && c.durationMs >= PICK.videoMinMs && c.durationMs <= PICK.videoMaxMs;
}

export function score(c: Candidate, focusPersonId?: string, q?: Quality): number {
  let s = c.isImage ? 1 : 0.8;
  if (c.isFavorite) s += 3;
  if (c.rating !== null && c.rating >= 3) s += c.rating - 2; // 3★ +1 … 5★ +3
  const named = c.people.filter((p) => p.named).length;
  s += Math.min(named, 3);
  s += Math.min(c.people.length - named, 2) * 0.25; // faces Immich hasn't been told the name of
  if (c.hasCamera) s += 0.5;
  if (c.megapixels !== null && c.megapixels >= 3) s += 0.5;
  if (focusPersonId && c.people.some((p) => p.id === focusPersonId)) {
    if (c.people.length <= 2) s += 1.5; // they're the subject, not one face in a crowd
    else if (c.people.length > 6) s -= 0.5;
  }
  if (q && q.sharpness !== null) {
    // Up to +1.5, on a log scale from just sharp enough to clearly sharp.
    s += 1.5 * Math.min(1, Math.max(0, Math.log(q.sharpness / QUALITY.blurBelow) / Math.log(QUALITY.sharpGood / QUALITY.blurBelow)));
  }
  return s;
}

type Scored = Candidate & { score: number };

// Moments: shots that are really one photo. Two are the same moment if Immich put them in one
// duplicate group, or if one was taken within burstSeconds of the other (a burst, however long).
export function moments(items: Scored[]): Scored[][] {
  const sorted = [...items].sort((a, b) => a.takenAt - b.takenAt || a.id.localeCompare(b.id));
  // Union-find over positions in `sorted`: each moment ends up with one root.
  const parent = sorted.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const join = (a: number, b: number) => {
    parent[root(a)] = root(b);
  };
  const firstOfGroup = new Map<string, number>();
  for (const [i, c] of sorted.entries()) {
    if (i > 0 && c.takenAt - sorted[i - 1]!.takenAt <= PICK.burstSeconds * 1000) join(i, i - 1);
    if (c.duplicateId) {
      const first = firstOfGroup.get(c.duplicateId);
      if (first === undefined) firstOfGroup.set(c.duplicateId, i);
      else join(i, first);
    }
  }
  const groups = new Map<number, Scored[]>();
  for (const [i, c] of sorted.entries()) {
    const group = groups.get(root(i));
    if (group) group.push(c);
    else groups.set(root(i), [c]);
  }
  return [...groups.values()];
}

function better(a: Scored, b: Scored): number {
  return b.score - a.score || a.takenAt - b.takenAt || a.id.localeCompare(b.id);
}

function spread(items: Scored[], { count, start, end }: Pick<PickOptions, "count" | "start" | "end">): Scored[] {
  const picked: Scored[] = [];
  const maxVideos = Math.floor(count * PICK.maxVideoShare);
  let videos = 0;
  const fits = (c: Scored) =>
    (c.isImage || videos < maxVideos) && picked.every((p) => Math.abs(p.takenAt - c.takenAt) >= PICK.minGapSeconds * 1000);
  const take = (c: Scored) => {
    picked.push(c);
    if (!c.isImage) videos++;
  };

  // One part of the event's time per photo wanted; each part gives its best.
  const span = Math.max(end - start, 1);
  const parts: Scored[][] = Array.from({ length: count }, () => []);
  for (const c of items) {
    const i = Math.min(count - 1, Math.max(0, Math.floor(((c.takenAt - start) / span) * count)));
    parts[i]!.push(c);
  }
  for (const part of parts) {
    const best = part.sort(better).find(fits);
    if (best) take(best);
  }
  // Parts with nothing (nights, travel days) leave room: the best of the rest fill it.
  for (const c of [...items].sort(better)) {
    if (picked.length >= count) break;
    if (!picked.includes(c) && fits(c)) take(c);
  }
  return picked.sort((a, b) => a.takenAt - b.takenAt);
}

function unscored({ score: _score, ...c }: Scored): Candidate {
  return c;
}

// The best shot of each moment that can be used, scored; moments used lately only when the
// rest aren't enough.
function bestOfMoments(candidates: Candidate[], options: Omit<PickOptions, "count" | "start" | "end">): Scored[] {
  const pool = candidates
    .filter((c) => !options.never.has(c.id) && usable(c, options.quality?.get(c.id)))
    .map((c) => ({ ...c, score: score(c, options.focusPersonId, options.quality?.get(c.id)) }));
  const all = moments(pool);
  const fresh = all.filter((m) => !m.some((c) => options.avoid.has(c.id)));
  return (fresh.length >= PICK.minCount ? fresh : all).map((m) => m.sort(better)[0]!);
}

// The `n` candidates most worth measuring for quality: the best of each moment by their details.
export function shortlist(candidates: Candidate[], options: Omit<PickOptions, "count" | "start" | "end">, n: number): string[] {
  return bestOfMoments(candidates, { ...options, quality: undefined }).sort(better).slice(0, n).map((c) => c.id);
}

// The memory's photos, oldest first, or [] if there aren't enough good ones.
export function pickPhotos(candidates: Candidate[], options: PickOptions): Candidate[] {
  const chosen = spread(bestOfMoments(candidates, options), options);
  return chosen.length < PICK.minCount ? [] : chosen.map(unscored);
}

// `n` of `items`, evenly spread (they're in time order); all of them if there aren't more.
export function evenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]!);
}

// The frames of an animation: the best burst among `library` (an event's photos, stacked ones
// included), taken at or after `after` (so it plays after its memory's collage and recap), or
// [] if there's none. A burst is a run of photos of one shape (same size, same way up), each
// at most ANIMATION.maxGapSeconds after the one before, in the order taken; of a longer run,
// any stretch within ANIMATION.maxSpanSeconds, and of a stretch with more photos than an
// animation takes, evenly spread across it. Usable as a memory's photos would be (no
// screenshots, Memento's own creations or `never`); a burst with anyone the person hid is left
// out whole; and never an edited copy (SAVED_COPY) or the original it was saved from (same
// time: one photo twice would flicker). The best: its best photo's score, then the most
// photos, then the earliest. Whether the photos really look alike, only the container can tell.
export function animationFrames(library: Candidate[], after: number, never: Set<string>, quality?: Map<string, Quality>): Candidate[] {
  const copies = library.filter((c) => SAVED_COPY.test(c.fileName));
  const editedAt = new Set(copies.map((c) => c.takenAt));
  const photos = library
    .filter((c) => c.isImage && c.shape !== null && c.takenAt >= after && !never.has(c.id) && !editedAt.has(c.takenAt))
    .sort((a, b) => a.takenAt - b.takenAt || a.fileName.localeCompare(b.fileName) || a.id.localeCompare(b.id));
  const runs: Candidate[][] = [];
  for (const [i, c] of photos.entries()) {
    const before = photos[i - 1];
    const joins = before && before.shape === c.shape && c.takenAt - before.takenAt <= ANIMATION.maxGapSeconds * 1000;
    if (joins) runs.at(-1)!.push(c);
    else runs.push([c]);
  }
  let best: { frames: Candidate[]; score: number } | null = null;
  for (const run of runs) {
    if (run.some((c) => c.hiddenPerson)) continue;
    const ok = run.filter((c) => usable(c, quality?.get(c.id)));
    // Every stretch within the span, from each photo on (a later start can only reach further).
    for (let i = 0, end = 0; i < ok.length && end < ok.length; i++) {
      while (end < ok.length && ok[end]!.takenAt - ok[i]!.takenAt <= ANIMATION.maxSpanSeconds * 1000) end++;
      const frames = evenly(ok.slice(i, end), ANIMATION.maxFrames);
      if (frames.length < ANIMATION.minFrames) continue;
      const s = Math.max(...frames.map((c) => score(c, undefined, quality?.get(c.id))));
      if (!best || s > best.score || (s === best.score && frames.length > best.frames.length)) best = { frames, score: s };
    }
  }
  return best?.frames ?? [];
}

// The photo for a cinematic photo: of a memory's photos, the best one with one or two people in
// it (a clear subject to move around), else the best one (the container tells from its depth
// whether it has a subject in front of a background). [] if it has no photos.
export function cinematicPhoto(chosen: Candidate[], quality?: Map<string, Quality>): Candidate[] {
  const ranked = chosen
    .filter((c) => c.isImage)
    .map((c) => ({ c, subject: c.people.length >= 1 && c.people.length <= 2, score: score(c, undefined, quality?.get(c.id)) }))
    .sort((a, b) => Number(b.subject) - Number(a.subject) || b.score - a.score || a.c.takenAt - b.c.takenAt);
  return ranked.length > 0 ? [ranked[0]!.c] : [];
}

// Up to `n` of a memory's photos (or videos) for a collage or recap: the best, spread across
// its time, oldest first.
export function bestSpread(chosen: Candidate[], n: number, images: boolean, quality?: Map<string, Quality>): Candidate[] {
  const pool = chosen.filter((c) => c.isImage === images).map((c) => ({ ...c, score: score(c, undefined, quality?.get(c.id)) }));
  if (n < 1 || pool.length === 0) return [];
  const start = Math.min(...pool.map((c) => c.takenAt));
  const end = Math.max(...pool.map((c) => c.takenAt)) + 1;
  // spread() caps videos at a share of the count: here they're picked on their own.
  const picked = images ? spread(pool, { count: n, start, end }) : [...pool].sort(better).slice(0, n).sort((a, b) => a.takenAt - b.takenAt);
  return picked.map(unscored);
}
