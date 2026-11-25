// Themed memories (services/memories.service.ts and its helpers).

import type { Quality } from "./creations.types.ts";

export type Theme = "trip" | "month" | "big_day" | "spotlight";

// One photo or video as the timeline buckets describe it: enough to find days, trips and home.
export type LibraryItem = {
  id: string;
  takenAt: number; // ms, UTC
  day: string; // local calendar day where it was taken, "2024-10-12"
  isImage: boolean;
  isFavorite: boolean;
  lat: number | null;
  lon: number | null;
  city: string | null;
};

// A photo or video that could go into a memory, with the details its score needs
// (Immich's search with EXIF and people).
export type Candidate = {
  id: string;
  isImage: boolean;
  takenAt: number; // ms, UTC
  localDateTime: string; // wall-clock time where it was taken, as Immich keeps it ("…Z" but local)
  day: string;
  isFavorite: boolean;
  rating: number | null;
  durationMs: number | null;
  fileName: string;
  mime: string | null;
  hasCamera: boolean; // EXIF make or model
  megapixels: number | null;
  shape: string | null; // "4032x3024": width × height as shown (turned and cropped as the person sees it)
  duplicateId: string | null;
  people: Array<{ id: string; named: boolean }>;
  hiddenPerson: boolean; // someone the user hid: Immich drops such photos from memories
  lat: number | null;
  lon: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  stacked: boolean; // tucked under another photo in a stack (the timeline shows only the top one)
};

// A named person who could get a Spotlight.
export type SpotlightPerson = { id: string; name: string; birthDate: string | null; photos: number };

// What's already been made for this person (the database), for deciding what's due.
export type History = {
  keys: Set<string>; // theme keys of every themed memory made (or tried) before
  madeToday: number;
  lastSpotlight: string | null; // local day
  spotlightPeople: Map<string, string>; // person → last day they had one
  lastPastBigDay: string | null;
  trips: Array<{ first: string; last: string }>; // the days of every trip made or skipped
};

// Something due tonight, before its photos are chosen. `first`/`last` are local days.
export type Plan =
  | { theme: "trip"; key: string; first: string; last: string; farIds: Set<string> }
  | { theme: "month"; key: string; month: string; first: string; last: string }
  | { theme: "big_day"; key: string; first: string; last: string; recent: boolean }
  | { theme: "spotlight"; key: string; person: SpotlightPerson };

export type PickOptions = {
  count: number;
  start: number; // ms: the stretch of time to spread picks across
  end: number;
  avoid: Set<string>; // used recently (cooldown): only if too few are left otherwise
  never: Set<string>; // creations and photos tucked in stacks
  focusPersonId?: string; // Spotlight: photos where this person stands out score higher
  quality?: Map<string, Quality>; // measured sharpness and exposure, where known
};

// A themed memory as the apps get it (GET /memories/labels): its label goes where unpatched
// apps show "N years ago".
export type ThemedMemory = {
  memoryId: string;
  theme: Theme;
  label: string;
  memoryAt: string;
  showAt: string;
  hideAt: string;
};

// A row of themed_memories.
export type ThemedMemoryRow = {
  id: number; user_id: string; theme: Theme; theme_key: string; memory_id: string | null; status: string;
  label: string | null; person_id: string | null; first_day: string | null; last_day: string | null; score: number | null; memory_at: string | null; show_at: string | null; hide_at: string | null;
  made_on: string; created_at: string;
};

// A row of memory_users: someone who turned themed memories on, their key and choices.
export type MemoryUserRow = {
  user_id: string; key_id: string | null; sealed: string | null; permissions: string | null; creations: number;
  paused_reason: string | null; last_run_day: string | null; last_attempt_at: string | null; created_at: string; updated_at: string;
};

// What GET/PUT /memories/settings answer.
export type MemorySettings = {
  enabled: boolean; // has a key: their memories are made each night
  creations: boolean; // collages, recap videos, animations and cinematic photos for them (their own choice)
  pausedReason: string | null;
  lastRunDay: string | null;
};

export type SettingsChange = { enabled?: boolean; creations?: boolean };

// What one person's run did (POST /memories/run, and the log as counts).
export type RunSummary = {
  day: string;
  made: Array<{ memoryId: string; theme: Theme; label: string; assets: number }>;
  skipped: Array<{ theme: Theme | null; reason: string }>; // null: the whole run
  creationsQueued: number; // creations the weekly pick queued
};

// POST /memories/run's body.
export type RunOptions = { creations: boolean };
