// Themed memories (services/memories.service.ts): the key they use in Immich, when they're
// made, how photos are chosen, and the messages people see. FEATURES.md, section 7.

// --- The user's own key ---

export const KEY_NAME = "Memento memories";

// Exactly what themed memories and their creations call, nothing more. Each one is the
// permission Immich's own code asks for on that endpoint (@Authenticated in its controllers):
//   asset.read          the timeline (which photos show, stacks as one), the photo search
//                       (details, people), each photo's state before a render, face boxes' check
//   asset.view          previews and video playback, the inputs for creations
//   asset.upload        saving a collage, video, animation or cinematic photo into the library
//   person.read         names (Spotlight titles), birthdays, hidden people
//   face.read           where faces are, so crops keep them
//   memory.create       the memories: themed ones, and Sunday's card with its creations
//   tag.create, tag.asset   the "Memento/Creations" tag on creations
//   album.read, album.create, albumAsset.create   the person's "Collages", "Recaps",
//                       "Animations" and "Cinematic" albums: made on first use, then found
//                       again by id (a deleted one is made anew)
// Not asset.update (change any photo's date, place or visibility) or asset.download
// (originals): creations carry their date and place in the file itself, and
// previews are enough to make them. Not memory.delete or asset.delete: nothing is ever removed.
export const KEY_PERMISSIONS = [
  "asset.read", "asset.view", "asset.upload", "person.read", "face.read", "memory.create", "tag.create", "tag.asset",
  "album.read", "album.create", "albumAsset.create",
];

export const KEY_PURPOSE = "memories api-keys";

export const KEY_BROKEN = "Memento's key for themed memories stopped working. Turn themed memories off and on again to fix it.";
export const KEY_OUTDATED = "Themed memories need a new key from Memento. Turn them off and on again to give it.";

export const MEMORIES_OFF = "Themed memories are switched off. An admin can turn them on in Administration → Settings → Memento Features.";

// Labels replace "N years ago" on the memories strip's cards in Memento's apps, in the same
// place and style, so they're kept about as short.
export const MAX_LABEL = 26;

// --- When ---

// The day's run starts at config.memoriesRunAt (07:05 on the server: after the night captions,
// so the two never overlap), once a day per person.
// After a failed run (Immich down), the next try waits this long.
export const RETRY_MINUTES = 60;
// New themed memories per person per day, at most; the rest wait for the next night.
export const MAX_NEW_PER_DAY = 2;
// How many days each shows in the memories strip (Immich's own "years ago" show for one).
export const SHOW_DAYS = { trip: 3, month: 3, big_day: 2, spotlight: 2 } as const;
// Sunday's card with the week's creations: Sunday to Tuesday.
export const CARD_SHOW_DAYS = 3;
// "Make my memories now": one run at a time for everyone (with the day's run), and each person
// at most once in this many minutes.
export const MANUAL_RUN_MINUTES = 10;

// --- What ---

// Spotlight on a person: named people with at least this many photos, at most one a week,
// the same person again only after the cooldown, and not near their birthday (Immich makes a
// birthday memory then: from 3 days before to the day).
export const SPOTLIGHT = { minPhotos: 50, everyDays: 7, personCooldownDays: 120, birthdayBefore: 10, birthdayAfter: 3, count: 15 };

// Best of last month: made in the month's first days, if the month had enough.
export const MONTH = { lastDayToMake: 3, minItems: 20, count: 20 };

// Trips: photos with a location this far from home. Home is where the most days with a
// location were, over the past year (at least `homeMinDays` of them, or there are no trips).
// Days with photos but no location between far-away days count as part of the trip. A trip
// counts as over once a photo is taken at home again, or two days pass with nothing far away.
export const TRIP = { minKm: 100, lookbackDays: 30, gapDays: 1, homeMinDays: 10, minItems: 12, maxCount: 25 };

// Big days: a day with at least `minItems` photos and videos, and more than nearly all of
// the person's other days (the percentile). A recent one is shown a day or two later; once a
// week an older one comes back, never near its anniversary, which is Immich's own "years ago".
export const BIG_DAY = { minItems: 30, percentile: 0.97, recentDays: 3, pastEveryDays: 7, pastMinAgeDays: 60, anniversaryDays: 7, count: 12 };

// --- Choosing the photos ---

export const PICK = {
  minCount: 6, // fewer good photos than this, and the memory isn't made
  cooldownDays: 60, // a photo in a themed memory isn't used in another for this long (unless too few are left)
  burstSeconds: 20, // shots this close together are one moment: only the best is kept
  minGapSeconds: 90, // and picks are at least this far apart
  maxVideoShare: 0.2,
  videoMinMs: 2_000,
  videoMaxMs: 5 * 60_000,
  minMegapixels: 0.3, // smaller ones are thumbnails, stickers, forwards
};

// Measured quality (creations/src/quality.ts, on Immich's ~250 px thumbnail): skipped below
// these, and sharper scores higher. Only a shortlist of each memory's best candidates is
// measured, each photo once (cached), at most perRun in one person's day.
export const QUALITY = { perMemory: 120, perRun: 400, blurBelow: 15, sharpGood: 500, darkBelow: 70, blownAbove: 185 };

// Collages, recap videos, animations and cinematic photos Memento made (FILE_PREFIX in
// creations.constants.ts): never a source photo, even one the queue's record has lost.
export const CREATION_FILE = /^memento-(collage|recap|animation|cinematic)-/i;

// Copies saved by Adjust and AI edits (uploadCopy in copies.service.ts: the original's name
// with "-edited" or "-ai-edit-<8 hex>"), stacked on their original with its date and size.
export const SAVED_COPY = /-(edited|ai-edit-[0-9a-f]{8})\.[a-z0-9]+$/i;

// Screenshots and screen recordings by their file name (Android, iOS, Windows, macOS name them so).
export const SCREENSHOT_NAME = /screenshot|screen[ _-]?shot|screen[ _-]?record|scrnli/i;

// Formats cameras don't write: an image in one of these without camera details is a
// screenshot, a sticker or a download.
export const NON_CAMERA_TYPES = new Set(["image/png", "image/gif", "image/webp", "image/bmp"]);

// Limits on one person's night, so a huge library can't make it run long or use much memory.
export const LIMITS = {
  searchPages: 10, // Immich's search, 1,000 at a time: at most 10,000 photos looked at for one memory
  spotlightPeople: 100, // named people counted for Spotlight (Immich lists favourites and the biggest first)
  olderMonths: 360, // older months read for big days (30 years)
  plansTried: 6, // things due tried in one night (made or not)
};
