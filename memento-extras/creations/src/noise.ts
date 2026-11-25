// Reduce noise: a video's sound cleaned up by DeepFilterNet 3 (an open speech-enhancement model,
// run by its project's own `deep-filter` tool, pinned by version and checksum in the Dockerfile),
// with the picture copied packet for packet into a copy of the same kind of file.
//
//   1. ffprobe reads the file: its picture, its sound (channels, sample rate, bitrate, where it
//      starts) and its length. No sound or no picture, longer or bigger than LIMITS, or not the
//      kind of file its name says: Unsuitable (the extras service tells the person why; trying
//      again won't help).
//   2. ffmpeg decodes the sound into a 48 kHz 16-bit WAV, DeepFilterNet's rate: mono stays mono,
//      anything else becomes stereo. A gap in the original's sound (its timestamps jump) becomes
//      silence, so what follows stays in step with the picture. A file's header can lie about its
//      length, so the WAV is capped a little over the limit and its samples counted: over
//      SOUND_SECONDS, it's too long (Unsuitable).
//   3. deep-filter cleans it a piece at a time (noisePieces): each piece starts LEAD_IN_SECONDS
//      early, so the model has settled by the part that's kept. It holds a whole piece in memory:
//      a whole 10-minute stereo track at once took ~750 MB of the container's 1 GB.
//   4. ffmpeg joins the pieces, crossfading CROSSFADE_SAMPLES at each join, starts the sound where
//      the original's started, encodes it (AAC; Opus in WebM, which can't hold AAC) at about the
//      original's bitrate and sample rate, and writes it with the original's picture as it is
//      (not re-encoded: every packet and timestamp the same), its rotation, date and place.
//
// Measured on the Mac (Apple silicon, Docker, run as the server runs it: 1 GB, 1.5 CPUs, the
// lowest CPU weight, read-only), with test videos of speech over pink noise and a hum
// (creations/check-reduce-noise.sh, 2026-11-23):
//   - speed: a 10-minute 1080p stereo video took 49–51 s in all (~5 s per minute of video), 41–43
//     of them in the model (~4.2 s per minute), the rest decoding and writing; a 1-minute one 5–7 s.
//     The server's cores are slower and the container runs at the lowest priority: estimate 2–4
//     minutes for 10 minutes (to be confirmed on the server);
//   - memory: the container's peak was ~250 MiB for 10 minutes, and doesn't grow with length;
//   - the picture: the same packets and timestamps (ffmpeg's framecrc), its rotation, date, place;
//   - the sound: noise alone came out 14–29 dB quieter (−39 → −53…−59 dB in a 60 s stereo MP4),
//     speech ~0.3 dB quieter, in step with the picture within 1 ms; MP4, MOV (HEVC, mono 44.1 kHz,
//     starting late), WebM (VP9, Opus), MKV and 3GP alike;
//   - the joins, placed in speech: within ±100 ms of one, the result differs from cleaning the
//     whole track in one go by −41 dB, as elsewhere (−43 dB; speech is −18 dB), with no click.

import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, NOISE_UNSUITABLE, type NoiseJob, OUTPUT_FILE, type RenderNotes, Unsuitable, type VideoFormat } from "./job.ts";
import { type Deadline, run } from "./run.ts";

const RATE = 48_000; // DeepFilterNet's sample rate
const PIECE_SECONDS = 120;
const LEAD_IN_SECONDS = 2;
const CROSSFADE_SAMPLES = 2_400; // 50 ms at each join
const TAIL_SAMPLES = 4_800; // 100 ms of silence after each piece: the model's delay (30 ms) comes off its end
// The longest sound cleaned: the video's limit, with a few seconds' leeway (Immich's length, which
// the service checked, and ffprobe's can differ).
const SOUND_SECONDS = LIMITS["reduce-noise"].videoSeconds + 5;
// deep-filter's ARM64 build is for glibc (there's no ARM64 build for Alpine's musl), so there it's
// started by glibc's own loader, with the few glibc libraries it needs (copied in by the
// Dockerfile). The x86-64 build is for musl and runs as it is (no loader in the image).
const DEEP_FILTER = process.env.DEEP_FILTER ?? "/app/deep-filter";
const GLIBC = process.env.GLIBC_DIR ?? "/opt/glibc";
const LOADER = join(GLIBC, "ld-linux-aarch64.so.1");
const deepFilter = (args: string[]): [string, string[]] =>
  existsSync(LOADER) ? [LOADER, ["--library-path", GLIBC, DEEP_FILTER, ...args]] : [DEEP_FILTER, args];

// How each kind of file is written: ffmpeg's muxer, the family ffprobe names the original's
// (mp4, mov and 3gp read as one family; mkv and webm as another), and the sound's codec.
const OUTPUT: Record<VideoFormat, { muxer: string; family: string; codec: "aac" | "libopus" }> = {
  mp4: { muxer: "mp4", family: "mp4", codec: "aac" },
  mov: { muxer: "mov", family: "mp4", codec: "aac" },
  "3gp": { muxer: "3gp", family: "mp4", codec: "aac" },
  mkv: { muxer: "matroska", family: "matroska", codec: "aac" },
  webm: { muxer: "webm", family: "matroska", codec: "libopus" },
};

// The original's sound, as the copy keeps it: channels (1, or 2 for anything else), sample rate,
// bitrate (null: unknown), and where it starts after the file's start (seconds).
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

// ffmpeg's options for the copy's sound: about the original's bitrate (within sensible bounds;
// unknown: a good default for the channels) and sample rate (Opus only takes 48 kHz).
export function soundOptions(codec: "aac" | "libopus", sound: Sound): string[] {
  const [low, high, mono, stereo] = codec === "aac" ? [64, 320, 128, 192] : [48, 256, 96, 128];
  const known = sound.bitRate === null ? null : Math.round(sound.bitRate / 1000);
  const kbps = known === null ? (sound.channels === 1 ? mono : stereo) : Math.min(high, Math.max(low, known));
  return ["-c:a", codec, "-b:a", `${kbps}k`, "-ar", String(codec === "aac" ? sound.sampleRate : RATE)];
}

// A piece of the sound, in samples: what goes into the model [from, to), and the part of its
// output that's kept [keepFrom, keepTo), counted from `from`.
export type Piece = { from: number; to: number; keepFrom: number; keepTo: number };

// The sound (`total` samples) in pieces of about PIECE_SECONDS. Each piece is kept from half a
// crossfade before its share starts to half a crossfade after it ends, so the crossfades put the
// kept parts back together exactly `total` long; what goes in also has the LEAD_IN_SECONDS before
// that, and up to TAIL_SAMPLES after. A short last piece joins the one before.
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

// ffmpeg's filter joining the cleaned pieces (inputs 1…n; input 0 is the video): each trimmed to
// what's kept, crossfaded into the next, and the whole started `offset` seconds in, where the
// original's sound started, so it stays in step with the picture.
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

// The most the sound's WAV may take (ffmpeg's -fs): 5 s over SOUND_SECONDS, so a longer sound
// always comes out over it and is refused, plus room for the WAV's header. It's checked by length,
// not by what the header says: a file can claim 30 s and hold hours.
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
  // 1. What the video is.
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

  // 2. Its sound, as DeepFilterNet takes it: gaps filled with silence (aresample's async), at most
  //    soundCapBytes, and refused if it's longer than the limit, whatever the header said.
  const noisy = join(tmp, "noisy.wav");
  await run("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-i", video, "-map", "0:a:0", "-vn", "-af", "aresample=async=1", "-ac", String(sound.channels),
    "-ar", String(RATE), "-c:a", "pcm_s16le", "-fs", String(soundCapBytes(sound.channels)), noisy,
  ], deadline, 600_000);
  const total = await samplesIn(noisy, deadline);
  if (total > SOUND_SECONDS * RATE) throw new Unsuitable(NOISE_UNSUITABLE.tooLong);

  // 3. Cleaned a piece at a time.
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
    // The join's timing relies on every piece covering what's kept: never let one come out short.
    if ((await samplesIn(output, deadline)) < piece.keepTo) throw new Error("the cleaned sound came out shorter than it went in");
    cleaned.push(output);
  }
  const modelMs = Date.now() - modelStarted;
  await rm(noisy);

  // 4. The copy: the picture as it is, the cleaned sound, the original's details.
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
