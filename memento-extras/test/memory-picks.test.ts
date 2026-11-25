// Themed memories' pure parts: choosing photos (memory-picks.service.ts), what's due and the
// labels and dates (memory-themes.service.ts), and the calendar helpers (local-date.ts).
// Run: npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import { animationFrames, evenly, isScreenshotOrDocument, pickPhotos, usable } from "../src/services/memory-picks.service.ts";
import {
  bigDayThreshold, chooseSpotlight, duePlans, findHome, findTrips, labelFor, memoryDates, placeName,
} from "../src/services/memory-themes.service.ts";
import type { Candidate, History, LibraryItem, Plan } from "../src/types/memories.types.ts";
import { addDays, daysFromAnniversary, monthsBetween, startOfDay } from "../src/utils/local-date.ts";

let n = 0;
function photo(over: Partial<Candidate> = {}): Candidate {
  const takenAt = over.takenAt ?? Date.parse("2026-10-10T06:00:00Z") + n * 3_600_000;
  n++;
  const local = new Date(takenAt + 5.5 * 3_600_000).toISOString();
  return {
    id: `p${n}`, isImage: true, takenAt, localDateTime: local, day: local.slice(0, 10), isFavorite: false, rating: null, durationMs: null,
    fileName: `PXL_${n}.jpg`, mime: "image/jpeg", hasCamera: true, megapixels: 12, duplicateId: null, people: [], hiddenPerson: false,
    lat: null, lon: null, city: null, state: null, country: null, shape: "4000x3000", stacked: false, ...over,
  };
}

const none = new Set<string>();
const options = (count: number, from: Candidate[]) => ({
  count, start: Math.min(...from.map((c) => c.takenAt)), end: Math.max(...from.map((c) => c.takenAt)) + 1, avoid: none, never: none,
});

function history(over: Partial<History> = {}): History {
  return { keys: new Set(), madeToday: 0, lastSpotlight: null, spotlightPeople: new Map(), lastPastBigDay: null, trips: [], ...over };
}

test("screenshots and documents are told by their details, not their contents", () => {
  assert.equal(isScreenshotOrDocument(photo({ fileName: "Screenshot_20261012-101010.png", hasCamera: false, mime: "image/png" })), true);
  assert.equal(isScreenshotOrDocument(photo({ fileName: "Screen Shot 2024-01-01 at 10.00.00.png" })), true, "by name, even with camera details");
  assert.equal(isScreenshotOrDocument(photo({ fileName: "image.png", hasCamera: false, mime: "image/png", isFavorite: true })), true, "PNG with no camera");
  assert.equal(isScreenshotOrDocument(photo({ fileName: "IMG-20231012-WA0003.jpg", hasCamera: false })), true, "forward with nobody you know");
  assert.equal(isScreenshotOrDocument(photo({ fileName: "IMG-20231012-WA0004.jpg", hasCamera: false, people: [{ id: "mom", named: true }] })), false);
  assert.equal(isScreenshotOrDocument(photo({ fileName: "IMG-20231012-WA0005.jpg", hasCamera: false, isFavorite: true })), false);
  assert.equal(isScreenshotOrDocument(photo()), false);
});

test("hidden people, rejected photos, tiny images and odd-length videos are left out", () => {
  assert.equal(usable(photo({ hiddenPerson: true })), false);
  assert.equal(usable(photo({ rating: -1 })), false);
  assert.equal(usable(photo({ megapixels: 0.1 })), false);
  assert.equal(usable(photo({ isImage: false, durationMs: 1000 })), false);
  assert.equal(usable(photo({ isImage: false, durationMs: 10 * 60_000 })), false);
  assert.equal(usable(photo({ isImage: false, durationMs: 12_000 })), true);
});

test("one per burst and one per duplicate group, the best of each", () => {
  const base = Date.parse("2026-10-10T06:00:00Z");
  const burst = [0, 4, 8, 12].map((s, i) => photo({ takenAt: base + s * 1000, isFavorite: i === 2 }));
  const dupA = photo({ takenAt: base + 3_600_000, duplicateId: "d1" });
  const dupB = photo({ takenAt: base + 7_200_000, duplicateId: "d1", rating: 5 });
  const others = Array.from({ length: 8 }, (_, i) => photo({ takenAt: base + (3 + i) * 3_600_000 }));
  const all = [...burst, dupA, dupB, ...others];
  const chosen = pickPhotos(all, options(20, all));
  const ids = new Set(chosen.map((c) => c.id));
  assert.deepEqual(burst.filter((b) => ids.has(b.id)).map((b) => b.id), [burst[2]!.id], "the burst's favourite only");
  assert.ok(ids.has(dupB.id) && !ids.has(dupA.id), "the better of the duplicates");
  assert.deepEqual(chosen.map((c) => c.takenAt), [...chosen.map((c) => c.takenAt)].sort((a, b) => a - b), "oldest first");
});

test("picks spread across the event, best first in each part", () => {
  const base = Date.parse("2026-10-20T00:00:00Z");
  // Day 1 has 30 great photos, days 2-4 have 3 ordinary ones each.
  const day1 = Array.from({ length: 30 }, (_, i) => photo({ takenAt: base + i * 600_000, isFavorite: true, rating: 5 }));
  const later = [1, 2, 3].flatMap((d) => [0, 1, 2].map((i) => photo({ takenAt: base + d * 86_400_000 + i * 3_600_000 })));
  const all = [...day1, ...later];
  const chosen = pickPhotos(all, { ...options(8, all), start: base, end: base + 4 * 86_400_000 });
  const days = new Set(chosen.map((c) => Math.floor((c.takenAt - base) / 86_400_000)));
  assert.deepEqual([...days].sort(), [0, 1, 2, 3], "every day of the trip");
  assert.equal(chosen.length, 8);
});

test("at most a fifth videos; too few good photos makes nothing", () => {
  const base = Date.parse("2026-10-20T00:00:00Z");
  const videos = Array.from({ length: 10 }, (_, i) => photo({ takenAt: base + i * 3_600_000, isImage: false, durationMs: 20_000, isFavorite: true }));
  const photos = Array.from({ length: 10 }, (_, i) => photo({ takenAt: base + i * 3_600_000 + 1_800_000 }));
  const chosen = pickPhotos([...videos, ...photos], options(10, [...videos, ...photos]));
  assert.equal(chosen.filter((c) => !c.isImage).length, 2);
  assert.deepEqual(pickPhotos(photos.slice(0, 5), options(10, photos.slice(0, 5))), []);
});

test("recently used photos only when the rest aren't enough; creations and stacked photos never", () => {
  const base = Date.parse("2026-10-20T00:00:00Z");
  const all = Array.from({ length: 12 }, (_, i) => photo({ takenAt: base + i * 3_600_000 }));
  const used = new Set(all.slice(0, 4).map((c) => c.id));
  const never = new Set([all[5]!.id]);
  const chosen = pickPhotos(all, { ...options(12, all), avoid: used, never });
  assert.equal(chosen.length, 7);
  assert.ok(chosen.every((c) => !used.has(c.id) && !never.has(c.id)));
  const tight = pickPhotos(all.slice(0, 8), { ...options(8, all.slice(0, 8)), avoid: used, never });
  assert.ok(tight.some((c) => used.has(c.id)), "used again rather than nothing");
  assert.ok(tight.every((c) => !never.has(c.id)));
});

test("an animation's frames: the best burst, in the order taken, of one shape, from the memory's first photo on", () => {
  const at = (s: number) => Date.parse("2026-10-21T02:30:00Z") + s * 1000;
  const burst = (from: number, count: number, gap: number, over: Partial<Candidate> = {}) =>
    Array.from({ length: count }, (_, i) => photo({ takenAt: at(from + i * gap), fileName: `IMG_${from + i}.jpg`, ...over }));
  const plain = burst(0, 4, 2); // 0–6 s
  const favourite = burst(100, 5, 1, { isFavorite: true });
  const sameSecond = [2, 0, 1].map((i) => photo({ takenAt: at(200), fileName: `BURST_${i}.jpg` })); // a phone's burst: one second, named in order
  const none = new Set<string>();
  assert.deepEqual(animationFrames([...plain, ...favourite], 0, none).map((c) => c.id), favourite.map((c) => c.id), "the favourite's burst");
  assert.deepEqual(animationFrames(sameSecond, 0, none).map((c) => c.fileName), ["BURST_0.jpg", "BURST_1.jpg", "BURST_2.jpg"]);
  assert.deepEqual(animationFrames(plain, 0, none).map((c) => c.id), plain.map((c) => c.id));
  assert.deepEqual(animationFrames(plain, at(3), none), [], "two left from the memory's first photo on");
  assert.equal(animationFrames(burst(300, 4, 1), at(301), none).length, 3, "three is enough");
  assert.deepEqual(animationFrames(burst(400, 4, 6), 0, none), [], "more than 5 s apart: not a burst");
  const mixed = burst(500, 4, 1);
  mixed[2] = { ...mixed[2]!, shape: "3000x4000" }; // turned the other way
  assert.deepEqual(animationFrames(mixed, 0, none), [], "two and one and one");
  const withEx = burst(600, 6, 1);
  withEx[3] = { ...withEx[3]!, hiddenPerson: true };
  assert.deepEqual(animationFrames(withEx, 0, none), [], "someone hidden in one frame: none of it");
  const stacked = burst(700, 5, 1).map((c, i) => ({ ...c, stacked: i > 0 }));
  assert.equal(animationFrames(stacked, 0, none).length, 5, "a stacked burst: all of it");
  const long = burst(800, 30, 0.1);
  assert.deepEqual(animationFrames(long, 0, none).map((c) => c.id), evenly(long, 12).map((c) => c.id), "a long burst: 12, evenly spread");
  const creations = burst(900, 4, 1, { fileName: "memento-collage-20261021-1.jpg" });
  assert.deepEqual(animationFrames(creations, 0, none), []);
  assert.deepEqual(animationFrames(plain, 0, new Set(plain.slice(1).map((c) => c.id))), [], "never: Memento's own");
  assert.deepEqual(animationFrames(burst(1000, 4, 1, { shape: null }), 0, none), [], "shape unknown");
  assert.deepEqual(evenly([1, 2, 3, 4, 5], 3), [1, 3, 5]);
});

test("an animation never shows an edited copy or the original it was saved from; a long series gives its best 12 s", () => {
  const at = (s: number) => Date.parse("2026-10-21T02:30:00Z") + s * 1000;
  const none = new Set<string>();
  const shot = (s: number, fileName: string, over: Partial<Candidate> = {}) => photo({ takenAt: at(s), fileName, ...over });
  // Adjust saved a copy of B (same time, stacked on it): A, B and C would be a burst, but B shows twice.
  const [a, b, c, d] = [shot(0, "IMG_1.jpg"), shot(1, "IMG_2.jpg"), shot(2, "IMG_3.jpg"), shot(3, "IMG_4.jpg")];
  const bEdited = shot(1, "IMG_2-edited.jpg");
  assert.deepEqual(animationFrames([a, bEdited, b, c, d], 0, none).map((x) => x.fileName), ["IMG_1.jpg", "IMG_3.jpg", "IMG_4.jpg"]);
  // One photo edited twice (Adjust, then an AI edit): nothing left to animate.
  const twice = [shot(10, "IMG_9.jpg"), shot(10, "IMG_9-edited.jpg"), shot(10, "IMG_9-ai-edit-1a2b3c4d.jpg")];
  assert.deepEqual(animationFrames(twice, 0, none), []);
  assert.deepEqual(animationFrames([shot(20, "x-ai-edit-1a2b3c4d.jpg"), shot(21, "y.jpg"), shot(22, "z.jpg")], 0, none), [], "a copy is never a frame");
  // 36 shots 3.5 s apart (two minutes): the best 12 seconds of it, not a slideshow.
  const series = Array.from({ length: 36 }, (_, i) => shot(100 + i * 3.5, `S_${String(i).padStart(2, "0")}.jpg`, { isFavorite: i === 20 }));
  const frames = animationFrames(series, 0, none);
  assert.ok(frames.length >= 3 && frames.at(-1)!.takenAt - frames[0]!.takenAt <= 12_000, `${frames.length} over ${(frames.at(-1)!.takenAt - frames[0]!.takenAt) / 1000} s`);
  assert.ok(frames.some((x) => x.isFavorite), "the stretch with the favourite");
});

test("Spotlight: photos where the person is the subject score higher", () => {
  const base = Date.parse("2020-01-01T00:00:00Z");
  const crowd = Array.from({ length: 10 }, (_, i) =>
    photo({ takenAt: base + i * 1000 * 86_400_000 / 10, people: Array.from({ length: 8 }, (_, j) => ({ id: j === 0 ? "mom" : `x${j}`, named: j === 0 })) }));
  const portraits = Array.from({ length: 10 }, (_, i) =>
    photo({ takenAt: base + i * 1000 * 86_400_000 / 10 + 3_600_000, people: [{ id: "mom", named: true }] }));
  const all = [...crowd, ...portraits];
  const chosen = pickPhotos(all, { ...options(10, all), focusPersonId: "mom" });
  assert.ok(chosen.filter((c) => c.people.length === 1).length >= 8);
});

// A made-up library: home in Pune (photos with a location on 12 days), a trip to Goa.
const PUNE = { lat: 18.5204, lon: 73.8567 };
const GOA = { lat: 15.4989, lon: 73.8278 };
function item(day: string, at: { lat: number; lon: number } | null, hour = 10, id = `i${n++}`): LibraryItem {
  return { id, takenAt: Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`), day, isImage: true, isFavorite: false, lat: at?.lat ?? null, lon: at?.lon ?? null, city: null };
}
function homeDays(): LibraryItem[] {
  return Array.from({ length: 12 }, (_, i) => item(`2026-09-${String(i + 1).padStart(2, "0")}`, PUNE));
}

test("home is where most days with a location were; too few and there are no trips", () => {
  const home = findHome(homeDays(), "2026-11-01");
  assert.ok(home && Math.abs(home.lat - PUNE.lat) < 0.01);
  assert.equal(findHome(homeDays().slice(0, 5), "2026-11-01"), null);
});

test("a trip: far-away days, with location-less days in between, over once back home", () => {
  const trip = [item("2026-10-20", GOA), item("2026-10-21", null), item("2026-10-22", GOA), item("2026-10-23", GOA)];
  const back = item("2026-10-24", PUNE, 20);
  const found = findTrips([...homeDays(), ...trip, back], PUNE, "2026-10-25");
  assert.equal(found.length, 1);
  assert.deepEqual([found[0]!.first, found[0]!.last, found[0]!.over], ["2026-10-20", "2026-10-23", true]);
  // Still away (the last far photo yesterday, nothing at home since): not over.
  assert.equal(findTrips([...homeDays(), ...trip], PUNE, "2026-10-24")[0]!.over, false);
});

test("what's due: trip, then Best of last month, then a Spotlight; nothing twice", () => {
  const trip = Array.from({ length: 4 }, (_, d) => Array.from({ length: 5 }, (_, i) => item(`2026-10-2${d}`, i === 0 ? GOA : null, 8 + i))).flat();
  const october = Array.from({ length: 25 }, (_, i) => item(`2026-10-${String((i % 18) + 1).padStart(2, "0")}`, null, 12));
  const items = [...homeDays(), ...trip, ...october, item("2026-10-27", PUNE)];
  const people = [{ id: "mom", name: "Mom", birthDate: null, photos: 80 }, { id: "dad", name: "Dad", birthDate: null, photos: 20 }];
  const plans = duePlans({ today: "2026-11-01", items, people, history: history() });
  assert.deepEqual(plans.map((p) => p.key), ["trip:2026-10-20", "month:2026-10", "spotlight:mom:2026-11-01"]);
  const again = duePlans({ today: "2026-11-02", items, people, history: history({ keys: new Set(["trip:2026-10-20", "month:2026-10"]), lastSpotlight: "2026-11-01" }) });
  assert.deepEqual(again, []);
  assert.deepEqual(duePlans({ today: "2026-11-04", items, history: history() }).map((p) => p.theme), ["trip"], "the 4th: no Best of month");
});

test("a trip is made once, even as the 30-day window slides past its first day", () => {
  const HOME = { lat: 28.61, lon: 77.21 };
  const items: LibraryItem[] = [];
  const add = (day: string, at: { lat: number; lon: number }, count: number) => {
    for (let i = 0; i < count; i++) items.push({ ...item(day, at), takenAt: Date.parse(`${day}T06:00:00Z`) + i * 600_000 });
  };
  for (let d = 0; d < 300; d += 3) add(addDays("2025-10-01", d), HOME, 2);
  for (let d = 0; d < 10; d++) add(addDays("2026-09-01", d), GOA, 15);
  for (let d = 10; d < 60; d += 2) add(addDays("2026-09-01", d), HOME, 2);
  const keys = new Set<string>();
  const trips: Array<{ first: string; last: string }> = [];
  const made: string[] = [];
  for (let back = 11; back <= 45; back++) {
    const today = addDays("2026-09-01", back);
    for (const plan of duePlans({ today, items, history: history({ keys, trips, lastSpotlight: today, lastPastBigDay: today }) })) {
      if (plan.theme !== "trip") continue;
      made.push(`${today} ${plan.first}..${plan.last}`);
      keys.add(plan.key);
      trips.push({ first: plan.first, last: plan.last });
    }
  }
  assert.deepEqual(made, ["2026-09-12 2026-09-01..2026-09-10"]);
});

test("big days: a recent one, and an older one away from its anniversary", () => {
  const busy = (day: string) => Array.from({ length: 40 }, (_, i) => item(day, null, 6 + (i % 12)));
  const quiet = Array.from({ length: 60 }, (_, i) => item(`2026-0${(i % 8) + 1}-1${i % 9}`, null));
  const items = [...quiet, ...busy("2026-10-30")];
  const recent = duePlans({ today: "2026-11-01", items, history: history() }).filter((p) => p.theme === "big_day");
  assert.deepEqual(recent.map((p) => p.key), ["day:2026-10-30"]);
  const counts = new Map([["2024-03-09", 45], ["2023-11-03", 60], ["2025-01-01", 10]]);
  const older = duePlans({ today: "2026-11-05", items: quiet, olderCounts: counts, history: history() });
  assert.deepEqual(older.map((p) => p.key), ["day:2024-03-09"], "3 November is too near its anniversary");
  assert.deepEqual(duePlans({ today: "2026-11-05", items: quiet, olderCounts: counts, history: history({ lastPastBigDay: "2026-11-01" }) }), []);
  assert.equal(bigDayThreshold(new Map([["a", 5]])), 30);
});

test("Spotlight: once a week, the person waits their turn, not near their birthday", () => {
  const people = [
    { id: "mom", name: "Mom", birthDate: "1960-11-08", photos: 300 },
    { id: "dad", name: "Dad", birthDate: null, photos: 100 },
    { id: "zoe", name: "Zoe", birthDate: null, photos: 40 },
  ];
  assert.equal(chooseSpotlight(people, history(), "2026-11-01")?.id, "dad", "Mom's birthday is in a week");
  assert.equal(chooseSpotlight(people, history(), "2026-11-20")?.id, "mom");
  assert.equal(chooseSpotlight(people, history({ lastSpotlight: "2026-11-15" }), "2026-11-20"), null);
  const had = history({ lastSpotlight: "2026-11-01", spotlightPeople: new Map([["mom", "2026-11-01"]]) });
  assert.equal(chooseSpotlight(people, had, "2026-11-20")?.id, "dad");
});

test("labels are short enough for where \"N years ago\" goes", () => {
  const goa = (city: string) => photo({ city, state: "Goa", country: "India" });
  const far = [goa("Panaji"), goa("Calangute"), goa("Margao"), goa("Panaji")];
  const trip: Plan = { theme: "trip", key: "t", first: "2023-10-20", last: "2023-10-23", farIds: new Set(far.map((p) => p.id)) };
  assert.equal(labelFor(trip, far, "2026-11-01"), "Goa trip, 2023");
  const long: Plan = { ...trip, farIds: new Set(["x"]) };
  const kochi = photo({ id: "x", city: "Thiruvananthapuram Corporation" });
  assert.equal(labelFor(long, [kochi], "2026-11-01"), "Thiruvananthapuram Corpor…");
  assert.equal(labelFor({ theme: "month", key: "m", month: "2026-10", first: "2026-10-01", last: "2026-10-31" }, [], "2026-11-01"), "Best of October");
  assert.equal(labelFor({ theme: "month", key: "m", month: "2025-12", first: "2025-12-01", last: "2025-12-31" }, [], "2026-01-01"), "Best of December 2025");
  assert.equal(labelFor({ theme: "big_day", key: "d", first: "2024-10-05", last: "2024-10-05", recent: false }, [], "2026-11-01"), "5 October 2024");
  assert.equal(labelFor({ theme: "big_day", key: "d", first: "2026-10-30", last: "2026-10-30", recent: true }, [photo({ city: "Shillong" })], "2026-11-01"), "A day in Shillong");
  const person = { id: "p", name: "Venkataramanan Subramaniam", birthDate: null, photos: 90 };
  assert.equal(labelFor({ theme: "spotlight", key: "s", person }, [], "2026-11-01"), "Spotlight: Venkataramanan");
  assert.equal(labelFor({ theme: "spotlight", key: "s", person: { ...person, name: "Mom" } }, [], "2026-11-01"), "Spotlight: Mom");
  for (const label of ["Goa trip, 2023", "Best of December 2025"]) assert.ok(label.length <= 26);
  assert.equal(placeName([photo({ city: "A" }), photo({ city: "B" })]), null);
});

test("dates: Immich's convention, and 'N years ago' tells the first photo's true age", () => {
  const trip = memoryDates("2023-12-20", "2026-11-01", 3);
  assert.deepEqual(trip, { memoryAt: "2023-12-20T00:00:00.000Z", showAt: "2026-11-01T00:00:00.000Z", hideAt: "2026-11-03T23:59:59.999Z", year: 2023 });
  assert.equal(2026 - trip.year, 3, "2 years 11 months: \"3 years ago\"");
  assert.equal(memoryDates("2025-12-01", "2026-01-01", 3).year, 2026, "last month: \"0 years ago\", not \"1 year ago\"");
  assert.equal(memoryDates("2026-11-01", "2026-11-01", 2).hideAt, "2026-11-02T23:59:59.999Z");
});

test("calendar helpers: local midnight and anniversaries", () => {
  assert.equal(new Date(startOfDay("2026-11-01", "Asia/Kolkata")).toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(new Date(startOfDay("2026-03-29", "Europe/London")).toISOString(), "2026-03-29T00:00:00.000Z");
  assert.equal(new Date(startOfDay("2026-03-30", "Europe/London")).toISOString(), "2026-03-29T23:00:00.000Z");
  assert.equal(daysFromAnniversary("2023-11-03", "2026-11-05"), 2);
  assert.equal(daysFromAnniversary("2024-12-30", "2026-01-02"), 3);
  assert.equal(daysFromAnniversary("2024-02-29", "2026-02-28"), 0);
  assert.deepEqual(monthsBetween("2025-11-30", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});
