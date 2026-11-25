// AI edits: sizes, Gemini's request, and the switched-off messages (services/edits.service.ts,
// clients/gemini.client.ts).

// IMAGE_SIZE=auto: 4K only when the original is clearly bigger than a 2K result (about
// 4.2 MP), so a 12 MP phone photo gets 4K and a screenshot 2K. Unknown size: 2K. The same for
// every edit (typed, a tool, a highlighted area), unless the admin's "Allow full quality (4K)"
// is off. The apps show no price, so this rule lives only here.
export const TWO_K_PIXELS = 4_200_000;
export const FOUR_K_OVER_PIXELS = TWO_K_PIXELS * 1.25;

export const GEMINI_OFF = "AI edits are switched off. An admin can turn them on in Administration → Settings → Memento Features.";

// The most tools one edit may combine: the apps' maxSelected
// (immich/web/src/lib/ai-edit/ai/ai-tools.json), which joins their instructions into one.
export const MAX_TOOLS = 3;

export const TOOLS_OFF =
  "The AI tools (presets and highlighting) are switched off. An admin can turn them on in Administration → Settings → Memento Features.";

// What Gemini accepts as input, by the type Immich reports. HEIC/HEIF can't be
// sniffed as simply, and are only used with SOURCE=original.
export const GEMINI_INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

// Pins the request/response format, so Google changing its defaults can't break us.
export const API_REVISION = "2026-05-20";

// Added before the user's instruction: edits should change only what was asked.
export const GUIDANCE =
  "Edit the attached photo according to the instruction below. Change only what the " +
  "instruction asks for. Keep everything else, especially people's faces, exactly as it is.\n\nInstruction: ";

// Instead, when the user highlighted an area: the photo goes first, then the same photo with
// that area tinted red (the "mark", made by the app). Tested 2026-11-19 (FEATURES.md, section
// 5): no red was left, and the rest stayed in place. "Unless the instruction says otherwise"
// is for Move, which takes the highlighted thing somewhere else.
export const AREA_GUIDANCE =
  "Edit the first attached photo according to the instruction below. The second attached image " +
  "is the same photo with one area tinted red: that is the highlighted area. Unless the " +
  "instruction says otherwise, change only the highlighted area and keep everything else, " +
  "especially people's faces, exactly as it is. The red tint only marks the area: the result " +
  "must not have it.\n\nInstruction: ";

// An edit of a highlighted area (POST /edits/area) carries, base64 in its JSON:
//   - the mark: small (about 1.5K pixels on the longer side, a few hundred KB as JPEG); the tint
//     only has to show where;
//   - for a first edit, the photo itself, upright as the app shows it (at most about 3K pixels,
//     a few MB), made from the same picture as the mark. So both images Gemini gets are upright
//     and framed alike, whatever Gemini does with a file's rotation tag (the original Immich
//     keeps can be stored sideways with a tag saying so). "Edit more" works on the earlier
//     result, which is upright already.
// The request is read only in its turn (EDITS_AT_ONCE), as it arrives: both images are decoded
// into files, and only the rest (a /edits request's few fields, up to MAX_JSON_BYTES) is kept in
// memory. The caps bound the request, and so the disk it takes.
export const MARK_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_MARK_BYTES = 3 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const MAX_AREA_REQUEST_BYTES = Math.ceil(((MAX_MARK_BYTES + MAX_PHOTO_BYTES) * 4) / 3) + 16 * 1024;

// Very large photos aren't AI-edited (POST /edits and /edits/area): over 100 megapixels, or over
// 12,000 pixels on the longer side, by the photo's size as shown (with Immich's own crop, as the
// result's size is chosen). Refused with 413 and PHOTO_TOO_LARGE_CODE, for the apps to recognise,
// before anything is downloaded or counted.
export const MAX_EDIT_PIXELS = 100_000_000;
export const MAX_EDIT_SIDE = 12_000;
export const PHOTO_TOO_LARGE_CODE = "photo_too_large";
export const PHOTO_TOO_LARGE =
  "This photo is too large for AI edits: they work on photos up to 100 megapixels and 12,000 pixels on the longer side.";

// Saving a highlighted edit (POST /edits/:id/save-area): the app sends the original with the area
// pasted on, at full size. A RAW photo's full-size picture is the JPEG inside it, which can be a
// little smaller than the photo, so each side may be up to 10% short (the apps call a picture
// more than 10% smaller a preview, and don't paste onto it), never longer, with the same
// orientation and shape, within 1%. Immich's preview is far smaller, so it's still refused.
export const FULL_SIZE_MIN_SHARE = 0.9;
export const FULL_SIZE_SHAPE_TOLERANCE = 0.01;

// Gemini's reply (clients/gemini.client.ts) is read as it arrives: the image's base64 is decoded
// into a file, and only the status, each part's type and text (each text cut at
// MAX_REPLY_TEXT_BYTES; the person sees 300 characters) are kept. The cap is on the whole reply,
// and so the disk it takes: a 4K JPEG is 3–8 MB (11 MB as base64), and Google's result is already
// paid for, so the cap is generous. The answer to a failed request is read only for its error
// code.
export const MAX_REPLY_BYTES = 100 * 1024 * 1024;
export const MAX_REPLY_TEXT_BYTES = 64 * 1024;
export const MAX_REPLY_KEPT_BYTES = 1024 * 1024;
export const MAX_ERROR_REPLY_BYTES = 64 * 1024;
export const GEMINI_TIMEOUT_MS = 180_000;

// Each edit's files (the photo, the app's mark, Gemini's result) are in a folder of its own under
// DATA_DIR, removed when the edit ends, whatever happens (and any left by a crash, at start). The
// result is moved from there into the edits store (repositories/edits.repository.ts), so both are
// under DATA_DIR. An edit is refused (507) when DATA_DIR is nearly full, as a save is
// (services/copies.service.ts).
export const EDIT_FILES_FOLDER = "edit-files";
export const EDITS_LOW_DISK = "The server is low on disk space, so AI edits can't be made right now. An admin needs to free some space.";

// Edits being made at once, and the line behind them.
//
// Memory: an edit holds no image whole. The photo streams from Immich (or the app) into a file,
// from the file to Google as base64 48 KB at a time, and Google's 4K result back into a file the
// same way (clients/gemini.client.ts), so an edit holds a few MB at most. Measured with
// test/edits-memory.bench.ts (the real service against a fake Immich and Gemini, Node 24 on Linux
// in the service's own image, with the heap V8 picks under the 512 MB cap), the service's peak
// memory:
//                                          before (images whole)   now
//   idle, just started                     ~93 MB                  ~93 MB
//   1 edit                                 228 MB                  134 MB
//   2 at once (the old limit)              300 MB                  134 MB
//   4 at once                              —                       131 MB, 132 MB
//   8 at once                              767 MB (over the cap)   169 MB (whole photo), 167 MB (highlighted)
//   32 asked at once (8 made, 24 waiting)  —                       182 MB, 199 MB
//   8 at once, every size at its cap       —                       191 MB, 181 MB
// (a 12 MB original and an 8 MB 4K result; at the caps a 14 MB original, a 20 MB result, and a
// 6 MB photo with a 3 MB mark; one run each, so a few MB either way). Peak memory doesn't grow
// evenly with edits: 1 to 4 at once all peaked at ~134 MB now. Read loosely, the first edit's
// ~40 MB looks like the service settling in (code, buffers it keeps), and each edit after it adds
// roughly 5 MB, against 70–80 MB before.
//
// So 8 at once peak under 200 MB, leaving over 300 MB of the 512 MB for everything else (Ask,
// memories, saves, live albums), where 2 already took 300 MB before. More at once wouldn't make
// edits faster for anyone: Google takes 25–40 s per edit either way, and the limits (20 a day
// each, 150 a month for everyone) keep the total small; 8 covers every family member editing at
// the same moment.
//
// The line: whoever waits holds no photo (a highlighted edit's request is read only in its turn),
// so its length is about time, not memory (32 asked at once peaked at 199 MB, above). 8 at a time
// at up to ~40 s each clears 24 waiting in about 2 minutes, inside the 3 minutes anyone waits
// before "busy, try again".
export const EDITS_AT_ONCE = 8;
export const EDITS_WAITING = 24;
export const EDIT_WAIT_MS = 3 * 60_000;
export const EDITS_TOO_MANY = "Memento is making a lot of AI edits right now. Try again in a minute.";
export const EDITS_TOO_LONG = "Memento was busy with other AI edits for too long. Try again.";

// An app built before highlighted edits had their own address sends them to POST /edits.
export const UPDATE_THE_APP = "Highlighted edits need a newer version of the app. Please update it, then try again.";
