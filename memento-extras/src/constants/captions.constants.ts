// Captions: the tag list, what the model is asked, and the night run's limits
// (services/captions.service.ts, scripts/caption-night.ts).

// Tags the model may choose from. Anything else it says is dropped. Later they may also go
// into Immich as "Auto/<tag>", so they're short, plain and browsable.
export const TAGS = [
  "Food", "Drink", "Document", "Receipt", "Ticket", "Screenshot", "Whiteboard",
  "Selfie", "Group photo", "Baby", "Pet", "Wildlife",
  "Birthday", "Wedding", "Party", "Concert", "Sports",
  "Beach", "Mountains", "Nature", "Flowers", "Sunset", "Snow", "Night",
  "City", "Landmark", "Home", "Car", "Motorbike", "Plane", "Train",
  "Art", "Shopping",
] as const;

export const MAX_TAGS = 3;

export const MAX_CAPTION_CHARS = 400;

// Tested on the Mac with 12 random photos (2026-11-19). Asking for a separate list of
// objects mostly added noise ("ear", "fingers") and doubled the reply; asking for readable
// text repeated what Immich's own text reading (OCR) already finds and makes searchable.
// Asked for "up to 5" tags, models used all 5, mostly wrongly, hence at most 3.
export const PROMPT = [
  "You write search captions for a private photo library. Look carefully at the whole photo.",
  "Describe it in one sentence of at most 35 words: the main subject, notable objects, the setting and any activity.",
  "Name brands, landmarks, and the kind of document if it is one.",
  "Don't guess who people are; say \"a man\", \"two children\" and so on.",
  `Then choose at most ${MAX_TAGS} tags that clearly describe the whole photo, only from this list: ${TAGS.join(", ")}.`,
  "Most photos need one or two tags; an empty list is fine.",
  'Reply with JSON only: {"caption": "...", "tags": ["..."]}',
].join("\n");

export const NIGHT_PHOTO_TIMEOUT_MS = 10 * 60_000; // one photo; ~1.5 minutes is normal on 2 processors

export const FAILED_NIGHTS = 3;

// Clean-up: at most this share of the captions in one night (and at least MIN_REMOVALS);
// more means the photo list is probably wrong. A one-off bigger clean-up: --max-removals.
export const MAX_REMOVED_SHARE = 0.02;

export const MIN_REMOVALS = 50;
