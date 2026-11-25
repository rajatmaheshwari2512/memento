// Collages, recap videos, animations and cinematic photos (services/creations.service.ts): which
// memories get which, the queue's limits, and where they're filed. FEATURES.md, section 8.

import { LIMITS, type Mood, OUTPUT_FILE } from "../../creations/src/job.ts";
import type { Theme } from "../types/memories.types.ts";
import type { CreationKind } from "../types/creations.types.ts";

// What each theme can get. A collage shows one event; Best of last month and Spotlight span too
// much for one. A Spotlight spans years: its photos aren't read with their stacks, so no
// animation. A cinematic photo needs only one good photo, so every theme can get one.
export const KINDS_FOR: Record<Theme, CreationKind[]> = {
  trip: ["collage", "recap", "animation", "cinematic"], big_day: ["collage", "recap", "animation", "cinematic"],
  month: ["recap", "animation", "cinematic"], spotlight: ["recap", "cinematic"],
};

// Recap videos: 10–20 photos (at least minPhotos), and a few seconds from up to `videos` videos,
// none bigger than 4K (an 8K clip alone fills the container's memory).
export const RECAP = { minPhotos: 8, maxPhotos: 20, videos: 4, maxVideoMegapixels: 9 };

// A recap's music: the moods its track may have, by its memory's theme, or `old` for a memory
// whose photos are all over a year old. The container picks one track named after any of them
// (creations/src/recap.ts; the tracks: docs/runbooks.md, "Music for recaps").
export const RECAP_MOODS: Record<Theme | "old", Mood[]> = {
  trip: ["adventure", "upbeat"], big_day: ["festive", "indian-festive"], month: ["upbeat", "calm"], spotlight: ["calm", "indian-calm"],
  old: ["nostalgic"],
};

// Animations: a burst of 3–12 near-identical photos (memory-picks.service.ts), each at most
// maxGapSeconds after the one before, all within maxSpanSeconds (a longer run of shots is a
// series, not a burst: only its best stretch is used).
export const ANIMATION = { minFrames: LIMITS.animationFrames.min, maxFrames: LIMITS.animationFrames.max, maxGapSeconds: 5, maxSpanSeconds: 12 };

// Once a week, not for every memory: creations are real files in the person's library (and its
// backups), so they're capped to keep the server's disk from filling. Every themed memory
// proposes what it could get; on WEEKLY.weekday's run (local time) the week's best memory gets
// them, at most one collage, one recap video, one animation and one cinematic photo per person,
// in a memory card of their own (CARD_SHOW_DAYS), and the rest are skipped. Memories themselves
// still show whenever due: they add only a row in Immich, no files.
export const WEEKLY = { weekday: 0, days: 7 }; // Sunday (0 = Sunday … 6 = Saturday); memories of the last 7 days

// Which memory is the week's best: by theme first, then by how good its photos are.
export const THEME_RANK: Record<Theme, number> = { trip: 4, big_day: 3, month: 2, spotlight: 1 };

// The queue: one worker, one job at a time across everyone.
export const QUEUE = {
  perUser: 6, // jobs waiting per person; more aren't queued (their memory is still made)
  total: 60, // jobs waiting in all (four a week per person, and room for ones still retrying)
  attempts: 3, // then dropped, with a log line
  backoffMinutes: 30, // after a failure: 30, then 60 minutes
  perDrain: 20, // jobs the worker takes before giving others a turn
};

// Time limits: how long the worker waits for a render or a quality check, a minute more than the
// container allows itself (LIMITS, creations/src/job.ts). A job only starts if its limit, plus
// AROUND_MS for downloads and the upload, ends before the night captions' hours.
export const TIMEOUT_MS: Record<CreationKind | "quality", number> = {
  collage: LIMITS.collage.ms + 60_000, recap: LIMITS.recap.ms + 60_000, animation: LIMITS.animation.ms + 60_000,
  cinematic: LIMITS.cinematic.ms + 60_000, quality: LIMITS.quality.ms + 20_000,
};
export const AROUND_MS = 10 * 60_000;

// Inputs: Immich's previews for photos, its playback copies for videos.
// Videos come as Immich's playback file: its 1080p copy when it made one, else the original
// (HEVC and VP9 play as they are on this server); a bigger one is left out of the recap.
export const MAX_BYTES = { preview: 25 * 1024 * 1024, thumbnail: 2 * 1024 * 1024, video: 250 * 1024 * 1024 };
// A job isn't started with less free space than this in the work folder (the biggest recap uses
// about 2 GB while it's made).
export const MIN_FREE_BYTES = 4 * 1024 ** 3;

// What the container makes, by name in the job's folder, and the biggest it may be.
export const OUTPUT: Record<CreationKind, { file: string; maxBytes: number }> = {
  collage: { file: OUTPUT_FILE.collage, maxBytes: LIMITS.collage.bytes },
  recap: { file: OUTPUT_FILE.recap, maxBytes: LIMITS.recap.bytes },
  animation: { file: OUTPUT_FILE.animation, maxBytes: LIMITS.animation.bytes },
  cinematic: { file: OUTPUT_FILE.cinematic, maxBytes: LIMITS.cinematic.bytes },
};

// Collages: how many photos one gets (one of LIMITS.collageSizes) from how many its memory has.
export function collageSize(images: number): number {
  return images >= 12 ? 6 : images >= 4 ? 4 : images >= 3 ? 3 : images >= 2 ? 2 : 0;
}

export const TAG = "Memento/Creations";
export const ALBUM_NAME: Record<CreationKind, string> = { collage: "Collages", recap: "Recaps", animation: "Animations", cinematic: "Cinematic" };
export const FILE_PREFIX: Record<CreationKind, string> = {
  collage: "memento-collage", recap: "memento-recap", animation: "memento-animation", cinematic: "memento-cinematic",
};
export const EXTENSION: Record<CreationKind, string> = { collage: "jpg", recap: "mp4", animation: "mp4", cinematic: "mp4" };
export const MIME: Record<CreationKind, string> = { collage: "image/jpeg", recap: "video/mp4", animation: "video/mp4", cinematic: "video/mp4" };
