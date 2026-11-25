// The creations queue's rules, run in this process against a database of its own: the weekly
// pick and its limits, the night captions' hours, and the date a creation carries.
// Run: npm test

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Candidate, Theme } from "../src/types/memories.types.ts";

const dataDir = mkdtempSync(join(tmpdir(), "creations-queue-test-"));
Object.assign(process.env, {
  GEMINI_API_KEY: "unused", DATA_DIR: dataDir, MEMENTO_SECRET: randomBytes(32).toString("base64"),
  LIMITS_TIMEZONE: "Asia/Kolkata", RENDER_QUIET_HOURS: "22:00-06:30",
});
const { itemsFor, proposalFor, proposeCreations, queueWeekly, stampFor } = await import("../src/services/creations.service.ts");
const { creationsNow } = await import("../src/services/creations-now.service.ts");
const { cardAssets, propose, queueExtraCard } = await import("../src/services/repositories/creations.repository.ts");
const { THEME_RANK } = await import("../src/constants/creations.constants.ts");
// One kind proposed for a memory, as a themed memory's run would.
const proposeKind = (userId: string, themedMemoryId: number, kind: "collage" | "recap" | "animation" | "cinematic", memory: Parameters<typeof proposalFor>[1], score: number) =>
  propose(userId, themedMemoryId, kind, proposalFor(kind, memory, "trip")!, score);
const { fitsBeforeQuiet, inQuietHours, markRunDone, rendersMayStart, today } = await import("../src/services/schedule.service.ts");
const { insertPending, markCreated, setCreationsChoice } = await import("../src/services/repositories/memories.repository.ts");
const { database, closeDatabase } = await import("../src/db/database.ts");

after(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

let n = 0;
function photo(over: Partial<Candidate> = {}): Candidate {
  const takenAt = Date.parse("2026-10-20T03:30:00Z") + n++ * 3_600_000;
  const local = new Date(takenAt + 5.5 * 3_600_000).toISOString();
  return {
    id: randomUUID(), isImage: true, takenAt, localDateTime: local, day: local.slice(0, 10), isFavorite: false, rating: null, durationMs: null,
    fileName: "PXL.jpg", mime: "image/jpeg", hasCamera: true, megapixels: 12, duplicateId: null, people: [], hiddenPerson: false,
    lat: null, lon: null, city: null, state: null, country: null, shape: "4000x3000", stacked: false, ...over,
  };
}

const memory_ = (userId: string, theme: Theme = "trip") => memory(userId, `${theme}:${randomUUID()}`, "2026-11-05", theme);

function memory(userId: string, key: string, madeOn: string, theme: Theme = "trip", score = 2): number {
  const id = insertPending({
    userId, theme, key, label: "x", personId: null, firstDay: madeOn, lastDay: madeOn, score, memoryAt: "2026-10-20T00:00:00.000Z",
    showAt: "x", hideAt: "x", madeOn, assetIds: [],
  });
  markCreated(id, randomUUID());
  return id;
}

const states = (userId: string) =>
  (database().prepare("SELECT state FROM creation_jobs WHERE user_id = ? ORDER BY id").all(userId) as Array<{ state: string }>).map((r) => r.state);

test("the night captions' hours, across midnight; a job starts only if it ends before them", () => {
  assert.equal(inQuietHours(new Date("2026-11-21T17:00:00Z")), true, "22:30 in India");
  assert.equal(inQuietHours(new Date("2026-11-21T00:30:00Z")), true, "06:00");
  assert.equal(inQuietHours(new Date("2026-11-21T01:30:00Z")), false, "07:00");
  assert.equal(inQuietHours(new Date("2026-11-21T12:00:00Z")), false, "17:30");
  const at2130 = new Date("2026-11-21T16:00:00Z"); // 21:30, half an hour before 22:00
  assert.equal(fitsBeforeQuiet(26 * 60_000, at2130), true);
  assert.equal(fitsBeforeQuiet(31 * 60_000, at2130), false);
  assert.equal(fitsBeforeQuiet(60_000, new Date("2026-11-21T17:00:00Z")), false, "inside them");
});

test("renders wait from the end of the captions' hours until the day's memories run is over", () => {
  const at = (hhmm: string) => new Date(`${today()}T${hhmm}:00+05:30`);
  assert.equal(rendersMayStart(at("06:45")), false, "after the captions, before the 07:05 run");
  assert.equal(rendersMayStart(at("10:00")), false, "the day's run hasn't happened yet");
  markRunDone(today());
  assert.equal(rendersMayStart(at("10:00")), true);
  assert.equal(rendersMayStart(at("23:00")), false, "the captions' hours");
});

test("a creation's date: seconds before the first photo, in its own time zone, at the first place known", () => {
  const first = photo({ localDateTime: "2026-10-20T09:00:00.000Z", takenAt: Date.parse("2026-10-20T03:30:00Z") });
  const placed = photo({ lat: 15.5, lon: 73.8 });
  assert.deepEqual(stampFor([first, placed], 1), { local: "2026-10-20T08:59:59", offset: "+05:30", utc: "2026-10-20T03:29:59.000Z", gps: { lat: 15.5, lon: 73.8 } });
  assert.equal(stampFor([first], 2).local, "2026-10-20T08:59:58", "a collage before the recap");
  const brazil = photo({ localDateTime: "2026-10-20T09:00:00.000Z", takenAt: Date.parse("2026-10-20T12:00:00Z") });
  assert.equal(stampFor([brazil], 1).offset, "-03:00");
});

test("what each kind uses: a collage 2–6 photos, a recap 8–20 photos and up to 4 videos, in time order", () => {
  const photos = Array.from({ length: 24 }, () => photo());
  const videos = Array.from({ length: 6 }, () => photo({ isImage: false, durationMs: 9000, megapixels: 2.1 }));
  const memory = (chosen: Candidate[]) => ({ chosen, quality: new Map() });
  assert.equal(itemsFor("collage", memory(photos)).length, 6);
  assert.equal(itemsFor("collage", memory(photos.slice(0, 5))).length, 4);
  assert.deepEqual(itemsFor("collage", memory(photos.slice(0, 1))), []);
  const recap = itemsFor("recap", memory([...photos, ...videos]));
  assert.deepEqual([recap.filter((c) => c.isImage).length, recap.filter((c) => !c.isImage).length], [20, 4]);
  assert.deepEqual(recap.map((c) => c.takenAt), recap.map((c) => c.takenAt).toSorted((a, b) => a - b));
  assert.deepEqual(itemsFor("recap", memory([...photos.slice(0, 7), ...videos])), [], "fewer than 8 photos");
  const eightK = photo({ isImage: false, durationMs: 9000, megapixels: 33 });
  assert.ok(!itemsFor("recap", memory([...photos, eightK])).includes(eightK), "bigger than 4K");
});

test("a recap's music moods: by its memory's theme; nostalgic once even its newest photo is over a year old; only recaps", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const day = 86_400_000;
  const taken = (daysAgo: number) => Array.from({ length: 10 }, (_, i) => photo({ takenAt: now - daysAgo * day - i * 60_000 }));
  const moods = (theme: Theme, chosen: Candidate[]) => proposalFor("recap", { chosen, quality: new Map() }, theme, now)!.moods;
  assert.deepEqual(moods("trip", taken(10)), ["adventure", "upbeat"]);
  assert.deepEqual(moods("big_day", taken(10)), ["festive", "indian-festive"]);
  assert.deepEqual(moods("month", taken(30)), ["upbeat", "calm"]);
  assert.deepEqual(moods("spotlight", taken(10)), ["calm", "indian-calm"]);
  for (const theme of ["trip", "big_day", "spotlight"] as const) assert.deepEqual(moods(theme, taken(400)), ["nostalgic"], theme);
  assert.deepEqual(moods("spotlight", [...taken(800), ...taken(30)]), ["calm", "indian-calm"], "a Spotlight with recent photos too");
  assert.deepEqual(moods("big_day", taken(364)), ["festive", "indian-festive"], "not quite a year");
  assert.equal("moods" in proposalFor("collage", { chosen: taken(10), quality: new Map() }, "trip", now)!, false, "only a recap has music");
});

test("an animation: the event's best burst from the memory's first photo on, dated at the burst", () => {
  const user = randomUUID();
  setCreationsChoice(user, true);
  const chosen = Array.from({ length: 6 }, () => photo());
  const start = chosen[2]!.takenAt + 60_000;
  const frames = Array.from({ length: 5 }, (_, i) => photo({ takenAt: start + i * 1000, lat: 15.5, lon: 73.8, stacked: i > 0, localDateTime: new Date(start + i * 1000 + 5.5 * 3_600_000).toISOString() }));
  const early = Array.from({ length: 4 }, (_, i) => photo({ takenAt: chosen[0]!.takenAt - 60_000 + i * 1000, isFavorite: true }));
  const memory = { chosen, quality: new Map(), library: [...chosen, ...frames, ...early], never: new Set<string>() };
  assert.deepEqual(itemsFor("animation", memory).map((c) => c.id), frames.map((c) => c.id), "not the favourite burst before the first photo");
  assert.deepEqual(itemsFor("animation", { ...memory, library: chosen }), [], "no burst");
  const m = memory_(user);
  proposeCreations(user, m, "trip", memory, 0);
  const row = database().prepare("SELECT kind, inputs FROM creation_jobs WHERE themed_memory_id = ? AND kind = 'animation'").get(m) as { inputs: string };
  const inputs = JSON.parse(row.inputs);
  assert.deepEqual(inputs.items.map((i: any) => i.id), frames.map((c) => c.id));
  assert.equal(inputs.stamp.utc, new Date(start).toISOString(), "at the burst, not before the memory");
  assert.deepEqual(inputs.stamp.gps, { lat: 15.5, lon: 73.8 });
  assert.deepEqual((database().prepare("SELECT kind FROM creation_jobs WHERE themed_memory_id = ? ORDER BY id").all(m) as any[]).map((r) => r.kind), ["collage", "animation", "cinematic"], "six photos: no recap");
  proposeCreations(user, memory_(user, "spotlight"), "spotlight", memory, 0);
  assert.ok(!(database().prepare("SELECT kind FROM creation_jobs WHERE user_id = ?").all(user) as any[]).some((r, i) => i >= 2 && r.kind === "animation"), "a Spotlight gets none");
});

test("a cinematic photo: the memory's best photo of one or two people (else its best photo), dated at it; every theme gets one", () => {
  const user = randomUUID();
  setCreationsChoice(user, true);
  const mom = { id: "mom", named: true };
  const crowd = photo({ isFavorite: true, rating: 5, people: [mom, { id: "a", named: true }, { id: "b", named: true }] });
  const pair = photo({ people: [mom, { id: "c", named: false }] });
  const best = photo({ isFavorite: true, people: [mom], lat: 15.5, lon: 73.8 });
  const nobody = photo({ isFavorite: true, rating: 5 });
  const clip = photo({ isImage: false, durationMs: 9000, people: [mom] });
  const memory = { chosen: [crowd, pair, best, nobody, clip], quality: new Map() };
  assert.deepEqual(itemsFor("cinematic", memory).map((c) => c.id), [best.id], "one or two people first, then the best of those");
  assert.deepEqual(itemsFor("cinematic", { ...memory, chosen: [crowd, nobody] }).map((c) => c.id), [crowd.id], "no one alone: the best photo");
  assert.deepEqual(itemsFor("cinematic", { ...memory, chosen: [clip] }), [], "never a video");
  const m = memory_(user, "spotlight");
  proposeCreations(user, m, "spotlight", memory, 0);
  const row = database().prepare("SELECT inputs FROM creation_jobs WHERE themed_memory_id = ? AND kind = 'cinematic'").get(m) as { inputs: string };
  const inputs = JSON.parse(row.inputs);
  assert.deepEqual(inputs.items, [{ id: best.id, image: true }]);
  assert.equal(inputs.stamp.utc, new Date(best.takenAt).toISOString(), "at its photo, among the memory's photos");
  assert.deepEqual(inputs.stamp.gps, { lat: 15.5, lon: 73.8 });
  // Its place is its own photo's only: another of the memory's photos can be another city.
  const nowhere = photo({ people: [mom] });
  const m2 = memory_(user);
  proposeCreations(user, m2, "trip", { chosen: [photo({ lat: 48.85, lon: 2.35 }), nowhere], quality: new Map() }, 0);
  const stampOf = (kind: string) => JSON.parse((database().prepare("SELECT inputs FROM creation_jobs WHERE themed_memory_id = ? AND kind = ?").get(m2, kind) as { inputs: string }).inputs).stamp;
  assert.equal(stampOf("cinematic").gps, null);
  assert.deepEqual(stampOf("collage").gps, { lat: 48.85, lon: 2.35 }, "a collage: the memory's first place");
});

test("weekly: memories only propose; Sunday gives the week's best memory (theme first, then score) a card, once a week", () => {
  const user = randomUUID();
  setCreationsChoice(user, true);
  const photos = Array.from({ length: 14 }, () => photo());
  const bigDay = memory(user, "day:a", "2026-11-03", "big_day", 9);
  const trip = memory(user, "trip:b", "2026-11-05", "trip", 3);
  const betterTrip = memory(user, "trip:c", "2026-11-06", "trip", 4);
  const old = memory(user, "trip:d", "2026-10-20", "trip", 9);
  for (const m of [bigDay, trip, betterTrip, old]) proposeCreations(user, m, "trip", { chosen: photos, quality: new Map() }, 0);
  assert.deepEqual(states(user), Array(12).fill("proposed"), "a collage, a recap and a cinematic photo each");
  assert.equal(queueWeekly(user, "2026-11-07"), 0, "Saturday: nothing");
  assert.equal(queueWeekly(user, "2026-11-08"), 3, "Sunday: one collage, one recap, one cinematic photo");
  assert.deepEqual(states(user), [...Array(6).fill("skipped"), "queued", "queued", "queued", ...Array(3).fill("skipped")], "the better trip's; a big day ranks below a trip");
  const card = database().prepare("SELECT themed_memory_id, week, status FROM creation_cards WHERE user_id = ?").get(user);
  assert.deepEqual({ ...card as object }, { themed_memory_id: betterTrip, week: "2026-11-08", status: "waiting" });
  proposeCreations(user, memory(user, "trip:e", "2026-11-09"), "trip", { chosen: photos, quality: new Map() }, 0);
  assert.equal(queueWeekly(user, "2026-11-10", true), 0, "asked again within the week");
  assert.equal(queueWeekly(user, "2026-11-15"), 3, "next Sunday");
});

test("nothing proposed for someone who turned creations off; a full queue takes no more", () => {
  const off = randomUUID();
  setCreationsChoice(off, false);
  proposeCreations(off, memory(off, "trip:x", "2026-11-05"), "trip", { chosen: Array.from({ length: 6 }, () => photo()), quality: new Map() }, 0);
  assert.deepEqual(states(off), []);

  const busy = randomUUID();
  setCreationsChoice(busy, true);
  const now = new Date().toISOString();
  for (let i = 0; i < 6; i++) {
    database().prepare(
      "INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at) VALUES (?, ?, 'collage', '{}', 'queued', 0, ?, ?, ?)",
    ).run(busy, memory(busy, `trip:q${i}`, "2026-10-01"), now, now, now);
  }
  proposeCreations(busy, memory(busy, "trip:new", "2026-11-05"), "trip", { chosen: Array.from({ length: 6 }, () => photo()), quality: new Map() }, 0);
  assert.equal(queueWeekly(busy, "2026-11-08"), 0, "six waiting already");
  assert.equal(states(busy).at(-1), "proposed");
});

test("by hand, once: this week's missing kinds in one extra card of their own; twice does nothing; the weekly flow untouched", async () => {
  const user = randomUUID();
  setCreationsChoice(user, true);
  const day = "2026-11-22";
  const mom = { id: "mom", named: true };
  const chosen = Array.from({ length: 6 }, (_, i) => photo({ people: i === 2 ? [mom] : [] }));
  const burst = Array.from({ length: 4 }, (_, i) => photo({ takenAt: chosen[1]!.takenAt + 60_000 + i * 1000 }));
  const memoryOf = { chosen, quality: new Map(), library: [...chosen, ...burst], never: new Set<string>() };
  // This morning's card: made before animations and cinematic photos existed (a collage only).
  const trip = memory(user, `trip:${randomUUID()}`, day, "trip", 5);
  proposeKind(user, trip, "collage", memoryOf, 5);
  assert.equal(queueWeekly(user, day), 1);
  // A memory made since, its cinematic photo waiting for next Sunday's pick: left alone.
  const later = memory(user, `day:${randomUUID()}`, day, "big_day", 1);
  const waiting = proposeKind(user, later, "cinematic", memoryOf, 1)!;
  const reads: number[] = [];
  const read = async (m: { id: number }) => (reads.push(m.id), memoryOf);

  const first = await creationsNow(user, day, read);
  assert.ok(first.done && first.card !== null);
  assert.deepEqual({ ...first, card: 0 }, { done: true, memoriesRead: 2, proposed: 3, queued: 2, card: 0 });
  const card = database().prepare("SELECT * FROM creation_cards WHERE id = ?").get(first.card) as any;
  assert.deepEqual([card.extra, card.week, card.status, card.themed_memory_id], [1, day, "waiting", trip]);
  const jobs = database().prepare("SELECT themed_memory_id, kind, state, card_id FROM creation_jobs WHERE user_id = ? ORDER BY id").all(user) as any[];
  assert.deepEqual(jobs.map((j) => [j.themed_memory_id === trip ? "trip" : "later", j.kind, j.state, j.card_id === first.card]), [
    ["trip", "collage", "queued", false],
    ["later", "cinematic", "proposed", false],
    ["later", "animation", "skipped", false],
    ["trip", "animation", "queued", true],
    ["trip", "cinematic", "queued", true],
  ], "the trip's (a trip ranks above a big day); the waiting proposal untouched");
  assert.deepEqual(cardAssets({ ...card, source_memory_at: "" }).photos, [], "only its creations: the week's card showed the photos");
  assert.ok(database().prepare("SELECT id FROM creation_jobs WHERE id = ? AND state = 'proposed'").get(waiting));

  const readsBefore = reads.length;
  assert.deepEqual(await creationsNow(user, day, read), { done: false, reason: "already made this week" });
  assert.equal((database().prepare("SELECT COUNT(*) AS n FROM creation_jobs WHERE user_id = ?").get(user) as any).n, 5);
  assert.equal((database().prepare("SELECT COUNT(*) AS n FROM creation_cards WHERE user_id = ?").get(user) as any).n, 2);
  assert.equal(reads.length, readsBefore, "nothing read again");
});

test("by hand: someone who turned creations off gets nothing, and nothing of theirs is read", async () => {
  const user = randomUUID();
  setCreationsChoice(user, false);
  memory(user, `trip:${randomUUID()}`, "2026-11-22");
  const result = await creationsNow(user, "2026-11-22", async () => {
    throw new Error("read");
  });
  assert.deepEqual(result, { done: false, reason: "creations off" });
  assert.deepEqual(states(user), []);
  assert.equal((database().prepare("SELECT COUNT(*) AS n FROM creation_cards WHERE user_id = ?").get(user) as any).n, 0);
});

test("by hand: Immich failing part-way leaves nothing behind, and running it again works", async () => {
  const user = randomUUID();
  setCreationsChoice(user, true);
  const day = "2026-11-22";
  const chosen = Array.from({ length: 6 }, (_, i) => photo({ people: i === 2 ? [{ id: "mom", named: true }] : [] }));
  const burst = Array.from({ length: 4 }, (_, i) => photo({ takenAt: chosen[1]!.takenAt + 60_000 + i * 1000 }));
  const memoryOf = { chosen, quality: new Map(), library: [...chosen, ...burst], never: new Set<string>() };
  const trip = memory(user, `trip:${randomUUID()}`, day, "trip", 5);
  proposeKind(user, trip, "collage", memoryOf, 5);
  assert.equal(queueWeekly(user, day), 1);
  memory(user, `day:${randomUUID()}`, day, "big_day", 1);
  const jobsOf = () => (database().prepare("SELECT kind, state FROM creation_jobs WHERE user_id = ? ORDER BY id").all(user) as any[]).map((j) => `${j.kind}:${j.state}`);
  const cardsOf = () => (database().prepare("SELECT COUNT(*) AS n FROM creation_cards WHERE user_id = ?").get(user) as any).n;
  const before = jobsOf();
  let reads = 0;
  await assert.rejects(creationsNow(user, day, async () => {
    if (++reads === 2) throw new Error("Immich didn't answer");
    return memoryOf;
  }), /didn't answer/);
  assert.deepEqual(jobsOf(), before, "no proposal saved from the first memory read");
  assert.equal(cardsOf(), 1);
  const again = await creationsNow(user, day, async () => memoryOf);
  assert.ok(again.done && again.queued === 2 && again.card !== null);
  assert.equal(cardsOf(), 2);
});

test("by hand: a memory that got a job of that kind meanwhile passes its turn to the next-best memory", () => {
  const user = randomUUID();
  setCreationsChoice(user, true);
  const day = "2026-11-22";
  const chosen = Array.from({ length: 6 }, (_, i) => photo({ people: i === 2 ? [{ id: "mom", named: true }] : [] }));
  const burst = Array.from({ length: 4 }, (_, i) => photo({ takenAt: chosen[1]!.takenAt + 60_000 + i * 1000 }));
  const memoryOf = { chosen, quality: new Map(), library: [...chosen, ...burst], never: new Set<string>() };
  const trip = memory(user, `trip:${randomUUID()}`, day, "trip", 5);
  const bigDay = memory(user, `day:${randomUUID()}`, day, "big_day", 1);
  const inputs = proposalFor("animation", memoryOf, "trip")!;
  // Between reading and saving, the trip (the best-ranked) got an animation of its own.
  proposeKind(user, trip, "animation", memoryOf, 5);
  const made = queueExtraCard(user, [
    { memory: { id: trip, theme: "trip", score: 5 } as any, kind: "animation", inputs },
    { memory: { id: bigDay, theme: "big_day", score: 1 } as any, kind: "animation", inputs },
  ], day, THEME_RANK);
  assert.equal(made.queued, 1, "the big day's animation instead");
  const queued = database().prepare("SELECT themed_memory_id FROM creation_jobs WHERE card_id = ?").all(made.card) as any[];
  assert.deepEqual(queued.map((j) => j.themed_memory_id), [bigDay]);
});
