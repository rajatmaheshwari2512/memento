// Places in Ask Photos ("last time in goa"): the phrase the trained reader marks as where the photos were taken is looked up in the asker's own places. A place that isn't in their photos isn't a filter: its words stay search words.

import { setTimeout as sleep } from "node:timers/promises";
import { placeNames, searchPlaces } from "../clients/immich.client.ts";
import { PLACES_CACHE_MS, PLACES_RETRY_MS, PLACES_WAIT_MS } from "../constants/ask.constants.ts";
import type { Place, PlaceFound, PlaceKind, PlaceMatch, Plan } from "../types/ask.types.ts";
import type { Credential } from "../types/immich.types.ts";
import { log } from "../utils/http.ts";
import { wordsOf } from "../utils/words.ts";

const KINDS: PlaceKind[] = ["country", "state", "city"];

// A user's places by key ("new delhi", "manali" for "Manāli").
export type PlaceIndex = Map<string, Place>;

// How a place name is compared: its words without accents or "and".
const placeWords = (name: string): string[] => wordsOf(name.normalize("NFD").replace(/\p{M}/gu, "")).filter((w) => w !== "and");
export const placeKey = (name: string): string => placeWords(name).join(" ");

// `words` without one of each of `remove`, from the end: "new car in new delhi" keeps "new car".
export function withoutOnce(words: string[], remove: string[]): string[] {
  const left = [...words];
  for (const w of remove) {
    const i = left.lastIndexOf(w);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}

export function indexPlaces(lists: Record<PlaceKind, string[]>): PlaceIndex {
  const index: PlaceIndex = new Map();
  for (const kind of KINDS) {
    for (const name of lists[kind]) {
      const key = placeKey(name);
      if (key && !index.has(key)) index.set(key, { name, kind });
    }
  }
  return index;
}

// Null when Immich is slow or fails.
const inTime = <T>(work: Promise<T>): Promise<T | null> =>
  Promise.race([work, sleep(PLACES_WAIT_MS, null, { ref: false })]).catch(() => null);

const cache = new Map<string, { index: PlaceIndex; expires: number }>();
const loading = new Map<string, Promise<PlaceIndex>>();
const failedUntil = new Map<string, number>();

// The asker's places if they've been read already.
export const cachedPlaces = (userId: string): PlaceIndex | null => {
  const hit = cache.get(userId);
  return hit && hit.expires > Date.now() ? hit.index : null;
};

// The asker's places, kept for a few minutes; null when Immich is slow or can't list them.
export async function placesOf(cred: Credential, userId: string): Promise<PlaceIndex | null> {
  const cached = cachedPlaces(userId);
  if (cached) return cached;
  if ((failedUntil.get(userId) ?? 0) > Date.now()) return null;
  let load = loading.get(userId);
  if (!load) {
    load = Promise.all(KINDS.map((kind) => placeNames(cred, kind)))
      .then(([country, state, city]) => {
        const index = indexPlaces({ country: country!, state: state!, city: city! });
        if (cache.size > 100) cache.clear();
        cache.set(userId, { index, expires: Date.now() + PLACES_CACHE_MS });
        return index;
      })
      .catch((error: unknown) => {
        log({ event: "places_unavailable", user: userId, error: String(error) });
        if (failedUntil.size > 100) failedUntil.clear();
        failedUntil.set(userId, Date.now() + PLACES_RETRY_MS);
        throw error;
      })
      .finally(() => loading.delete(userId));
    loading.set(userId, load);
  }
  return inTime(load);
}

// The longest run of a phrase's words that's one of the asker's places.
function byName(phrase: string, index: PlaceIndex): PlaceMatch | null {
  const words = placeWords(phrase);
  for (let n = words.length; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const place = index.get(words.slice(i, i + n).join(" "));
      if (place) return { place, words: words.slice(i, i + n) };
    }
  }
  return null;
}

const searched = new Map<string, PlaceFound[]>();

async function placeSearch(cred: Credential, phrase: string): Promise<PlaceFound[]> {
  const hit = searched.get(phrase);
  if (hit) return hit;
  const found = await searchPlaces(cred, phrase, PLACES_WAIT_MS);
  if (searched.size > 1000) searched.clear();
  searched.set(phrase, found);
  return found;
}

// The place the question names, if it's one of the asker's: each phrase the reader marked as where, by its own name, or else by Immich's place search. The first phrase that matches wins.
export async function findPlace(cred: Credential, plan: Plan, index: PlaceIndex): Promise<PlaceMatch | null> {
  if (index.size === 0) return null;
  for (const phrase of plan.places) {
    const match = byName(phrase, index);
    if (match) return match;
  }
  const phrases = [...new Set(plan.places.map(placeKey).filter(Boolean))].slice(0, 3);
  const answers = (await inTime(Promise.all(phrases.map((p) => placeSearch(cred, p).catch((): PlaceFound[] => []))))) ?? [];
  for (const [i, found] of answers.entries()) {
    for (const f of found) {
      const place = index.get(placeKey(f.name));
      if (place) return { place, words: placeWords(phrases[i]!) };
    }
  }
  return null;
}
