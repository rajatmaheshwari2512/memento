// Memento's switches and how each is shown (services/flags.service.ts).

export type Flags = {
  gemini: {
    enabled: boolean; // AI Edit and every Gemini edit. Off: nothing is sent to Google.
    tools: boolean; // The presets and highlighting an area (pasted back onto the original). Off: hidden, and highlighted edits refused.
    allow4k: boolean; // Off: every result is 2K (about ₹5 instead of ~₹12 an edit).
    dailyLimitPerUser: number;
    monthlyLimitTotal: number;
  };
  liveAlbums: {
    enabled: boolean; // Off: the 5-minute check stops and live albums can't be changed. They stay as normal albums.
  };
  askPhotos: {
    enabled: boolean; // Off: the Ask search type is hidden and refused. Captions stay.
    trainedReader: boolean; // On: the trained reader labels the question's words; off (or down): searched as typed.
    places: boolean; // On: a place the reader marks ("in goa"), if it's in the asker's photos, puts the photos taken there first.
  };
  themedMemories: {
    enabled: boolean; // Off: no new themed memories at night (Spotlight, Best of last month, trips, big days). Existing ones stay.
  };
  creations: {
    enabled: boolean; // Off: no new collages, recap videos, animations or cinematic photos. Existing ones stay in people's libraries.
  };
  captions: {
    enabled: boolean; // Off: new photos aren't captioned at night. Existing captions stay.
  };
  adjust: {
    enabled: boolean; // Off: Adjust (sliders, filters, straighten) is hidden and its save refused. Saved copies stay.
  };
  reduceNoise: {
    enabled: boolean; // Off: the Reduce noise button for videos is hidden and refused. Cleaned copies stay.
  };
};

// How each setting is shown: the Android app's Memento admin draws its list from these
// (GET /admin/settings), so a new setting shows up there without an app update. The web's
// admin page (MementoFeaturesSettings.svelte) has its own copy of the words: keep them in step.
type Label = { section: string; title: string; subtitle: string };

export type Rule = ({ kind: "boolean" } | { kind: "int"; min: number; max: number }) & Label;

// One setting as Memento admin lists it (GET /admin/settings).
export type Setting = { key: string } & Rule;

export type FlagChange = { key: string; from: unknown; to: unknown };

// One checked setting from an admin's changes (schemas/flags.schema.ts).
export type FlagUpdate = { key: string; value: unknown };

// An admin's override as stored: its key and its value as JSON (repositories/flags.repository.ts).
export type StoredFlag = { key: string; value: string };

// What GET /flags answers.
export type FlagsAndDefaults = { flags: Flags; defaults: Flags };
