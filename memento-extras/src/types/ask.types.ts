// Ask Photos: what a question is read as, and what /ask answers.

import type { AssetJson, PersonEntry } from "./immich.types.ts";

// What the reader understood, for the chips above the results.
export type Understood = Omit<Plan, "words" | "places"> & { place: Place | null };

// A place in the asker's photos that the question named (services/ask-places.service.ts).
export type Place = { name: string; kind: PlaceKind };
export type PlaceKind = "city" | "state" | "country";

// A place the question named, and the words it used for it ("bangalore" for Bengaluru).
export type PlaceMatch = { place: Place; words: string[] };

// One answer of Immich's place search (GET /api/search/places).
export type PlaceFound = { name: string; admin1name?: string; admin2name?: string };

export type AskResult = { understood: Understood; assets: AssetJson[]; nextCursor: string | null };

export type Filter = Record<string, unknown>;

export type Instants = { gte: string; lt: string };

// A checked POST /ask request (schemas/ask.schema.ts).
export type AskRequest = { question: string; timeZone: string; language: string; cursor: string | null };

export type Person = PersonEntry;

// Calendar dates in the user's own time zone, both days included, YYYY-MM-DD.
export type DateRange = { from: string; to: string };

// What code reads in one phrase the trained reader marked: its dates, the People-page names in it, the other words, and hints.
export type PhraseReading = Pick<Plan, "people" | "dates" | "words" | "hints">;

export type Plan = {
  text: string; // what's left for the search model; "" when nothing is
  words: string[]; // the meaningful words of `text`, for the caption search
  people: Array<{ id: string; name: string }>; // every one of them must be in the photo
  dates: { label: string; ranges: DateRange[] } | null; // taken within any of the ranges
  type: "IMAGE" | "VIDEO" | null;
  favorite: boolean;
  order: "newest" | "oldest" | null; // "the last time …", "earliest …"; null: best match first
  hints: string[]; // shown under the results, e.g. how to make "me" work
  places: string[]; // the phrases the reader marked as where the photos were taken ("goa")
};

export type Today = { y: number; m: number; d: number };

export type ReaderContext = {
  people: Person[]; // the user's people, in Immich's order (favourites and biggest first)
  accountName: string; // the user's Immich account name, for "me"
  today: Today; // in the user's time zone
};

export type Found = { ranges: DateRange[]; label?: string };

// What the trained reader answers (clients/reader.client.ts): the question's words and one
// label each (B-/I- PER, DATE, NEW, OLD, VIDEO, FAV, WORD, PLACE, or O).
export type ReaderReply = { tokens: string[]; tags: string[] };

// A labelled phrase in the reader's reply: "pichle saal" is one DATE starting at word 0.
export type ReaderSpan = { kind: string; start: number; words: string[] };
