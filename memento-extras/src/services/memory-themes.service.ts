// What's due today, and what each themed memory is called. Pure: no requests, no database.
// Themes, in the order they're made (at most MAX_NEW_PER_DAY a day): trip, month, big_day, spotlight, then an older big_day.
// Each has a key ("trip:2026-10-12") recorded when it's made, so it's never made twice.

import { BIG_DAY, MAX_LABEL, MONTH, SPOTLIGHT, TRIP } from "../constants/memories.constants.ts";
import type { Candidate, History, LibraryItem, Plan, SpotlightPerson } from "../types/memories.types.ts";
import {
  addDays, daysBetween, daysFromAnniversary, firstOfMonth, lastOfMonth, longDate, monthName, previousMonth,
} from "../utils/local-date.ts";

type Point = { lat: number; lon: number };

export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function located(i: LibraryItem): i is LibraryItem & Point {
  return i.lat !== null && i.lon !== null;
}

// Home: the ~30 km square with the most days that have a photo with a location, over the past year.
export function findHome(items: LibraryItem[], today: string): Point | null {
  const since = addDays(today, -365);
  const cells = new Map<string, { days: Set<string>; lat: number; lon: number; n: number }>();
  for (const i of items) {
    if (!located(i) || i.day < since) continue;
    const key = `${Math.round(i.lat * 4)},${Math.round(i.lon * 4)}`;
    const cell = cells.get(key) ?? { days: new Set(), lat: 0, lon: 0, n: 0 };
    cell.days.add(i.day);
    cell.lat += i.lat;
    cell.lon += i.lon;
    cell.n++;
    cells.set(key, cell);
  }
  let best: { days: Set<string>; lat: number; lon: number; n: number } | undefined;
  for (const cell of cells.values()) if (!best || cell.days.size > best.days.size) best = cell;
  if (!best || best.days.size < TRIP.homeMinDays) return null;
  return { lat: best.lat / best.n, lon: best.lon / best.n };
}

export type Trip = { first: string; last: string; farIds: Set<string>; lastFarAt: number; over: boolean };

// Runs of days with photos far from home, in the last few weeks.
export function findTrips(items: LibraryItem[], home: Point, today: string): Trip[] {
  const since = addDays(today, -TRIP.lookbackDays);
  const recent = items.filter((i) => i.day >= since && i.day < today && located(i)) as Array<LibraryItem & Point>;
  const far = recent.filter((i) => distanceKm(i, home) >= TRIP.minKm).sort((a, b) => a.takenAt - b.takenAt);
  const trips: Trip[] = [];
  for (const i of far) {
    const current = trips.at(-1);
    if (current && daysBetween(current.last, i.day) <= TRIP.gapDays + 1) {
      current.last = i.day;
      current.lastFarAt = i.takenAt;
      current.farIds.add(i.id);
    } else {
      trips.push({ first: i.day, last: i.day, farIds: new Set([i.id]), lastFarAt: i.takenAt, over: false });
    }
  }
  for (const trip of trips) {
    const backHome = recent.some((i) => i.takenAt > trip.lastFarAt && distanceKm(i, home) < TRIP.minKm);
    trip.over = backHome || daysBetween(trip.last, today) >= 2;
  }
  return trips;
}

export function countsByDay(items: LibraryItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.day, (counts.get(i.day) ?? 0) + 1);
  return counts;
}

// A big day has at least BIG_DAY.minItems, and more than nearly all of this person's days with any photos.
export function bigDayThreshold(counts: Map<string, number>): number {
  const sorted = [...counts.values()].sort((a, b) => a - b);
  const at = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * BIG_DAY.percentile))] ?? 0;
  return Math.max(BIG_DAY.minItems, at);
}

function birthdayNear(person: SpotlightPerson, today: string): boolean {
  if (!person.birthDate) return false;
  // The next or the last birthday, whichever is nearer.
  for (const year of [Number(today.slice(0, 4)) - 1, Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    const md = person.birthDate.slice(5, 10) === "02-29" ? "02-28" : person.birthDate.slice(5, 10);
    const d = daysBetween(today, `${year}-${md}`);
    if (d >= -SPOTLIGHT.birthdayAfter && d <= SPOTLIGHT.birthdayBefore) return true;
  }
  return false;
}

// Who gets today's Spotlight, if anyone: someone who never had one (most photos first),
// else whoever had theirs longest ago, outside their cooldown and away from their birthday.
export function chooseSpotlight(people: SpotlightPerson[], history: History, today: string): SpotlightPerson | null {
  if (history.lastSpotlight && daysBetween(history.lastSpotlight, today) < SPOTLIGHT.everyDays) return null;
  const eligible = people.filter((p) => {
    if (p.photos < SPOTLIGHT.minPhotos || birthdayNear(p, today)) return false;
    const last = history.spotlightPeople.get(p.id);
    return !last || daysBetween(last, today) >= SPOTLIGHT.personCooldownDays;
  });
  eligible.sort((a, b) => {
    const la = history.spotlightPeople.get(a.id) ?? "";
    const lb = history.spotlightPeople.get(b.id) ?? "";
    return la.localeCompare(lb) || b.photos - a.photos || a.id.localeCompare(b.id);
  });
  return eligible[0] ?? null;
}

export type Due = {
  today: string;
  items: LibraryItem[]; // the past ~13 months (trips, recent big days, last month, home)
  olderCounts?: Map<string, number>; // photos per day over the whole library, when an older big day is due
  people?: SpotlightPerson[]; // when a Spotlight is due
  history: History;
};

export function spotlightDue(history: History, today: string): boolean {
  return !history.lastSpotlight || daysBetween(history.lastSpotlight, today) >= SPOTLIGHT.everyDays;
}

export function pastBigDayDue(history: History, today: string): boolean {
  return !history.lastPastBigDay || daysBetween(history.lastPastBigDay, today) >= BIG_DAY.pastEveryDays;
}

// Everything due today, most important first. The caller makes them in order until the
// day's limit, skipping any whose photos aren't good enough.
export function duePlans({ today, items, olderCounts, people, history }: Due): Plan[] {
  const plans: Plan[] = [];
  const recentCounts = countsByDay(items);
  const threshold = bigDayThreshold(recentCounts);

  const home = findHome(items, today);
  const trips = home ? findTrips(items, home, today) : [];
  const tripDays = (day: string) => trips.some((t) => day >= t.first && day <= t.last);
  const madeBefore = (t: Trip) => history.trips.some((m) => t.first <= m.last && t.last >= m.first);
  for (const t of trips) {
    const key = `trip:${t.first}`;
    if (!t.over || history.keys.has(key) || madeBefore(t)) continue;
    const n = items.filter((i) => i.day >= t.first && i.day <= t.last).length;
    if (n >= TRIP.minItems) plans.push({ theme: "trip", key, first: t.first, last: t.last, farIds: t.farIds });
  }

  // Best of last month, in this month's first days.
  if (Number(today.slice(8)) <= MONTH.lastDayToMake) {
    const month = previousMonth(today);
    const key = `month:${month}`;
    const n = items.filter((i) => i.day.startsWith(month)).length;
    if (!history.keys.has(key) && n >= MONTH.minItems) {
      plans.push({ theme: "month", key, month, first: firstOfMonth(month), last: lastOfMonth(month) });
    }
  }

  for (let back = BIG_DAY.recentDays; back >= 1; back--) {
    const day = addDays(today, -back);
    const key = `day:${day}`;
    if ((recentCounts.get(day) ?? 0) >= threshold && !tripDays(day) && !history.keys.has(key)) {
      plans.push({ theme: "big_day", key, first: day, last: day, recent: true });
    }
  }

  if (people) {
    const person = chooseSpotlight(people, history, today);
    if (person) plans.push({ theme: "spotlight", key: `spotlight:${person.id}:${today}`, person });
  }

  // An older big day: the biggest not shown before, at least two months old, and not within a week of its anniversary.
  if (olderCounts && pastBigDayDue(history, today)) {
    const days = [...olderCounts.entries()]
      .filter(([day, n]) =>
        n >= threshold && daysBetween(day, today) >= BIG_DAY.pastMinAgeDays &&
        daysFromAnniversary(day, today) > BIG_DAY.anniversaryDays && !history.keys.has(`day:${day}`))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const day = days[0]?.[0];
    if (day) plans.push({ theme: "big_day", key: `day:${day}`, first: day, last: day, recent: false });
  }
  return plans;
}

// --- Titles ---

// The place most of these photos were taken: a city if one has most of them, else the state,
// else the country.
export function placeName(photos: Candidate[]): string | null {
  for (const field of ["city", "state", "country"] as const) {
    const counts = new Map<string, number>();
    let total = 0;
    for (const p of photos) {
      const name = p[field];
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      total++;
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && total > 0 && top[1] / total >= 0.6) return top[0];
  }
  return null;
}

// The first of these that fits where "N years ago" goes; else the last, cut short.
function fit(...options: string[]): string {
  const ok = options.find((o) => o.length <= MAX_LABEL);
  if (ok) return ok;
  const last = options.at(-1)!;
  return `${last.slice(0, MAX_LABEL - 1).trimEnd()}…`;
}

// The memory's label, short. Places are named from every photo of the event (`all`): for a trip, the ones far from home.
//   trip       "Goa trip, 2023" ("Goa trip" if the place is long; "A trip, 2023" with no place names)
//   month      "Best of October" ("Best of December 2025" when it's not this year's)
//   big_day    recent: "A day in Shillong" / "A day to remember";
//              older: "A day in Shillong, 2024" / "5 October 2024"
//   spotlight  "Spotlight: Mom" (the first name, if the full one is long)
export function labelFor(plan: Plan, all: Candidate[], today: string): string {
  switch (plan.theme) {
    case "trip": {
      const place = placeName(all.filter((p) => plan.farIds.has(p.id)));
      const year = plan.first.slice(0, 4);
      return place ? fit(`${place} trip, ${year}`, `${place} trip`) : `A trip, ${year}`;
    }
    case "month": {
      const year = plan.month.slice(0, 4);
      return `Best of ${monthName(plan.month)}${year === today.slice(0, 4) ? "" : ` ${year}`}`;
    }
    case "big_day": {
      const place = placeName(all);
      const year = plan.first.slice(0, 4);
      if (plan.recent) return place ? fit(`A day in ${place}`, "A day to remember") : "A day to remember";
      return place ? fit(`A day in ${place}, ${year}`, `A day in ${place}`, longDate(plan.first)) : longDate(plan.first);
    }
    case "spotlight": {
      const name = plan.person.name;
      return fit(`Spotlight: ${name}`, `Spotlight: ${name.split(/\s+/)[0]}`);
    }
  }
}

// --- Dates Immich keeps with the memory ---
// memoryAt is the day of the memory's first photo, and data.year is chosen so that "N years ago" is that photo's age, rounded.
export function memoryDates(firstPhotoDay: string, today: string, showDays: number) {
  const ageYears = Math.round(daysBetween(firstPhotoDay, today) / 365.25);
  return {
    memoryAt: `${firstPhotoDay}T00:00:00.000Z`,
    showAt: `${today}T00:00:00.000Z`,
    hideAt: `${addDays(today, showDays - 1)}T23:59:59.999Z`,
    year: Number(today.slice(0, 4)) - ageYears,
  };
}
