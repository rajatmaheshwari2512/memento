// Captions: the tag list, what the model is asked, and the night run's limits.

// Tags the model may choose from; anything else it says is dropped.
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

export const PROMPT = [
  "You write search captions for a private photo library. Look carefully at the whole photo.",
  "Describe it in one sentence of at most 35 words: the main subject, notable objects, the setting and any activity.",
  "Name brands, landmarks, and the kind of document if it is one.",
  "Don't guess who people are; say \"a man\", \"two children\" and so on.",
  `Then choose at most ${MAX_TAGS} tags that clearly describe the whole photo, only from this list: ${TAGS.join(", ")}.`,
  "Most photos need one or two tags; an empty list is fine.",
  'Reply with JSON only: {"caption": "...", "tags": ["..."]}',
].join("\n");

export const NIGHT_PHOTO_TIMEOUT_MS = 10 * 60_000;

export const FAILED_NIGHTS = 3;

// Clean-up: at most this share of the captions in one night (and at least MIN_REMOVALS). A bigger one-off clean-up: --max-removals.
export const MAX_REMOVED_SHARE = 0.02;

export const MIN_REMOVALS = 50;
