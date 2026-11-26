// AI edits: sizes, Gemini's request, and the switched-off messages (services/edits.service.ts, clients/gemini.client.ts).

// IMAGE_SIZE=auto: 4K only when the original is clearly bigger than a 2K result (about 4.2 MP), otherwise 2K; always 2K when the admin turns "Allow full quality (4K)" off.
export const TWO_K_PIXELS = 4_200_000;
export const FOUR_K_OVER_PIXELS = TWO_K_PIXELS * 1.25;

export const GEMINI_OFF = "AI edits are switched off. An admin can turn them on in Administration → Settings → Memento Features.";

// The most tools one edit may combine (the apps' maxSelected).
export const MAX_TOOLS = 3;

export const TOOLS_OFF =
  "The AI tools (presets and highlighting) are switched off. An admin can turn them on in Administration → Settings → Memento Features.";

// What Gemini accepts as input, by the type Immich reports.
export const GEMINI_INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export const API_REVISION = "2026-05-20";

// Added before the user's instruction.
export const GUIDANCE =
  "Edit the attached photo according to the instruction below. Change only what the " +
  "instruction asks for. Keep everything else, especially people's faces, exactly as it is.\n\nInstruction: ";

// Instead, when the user highlighted an area: the photo, then the same photo with that area tinted red (the "mark", made by the app).
export const AREA_GUIDANCE =
  "Edit the first attached photo according to the instruction below. The second attached image " +
  "is the same photo with one area tinted red: that is the highlighted area. Unless the " +
  "instruction says otherwise, change only the highlighted area and keep everything else, " +
  "especially people's faces, exactly as it is. The red tint only marks the area: the result " +
  "must not have it.\n\nInstruction: ";

// An edit of a highlighted area (POST /edits/area) carries, base64 in its JSON: the mark, and for a first edit the photo itself (upright, at most about 3K pixels).
export const MARK_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_MARK_BYTES = 3 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const MAX_AREA_REQUEST_BYTES = Math.ceil(((MAX_MARK_BYTES + MAX_PHOTO_BYTES) * 4) / 3) + 16 * 1024;

// Very large photos aren't AI-edited: over 100 megapixels, or over 12,000 pixels on the longer side. Refused with 413 and PHOTO_TOO_LARGE_CODE.
export const MAX_EDIT_PIXELS = 100_000_000;
export const MAX_EDIT_SIDE = 12_000;
export const PHOTO_TOO_LARGE_CODE = "photo_too_large";
export const PHOTO_TOO_LARGE =
  "This photo is too large for AI edits: they work on photos up to 100 megapixels and 12,000 pixels on the longer side.";

// Saving a highlighted edit (POST /edits/:id/save-area): the pasted result may be up to 10% short on each side, never longer, with the same orientation and shape within 1%.
export const FULL_SIZE_MIN_SHARE = 0.9;
export const FULL_SIZE_SHAPE_TOLERANCE = 0.01;

// Caps on Gemini's reply: the whole reply, and each text (MAX_REPLY_TEXT_BYTES).
export const MAX_REPLY_BYTES = 100 * 1024 * 1024;
export const MAX_REPLY_TEXT_BYTES = 64 * 1024;
export const MAX_REPLY_KEPT_BYTES = 1024 * 1024;
export const MAX_ERROR_REPLY_BYTES = 64 * 1024;
export const GEMINI_TIMEOUT_MS = 180_000;

// Each edit's files are in a folder of its own under DATA_DIR, removed when the edit ends. An edit is refused (507) when DATA_DIR is nearly full.
export const EDIT_FILES_FOLDER = "edit-files";
export const EDITS_LOW_DISK = "The server is low on disk space, so AI edits can't be made right now. An admin needs to free some space.";

// Edits being made at once, and the line behind them.
export const EDITS_AT_ONCE = 8;
export const EDITS_WAITING = 24;
export const EDIT_WAIT_MS = 3 * 60_000;
export const EDITS_TOO_MANY = "Memento is making a lot of AI edits right now. Try again in a minute.";
export const EDITS_TOO_LONG = "Memento was busy with other AI edits for too long. Try again.";
