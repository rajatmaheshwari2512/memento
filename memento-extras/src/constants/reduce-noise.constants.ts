// Reduce noise for videos (services/reduce-noise.service.ts): the line, the time limits, the
// kinds of file, and what the person is told. The video's own limits (10 minutes, 2 GB) are the
// creations container's, defined once in creations/src/job.ts.

import { LIMITS, type VideoFormat } from "../../creations/src/job.ts";
import { AROUND_MS } from "./creations.constants.ts";

export const VIDEO_LIMITS = LIMITS["reduce-noise"];

// One video is cleaned at a time, for everyone (the creations container does one job at a time);
// up to `waiting` more wait their turn, each for at most REDUCE_NOISE_WAIT_SECONDS (config.ts;
// 45 minutes: behind a recap being made, or the morning's memories run), checking every `pollMs`.
export const NOISE_LINE = { waiting: 3, pollMs: 5_000 };

// How long the parts of a job may take: the container's own limit plus a minute (as creations),
// the original's download and the copy's upload (2 GB on the server's own network), and the
// whole job, which must end before the night captions' hours to start.
export const NOISE_TIMEOUT_MS = {
  clean: VIDEO_LIMITS.ms + 60_000,
  download: 10 * 60_000,
  upload: 10 * 60_000,
  job: VIDEO_LIMITS.ms + 60_000 + AROUND_MS,
};

// Free space the work folder needs for a job: REDUCE_NOISE_MIN_FREE_BYTES (config.ts; 4 GB, the
// creations' own margin), plus twice the video (the original and the copy, which is uploaded
// straight from the work folder; the sound's files are small beside them).
export const NOISE_SPACE_PER_VIDEO_BYTE = 2;

// The kinds of file a copy can be, by the original's extension: what the container writes, and
// the type it's uploaded as. Anything else is refused (AVI, MTS, …: rare on phones).
export const VIDEO_TYPES: Record<string, { format: VideoFormat; mime: string }> = {
  mp4: { format: "mp4", mime: "video/mp4" },
  m4v: { format: "mp4", mime: "video/mp4" },
  mov: { format: "mov", mime: "video/quicktime" },
  qt: { format: "mov", mime: "video/quicktime" },
  "3gp": { format: "3gp", mime: "video/3gpp" },
  mkv: { format: "mkv", mime: "video/x-matroska" },
  webm: { format: "webm", mime: "video/webm" },
};

// The copy's name: the original's with this ("trip-reduce-noise.mp4").
export const COPY_SUFFIX = "reduce-noise";

export const REDUCE_NOISE_OFF = "Reduce noise is switched off. An admin can turn it on in Administration → Settings → Memento Features.";
export const NOT_FOUND = "Video not found.";
export const JOB_NOT_FOUND = "This video's noise reduction wasn't found.";
export const UNSUPPORTED_TYPE = "Reduce noise works on MP4, MOV, MKV, WebM and 3GP videos.";
export const TOO_LONG = `Reduce noise works on videos up to ${VIDEO_LIMITS.videoSeconds / 60} minutes long.`;
export const TOO_BIG = `Reduce noise works on videos up to ${VIDEO_LIMITS.videoBytes / 1024 ** 3} GB.`;
export const BUSY = "Memento is cleaning other videos right now. Try again in a few minutes.";
export const BUSY_CODE = "busy"; // with BUSY, so the apps can say it in the person's language
export const WAITED_TOO_LONG = "Memento was busy for too long to clean this video. Try again later.";
export const LOW_DISK = "The server is low on disk space, so videos can't be cleaned right now. An admin needs to free some space.";
export const RESTARTED = "Memento restarted while cleaning this video. Try again.";
export const FAILED = "Couldn't reduce the noise in this video. Try again later.";
// The night captions' hours, e.g. "00:30" and "07:00".
export const quietMessage = (from: string, to: string) =>
  `Reduce noise doesn't run at night (${from}–${to}), while new photos are captioned. Try again after ${to}.`;

// What the person is told when the container can't clean a video (creations/src/job.ts
// NOISE_UNSUITABLE), by its reason.
export const UNSUITABLE: Record<string, string> = {
  "it has no sound": "This video has no sound to clean up.",
  "it has no picture": "This file has no picture, so it can't be cleaned as a video.",
  "it's too long": TOO_LONG,
  "it's too big": TOO_BIG,
  "it isn't the kind of file its name says": "This video's file isn't what its name says, so it can't be cleaned.",
};
