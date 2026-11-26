// Reduce noise: a video's sound cleaned up by DeepFilterNet 3 (`deep-filter`), the picture copied as it is
// into a copy of the same kind of file. Unsuitable if no sound or picture, too long or too big.

import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, NOISE_UNSUITABLE, type NoiseJob, OUTPUT_FILE, type RenderNotes, Unsuitable, type VideoFormat } from "./job.ts";
import { type Deadline, run } from "./run.ts";

const RATE = 48_000;
const PIECE_SECONDS = 120;
const LEAD_IN_SECONDS = 2;
const CROSSFADE_SAMPLES = 2_400;
const TAIL_SAMPLES = 4_800;
const SOUND_SECONDS = LIMITS["reduce-noise"].videoSeconds + 5;
const DEEP_FILTER = "/app/deep-filter";
const GLIBC = "/opt/glibc";
const LOADER = join(GLIBC, "ld-linux-aarch64.so.1");
const deepFilter = (args: string[]): [string, string[]] =>
  existsSync(LOADER) ? [LOADER, ["--library-path", GLIBC, DEEP_FILTER, ...args]] : [DEEP_FILTER, args];

const OUTPUT: Record<VideoFormat, { muxer: string; family: string; codec: "aac" | "libopus" }> = {
  mp4: { muxer: "mp4", family: "mp4", codec: "aac" },
  mov: { muxer: "mov", family: "mp4", codec: "aac" },
  "3gp": { muxer: "3gp", family: "mp4", codec: "aac" },
  mkv: { muxer: "matroska", family: "matroska", codec: "aac" },
  webm: { muxer: "webm", family: "matroska", codec: "libopus" },
};

export type Sound = { channels: 1 | 2; sampleRate: number; bitRate: number | null; offset: number };

type ProbeStream = {
  codec_type?: string; channels?: number; sample_rate?: string; bit_rate?: string; start_time?: string; disposition?: { attached_pic?: number };
};
type ProbeOutput = { format?: { format_name?: string; duration?: string; start_time?: string }; streams?: ProbeStream[] };

const number = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// What ffprobe said about the video: its length and its first sound, or Unsuitable.
export function soundOf(probe: unknown, format: VideoFormat): { seconds: number; sound: Sound } {
  const p = (typeof probe === "object" && probe !== null ? probe : {}) as ProbeOutput;
  const families = String(p.format?.format_name ?? "").split(",");
  if (!families.includes(OUTPUT[format].family)) throw new Unsuitable(NOISE_UNSUITABLE.notItsFormat);
  const streams = Array.isArray(p.streams) ? p.streams : [];
  if (!streams.some((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1)) throw new Unsuitable(NOISE_UNSUITABLE.noPicture);
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!audio) throw new Unsuitable(NOISE_UNSUITABLE.noSound);
  const seconds = number(p.format?.duration);
  if (seconds === null || seconds <= 0) throw new Error("couldn't read the video's length");
  if (seconds > SOUND_SECONDS) throw new Unsuitable(NOISE_UNSUITABLE.tooLong);
  const rate = number(audio.sample_rate);
  const offset = (number(audio.start_time) ?? 0) - (number(p.format?.start_time) ?? 0);
  return {
    seconds,
    sound: {
      channels: audio.channels === 1 ? 1 : 2,
      sampleRate: rate !== null && rate >= 8_000 && rate <= 96_000 ? rate : RATE,
      bitRate: number(audio.bit_rate),
      offset: Math.max(0, offset),
    },
  };
}

export function soundOptions(codec: "aac" | "libopus", sound: Sound): string[] {
  const [low, high, mono, stereo] = codec === "aac" ? [64, 320, 128, 192] : [48, 256, 96, 128];
  const known = sound.bitRate === null ? null : Math.round(sound.bitRate / 1000);
  const kbps = known === null ? (sound.channels === 1 ? mono : stereo) : Math.min(high, Math.max(low, known));
  return ["-c:a", codec, "-b:a", `${kbps}k`, "-ar", String(codec === "aac" ? sound.sampleRate : RATE)];
}

export type Piece = { from: number; to: number; keepFrom: number; keepTo: number };

// The sound in pieces of about PIECE_SECONDS: [from, to) goes into the model, [keepFrom, keepTo) is kept.
export function noisePieces(total: number): Piece[] {
  const length = PIECE_SECONDS * RATE;
  const half = CROSSFADE_SAMPLES / 2;
  let count = Math.max(1, Math.ceil(total / length));
  if (count > 1 && total - (count - 1) * length < length / 4) count--;
  const pieces: Piece[] = [];
  for (let k = 0; k < count; k++) {
    const start = k === 0 ? 0 : k * length - half;
    const end = k === count - 1 ? total : (k + 1) * length + half;
    const from = Math.max(0, start - LEAD_IN_SECONDS * RATE);
    pieces.push({ from, to: Math.min(total, end + TAIL_SAMPLES), keepFrom: start - from, keepTo: end - from });
  }
  return pieces;
}

export function joinGraph(pieces: Piece[], offset: number): string {
  const parts = pieces.map((p, i) => `[${i + 1}:a]atrim=start_sample=${p.keepFrom}:end_sample=${p.keepTo},asetpts=PTS-STARTPTS[p${i}]`);
  let joined = "p0";
  for (let i = 1; i < pieces.length; i++) {
    parts.push(`[${joined}][p${i}]acrossfade=ns=${CROSSFADE_SAMPLES}:c1=tri:c2=tri[j${i}]`);
    joined = `j${i}`;
  }
  parts.push(`[${joined}]asetpts=PTS+${offset.toFixed(6)}/TB[sound]`);
  return parts.join(";");
}

export function soundCapBytes(channels: 1 | 2): number {
  return (SOUND_SECONDS + 5) * RATE * channels * 2 + 64 * 1024;
}

// How many samples a WAV holds.
async function samplesIn(wav: string, deadline: Deadline): Promise<number> {
  const out = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts", "-of", "csv=p=0", wav], deadline, 30_000);
  const samples = Number(out.trim());
  if (!Number.isInteger(samples) || samples <= 0) throw new Error("couldn't read the sound's length");
  return samples;
}

export async function reduceNoise(job: NoiseJob, dir: string, tmp: string, deadline: Deadline, maxBytes: number): Promise<RenderNotes> {
  const video = join(dir, job.video);
  if ((await stat(video)).size > LIMITS["reduce-noise"].videoBytes) throw new Unsuitable(NOISE_UNSUITABLE.tooBig);
  const probe = await run("ffprobe", [
    "-v", "error", "-of", "json", "-show_entries",
    "format=format_name,duration,start_time:stream=codec_type,channels,sample_rate,bit_rate,start_time:stream_disposition=attached_pic", video,
  ], deadline, 60_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(probe);
  } catch {
    throw new Error("couldn't read what the video holds");
  }
  const { seconds, sound } = soundOf(parsed, job.format);

  const noisy = join(tmp, "noisy.wav");
  await run("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-i", video, "-map", "0:a:0", "-vn", "-af", "aresample=async=1", "-ac", String(sound.channels),
    "-ar", String(RATE), "-c:a", "pcm_s16le", "-fs", String(soundCapBytes(sound.channels)), noisy,
  ], deadline, 600_000);
  const total = await samplesIn(noisy, deadline);
  if (total > SOUND_SECONDS * RATE) throw new Unsuitable(NOISE_UNSUITABLE.tooLong);

  const pieces = noisePieces(total);
  const cleanDir = join(tmp, "clean");
  await mkdir(cleanDir);
  const cleaned: string[] = [];
  const modelStarted = Date.now();
  for (const [i, piece] of pieces.entries()) {
    const input = join(tmp, `piece-${i}.wav`);
    await run("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y", "-i", noisy,
      "-af", `atrim=start_sample=${piece.from}:end_sample=${piece.to},apad=pad_len=${TAIL_SAMPLES}`, "-c:a", "pcm_s16le", input,
    ], deadline, 60_000);
    await run(...deepFilter(["--compensate-delay", "--output-dir", cleanDir, input]), deadline, 300_000);
    await rm(input);
    const output = join(cleanDir, `piece-${i}.wav`);
    if ((await samplesIn(output, deadline)) < piece.keepTo) throw new Error("the cleaned sound came out shorter than it went in");
    cleaned.push(output);
  }
  const modelMs = Date.now() - modelStarted;
  await rm(noisy);

  const out = join(dir, OUTPUT_FILE["reduce-noise"]);
  const { muxer, codec } = OUTPUT[job.format];
  await run("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-i", video, ...cleaned.flatMap((file) => ["-i", file]),
    "-filter_complex", joinGraph(pieces, sound.offset), "-map", "0:V", "-map", "[sound]", "-c:v", "copy", ...soundOptions(codec, sound),
    "-map_metadata", "0", ...(OUTPUT[job.format].family === "mp4" ? ["-movflags", "+faststart+use_metadata_tags"] : []),
    "-fs", String(maxBytes), "-f", muxer, out,
  ], deadline, 600_000);
  const { size } = await stat(out);
  if (size >= maxBytes) throw new Error(`the copy came out too big (${size} bytes)`);
  return { seconds: Math.round(seconds), channels: sound.channels, pieces: pieces.length, modelMs };
}
