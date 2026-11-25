// What the creations container is asked to make (POST /render), and the checks on it. The
// extras service writes the input files into the job's own folder under WORK_DIR first; a job
// names files only inside that folder.

import type { Box } from "./layout.ts";
import type { Stamp } from "./exif.ts";

export type Photo = { file: string; faces: Box[] };

export type CollageJob = { id: string; kind: "collage"; photos: Photo[]; stamp: Stamp };

// A recap's pieces, in order: photos (with faces), and videos (with their length).
export type RecapItem = { kind: "photo"; file: string; faces: Box[] } | { kind: "video"; file: string; durationMs: number };
// Its music's moods: a track is picked among those whose file name starts with one of them and a
// dash ("festive-…", never "indian-festive-…" for "festive"); none of them there, any track.
export const MOODS = ["upbeat", "calm", "nostalgic", "festive", "adventure", "indian-festive", "indian-calm"] as const;
export type Mood = (typeof MOODS)[number];
export type RecapJob = { id: string; kind: "recap"; items: RecapItem[]; stamp: Stamp; moods: Mood[] };

// An animation: a burst of near-identical photos (in the order taken), played as a short loop.
export type AnimationJob = { id: string; kind: "animation"; frames: string[]; stamp: Stamp };

// A cinematic photo: one photo (with its faces, where the camera turns around) as a short 3D move.
export type CinematicJob = { id: string; kind: "cinematic"; photo: Photo; stamp: Stamp };

// Reduce noise (noise.ts): one video, the person's original file, and the kind of file it is;
// its copy, with the sound cleaned up, is the same kind of file. Not a creation: the extras
// service saves it next to the original, like an edited photo.
export const VIDEO_FORMATS = ["mp4", "mov", "3gp", "mkv", "webm"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export type NoiseJob = { id: string; kind: "reduce-noise"; video: string; format: VideoFormat };

export type RenderJob = CollageJob | RecapJob | AnimationJob | CinematicJob | NoiseJob;

// What a render made, and a few facts about how (counts and flags only: they're logged).
export type RenderNotes = Record<string, number | boolean | string>;
export type RenderResult = { file: string; bytes: number; ms: number; notes?: RenderNotes };

// What each kind makes, by name in the job's folder (the extras service takes it from there).
// A cleaned video has no extension: it's the job's format (the service names the copy).
export const OUTPUT_FILE: Record<RenderJob["kind"], string> = {
  collage: "collage.jpg", recap: "recap.mp4", animation: "animation.mp4", cinematic: "cinematic.mp4", "reduce-noise": "reduce-noise.video",
};

// Why a video can't be cleaned (Unsuitable): the extras service tells the person in its own words.
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
const LOCAL = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/;
const OFFSET = /^[+-]\d\d:\d\d$/;

// The container's limits, defined once: it enforces them, and the extras service (which imports
// this file) stays within them.
export const LIMITS = {
  collage: { ms: 120_000, bytes: 20 * 1024 * 1024 }, // how long one may take, how big it may come out
  recap: { ms: 900_000, bytes: 150 * 1024 * 1024 },
  animation: { ms: 180_000, bytes: 30 * 1024 * 1024 },
  cinematic: { ms: 180_000, bytes: 20 * 1024 * 1024 },
  // A video of up to 10 minutes and 2 GB (the extras service refuses bigger ones before
  // downloading); its copy may come out a little bigger (the sound is re-encoded).
  "reduce-noise": { ms: 900_000, bytes: 2 * 1024 ** 3 + 256 * 1024 ** 2, videoBytes: 2 * 1024 ** 3, videoSeconds: 600 },
  quality: { ms: 180_000, files: 300 },
  collageSizes: [6, 4, 3, 2], // photos a collage can take (the layout templates), largest first
  recapItems: { min: 3, max: 30 },
  animationFrames: { min: 3, max: 12 },
  faces: 50, // face boxes per photo
  bodyBytes: 256 * 1024, // a job request
} as const;

export class BadJob extends Error {}

// A job that was read fine but can't be made from what it was given (an animation whose photos
// aren't one burst, a cinematic photo with no clear subject): answered as its own state, so it
// isn't tried again.
export class Unsuitable extends Error {}

function check(ok: boolean, what: string): void {
  if (!ok) throw new BadJob(what);
}

function fraction(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

export function parseStamp(v: unknown): Stamp {
  const s = v as Stamp;
  check(typeof s === "object" && s !== null && typeof s.local === "string" && LOCAL.test(s.local), "stamp.local");
  check(typeof s.offset === "string" && OFFSET.test(s.offset), "stamp.offset");
  if (s.gps !== null) {
    check(typeof s.gps === "object" && Math.abs(s.gps.lat) <= 90 && Math.abs(s.gps.lon) <= 180, "stamp.gps");
  }
  return { local: s.local, offset: s.offset, gps: s.gps === null ? null : { lat: Number(s.gps.lat), lon: Number(s.gps.lon) } };
}

export function parsePhoto(v: unknown): Photo {
  const p = v as Photo;
  check(typeof p === "object" && p !== null, "photo");
  parseFile(p.file, "photo.file");
  check(Array.isArray(p.faces) && p.faces.length <= LIMITS.faces, "photo.faces");
  for (const f of p.faces) check(Array.isArray(f) && f.length === 4 && f.every(fraction) && f[0] < f[2] && f[1] < f[3], "photo.faces");
  return { file: p.file, faces: p.faces.map((f) => [f[0], f[1], f[2], f[3]]) };
}

function parseId(body: unknown): string {
  const j = body as { id?: unknown };
  check(typeof j === "object" && j !== null && typeof j.id === "string" && ID.test(j.id), "id");
  return j.id as string;
}

export function parseQualityJob(body: unknown): QualityJob {
  const id = parseId(body);
  const files = (body as QualityJob).files;
  check(Array.isArray(files) && files.length >= 1 && files.length <= LIMITS.quality.files, "files");
  return { id, files: files.map((f) => parseFile(f, "files")) };
}

function parseFile(v: unknown, what: string): string {
  check(typeof v === "string" && FILE.test(v), what);
  return v as string;
}

function parseRecapItem(v: unknown): RecapItem {
  const item = v as RecapItem;
  check(typeof item === "object" && item !== null, "item");
  if (item.kind === "photo") return { kind: "photo", ...parsePhoto(item) };
  check(item.kind === "video", "item.kind");
  parseFile(item.file, "item.file");
  const ms = (item as { durationMs: unknown }).durationMs;
  check(typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms <= 6 * 3_600_000, "item.durationMs");
  return { kind: "video", file: item.file, durationMs: ms as number };
}

// Only names from MOODS (none given: none, as an older service sends).
function parseMoods(v: unknown): Mood[] {
  if (v === undefined) return [];
  check(Array.isArray(v) && v.length <= MOODS.length && v.every((m) => (MOODS as readonly unknown[]).includes(m)), "moods");
  return [...(v as Mood[])];
}

export function parseJob(body: unknown): RenderJob {
  const id = parseId(body);
  const j = body as RenderJob;
  if (j.kind === "recap") {
    check(Array.isArray(j.items) && j.items.length >= LIMITS.recapItems.min && j.items.length <= LIMITS.recapItems.max, "items");
    return { id, kind: "recap", items: j.items.map(parseRecapItem), stamp: parseStamp(j.stamp), moods: parseMoods(j.moods) };
  }
  if (j.kind === "animation") {
    const { min, max } = LIMITS.animationFrames;
    check(Array.isArray(j.frames) && j.frames.length >= min && j.frames.length <= max, "frames");
    return { id, kind: "animation", frames: j.frames.map((f) => parseFile(f, "frames")), stamp: parseStamp(j.stamp) };
  }
  if (j.kind === "cinematic") return { id, kind: "cinematic", photo: parsePhoto(j.photo), stamp: parseStamp(j.stamp) };
  if (j.kind === "reduce-noise") {
    const format = j.format;
    check((VIDEO_FORMATS as readonly unknown[]).includes(format), "format");
    check(parseFile(j.video, "video").endsWith(`.${format}`), "video");
    return { id, kind: "reduce-noise", video: j.video, format };
  }
  check(j.kind === "collage", "kind");
  check(Array.isArray(j.photos) && (LIMITS.collageSizes as readonly number[]).includes(j.photos.length), "photos");
  return { id, kind: "collage", photos: j.photos.map(parsePhoto), stamp: parseStamp(j.stamp) };
}
