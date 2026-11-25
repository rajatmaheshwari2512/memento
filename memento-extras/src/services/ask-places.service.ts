// Places in Ask Photos ("last time in goa"). The trained reader marks the words that say where
// the photos were taken (its PLACE label: not "Delhi wale cousins", not "India Gate"); here
// that phrase is looked up in *the asker's own* places. Immich works out each photo's city,
// state and country from its location and lists the ones in a user's (and their timeline
// partners') photos, so this works for any user with nothing to train. A place that isn't in
// their photos isn't a filter: its words just stay search words. Plan: DECISIONS.md, Ask Photos.

import { setTimeout as sleep } from "node:timers/promises";
import { placeNames, searchPlaces } from "../clients/immich.client.ts";
import { PLACES_CACHE_MS, PLACES_RETRY_MS, PLACES_WAIT_MS } from "../constants/ask.constants.ts";
import type { Place, PlaceFound, PlaceKind, PlaceMatch, Plan } from "../types/ask.types.ts";
import type { Credential } from "../types/immich.types.ts";
import { log } from "../utils/http.ts";
import { wordsOf } from "../utils/words.ts";

// Widest first: a name that's both a state and a city ("Delhi") is read as the state, which
// holds the city's photos too ("New Delhi" is in the state of Delhi).
const KINDS: PlaceKind[] = ["country", "state", "city"];

// A user's places by key ("new delhi", "manali" for "Manāli").
export type PlaceIndex = Map<string, Place>;

// How a place name is compared: its words without accents ("Manāli" is "manali") or "and"
// ("Jammu & Kashmir" is "Jammu and Kashmir").
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

// Ask never waits long for Immich here: null when it's slow (the work carries on) or fails.
const inTime = <T>(work: Promise<T>): Promise<T | null> =>
  Promise.race([work, sleep(PLACES_WAIT_MS, null, { ref: false })]).catch(() => null);

const cache = new Map<string, { index: PlaceIndex; expires: number }>();
const loading = new Map<string, Promise<PlaceIndex>>(); // one read per user at a time
const failedUntil = new Map<string, number>(); // Immich couldn't list them: don't ask again for a minute

// The asker's places if they've been read already (a read that finished after Ask stopped
// waiting for it still counts).
export const cachedPlaces = (userId: string): PlaceIndex | null => {
  const hit = cache.get(userId);
  return hit && hit.expires > Date.now() ? hit.index : null;
};

// The asker's places, kept for a few minutes; null when Immich is slow or can't list them,
// so Ask never waits long for them. A slow read carries on and is kept for the next question.
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

// The longest run of a phrase's words that's one of the asker's places: "goa beach", marked
// as one place, is Goa (and "beach" stays a search word).
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

// Immich's answers, by phrase: its place data is the same for every user.
const searched = new Map<string, PlaceFound[]>();

async function placeSearch(cred: Credential, phrase: string): Promise<PlaceFound[]> {
  const hit = searched.get(phrase);
  if (hit) return hit;
  const found = await searchPlaces(cred, phrase, PLACES_WAIT_MS);
  if (searched.size > 1000) searched.clear();
  searched.set(phrase, found);
  return found;
}

// The place the question names, if it's one of the asker's: each phrase the reader marked as
// where, by its own name, or else by what Immich's place search makes of it, which knows old
// names, other spellings and typos ("bombay" → Mumbai, "banglore" → Bengaluru). Its answers
// can be places anywhere ("calcutta" is also a town in Belize), so the first one that's among
// the asker's places counts. The first phrase that matches wins ("delhi to manali": Delhi).
export async function findPlace(cred: Credential, plan: Plan, index: PlaceIndex): Promise<PlaceMatch | null> {
  if (index.size === 0) return null;
  for (const phrase of plan.places) {
    const match = byName(phrase, index);
    if (match) return match;
  }
  // At most three phrases, looked up at once, waited for no longer than one lookup.
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
