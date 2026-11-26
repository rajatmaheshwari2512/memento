// What the creations container is asked to make (POST /render), and the checks on it.

import type { Box } from "./layout.ts";
import type { Stamp } from "./exif.ts";

export type Photo = { file: string; faces: Box[] };

export type CollageJob = { id: string; kind: "collage"; photos: Photo[]; stamp: Stamp };

// A recap's pieces, in order: photos (with faces), and videos (with their length).
export type RecapItem = { kind: "photo"; file: string; faces: Box[] } | { kind: "video"; file: string; durationMs: number };
// Its music's moods: a track is picked among those whose file name starts with one of them, else any.
export const MOODS = ["upbeat", "calm", "nostalgic", "festive", "adventure", "indian-festive", "indian-calm"] as const;
export type Mood = (typeof MOODS)[number];
export type RecapJob = { id: string; kind: "recap"; items: RecapItem[]; stamp: Stamp; moods: Mood[] };

// An animation: a burst of near-identical photos (in the order taken), played as a short loop.
export type AnimationJob = { id: string; kind: "animation"; frames: string[]; stamp: Stamp };

// A cinematic photo: one photo (with its faces, where the camera turns around) as a short 3D move.
export type CinematicJob = { id: string; kind: "cinematic"; photo: Photo; stamp: Stamp };

// Reduce noise (noise.ts): one video (the original file) and its kind; the copy is the same kind of file.
export const VIDEO_FORMATS = ["mp4", "mov", "3gp", "mkv", "webm"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export type NoiseJob = { id: string; kind: "reduce-noise"; video: string; format: VideoFormat };

export type RenderJob = CollageJob | RecapJob | AnimationJob | CinematicJob | NoiseJob;

export type RenderNotes = Record<string, number | boolean | string>;
export type RenderResult = { file: string; bytes: number; ms: number; notes?: RenderNotes };

// What each kind makes, by name in the job's folder.
export const OUTPUT_FILE: Record<RenderJob["kind"], string> = {
  collage: "collage.jpg", recap: "recap.mp4", animation: "animation.mp4", cinematic: "cinematic.mp4", "reduce-noise": "reduce-noise.video",
};

export const NOISE_UNSUITABLE = {
  noSound: "it has no sound",
  noPicture: "it has no picture",
  tooLong: "it's too long",
  tooBig: "it's too big",
  notItsFormat: "it isn't the kind of file its name says",
} as const;

// Measuring photos' quality (quality.ts): thumbnails in the job's folder.
export type QualityJob = { id: string; files: string[] };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^[a-z0-9][a-z0-9_-]{0,40}\.(jpg|jpeg|webp|png|mp4|mov|webm|mkv|3gp)$/;

export const LIMITS = {
  collage: { ms: 120_000, bytes: 20 * 1024 * 1024 },
  recap: { ms: 900_000, bytes: 150 * 1024 * 1024 },
  animation: { ms: 180_000, bytes: 30 * 1024 * 1024 },
  cinematic: { ms: 180_000, bytes: 20 * 1024 * 1024 },
  "reduce-noise": { ms: 900_000, bytes: 2 * 1024 ** 3 + 256 * 1024 ** 2, videoBytes: 2 * 1024 ** 3, videoSeconds: 600 },
  quality: { ms: 180_000, files: 300 },
  collageSizes: [6, 4, 3, 2],
  recapItems: { min: 3, max: 30 },
  animationFrames: { min: 3, max: 12 },
  faces: 50,
  bodyBytes: 256 * 1024,
} as const;

export class BadJob extends Error {}

// A job that can't be made from what it was given; answered as its own state, not retried.
export class Unsuitable extends Error {}

function check(ok: boolean, what: string): void {
  if (!ok) throw new BadJob(what);
}

function parseId(body: unknown): string {
  const j = body as { id?: unknown };
  check(typeof j === "object" && j !== null && typeof j.id === "string" && ID.test(j.id), "id");
  return j.id as string;
}

function parseFile(v: unknown, what: string): string {
  check(typeof v === "string" && FILE.test(v), what);
  return v as string;
}

export function parseQualityJob(body: unknown): QualityJob {
  const id = parseId(body);
  const files = (body as QualityJob).files;
  check(Array.isArray(files) && files.length >= 1 && files.length <= LIMITS.quality.files, "files");
  return { id, files: files.map((f) => parseFile(f, "files")) };
}

// Checks the job's id and file names (what the job may read in its own folder); the rest comes from our own service.
export function parseJob(body: unknown): RenderJob {
  parseId(body);
  const j = body as RenderJob;
  switch (j.kind) {
    case "collage":
      for (const photo of j.photos) parseFile(photo.file, "photo.file");
      break;
    case "recap":
      for (const item of j.items) parseFile(item.file, "item.file");
      j.moods ??= [];
      break;
    case "animation":
      for (const frame of j.frames) parseFile(frame, "frames");
      break;
    case "cinematic":
      parseFile(j.photo.file, "photo.file");
      break;
    case "reduce-noise":
      check(parseFile(j.video, "video").endsWith(`.${j.format}`), "video");
      break;
    default:
      throw new BadJob("kind");
  }
  return j;
}
