// A recap video: each photo held a few seconds with a slow zoom towards its faces, a few seconds from each
// video, crossfades between them, optional music, as a 1080p MP4 (video.ts).

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Mood, OUTPUT_FILE, type RecapJob } from "./job.ts";
import { cropFor, type Box } from "./layout.ts";
import { type Deadline, run } from "./run.ts";
import { h264, mp4Output, TO_TV } from "./video.ts";
import { sizeOf } from "./vips.ts";


const W = 1920;
const H = 1080;
const FPS = 25;
const PHOTO_SECONDS = 3.5;
const CLIP_SECONDS = 4;
const FADE = 0.6;
const ZOOM = 0.12;
const STILL = { w: Math.round(W * 1.5), h: Math.round(H * 1.5) };
const MUSIC = /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i;
const FINAL = h264(FPS);

function focusOf(faces: Box[], map: (x: number, y: number) => [number, number]): [number, number] {
  if (faces.length === 0) return [0.5, 0.45];
  const xs = faces.flatMap(([x1, , x2]) => [x1, x2]);
  const ys = faces.flatMap(([, y1, , y2]) => [y1, y2]);
  const [fx, fy] = map((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
  return [Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy))];
}

// The photo as a 16:9 frame; returns the frame and where the zoom should head.
async function frame(photo: string, faces: Box[], tmp: string, i: number, deadline: Deadline): Promise<{ still: string; focus: [number, number] }> {
  const out = join(tmp, `${i}-still.jpg`);
  const scratch = join(tmp, `photo-${i}`);
  await mkdir(scratch);
  try {
    return await frameIn(photo, faces, scratch, out, deadline);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function frameIn(photo: string, faces: Box[], tmp: string, out: string, deadline: Deadline): Promise<{ still: string; focus: [number, number] }> {
  const upright = join(tmp, "upright.tif");
  await run("vips", ["autorot", photo, upright], deadline);
  const size = await sizeOf(upright, deadline);
  if (size.w / size.h >= 1.3) {
    const crop = cropFor(size, faces, { x: 0, y: 0, w: 16, h: 9 });
    const cropped = join(tmp, "crop.tif");
    await run("vips", ["extract_area", upright, cropped, String(crop.x), String(crop.y), String(crop.w), String(crop.h)], deadline);
    await run("vips", ["thumbnail", cropped, out + "[Q=92]", String(STILL.w), "--height", String(STILL.h), "--size", "force"], deadline);
    return { still: out, focus: focusOf(faces, (x, y) => [(x * size.w - crop.x) / crop.w, (y * size.h - crop.y) / crop.h]) };
  }
  const small = join(tmp, "bg-small.tif");
  const blurred = join(tmp, "bg-blur.tif");
  const background = join(tmp, "bg.tif");
  const foreground = join(tmp, "fg.tif");
  await run("vips", ["thumbnail", upright, small, "240", "--height", "135", "--crop", "centre"], deadline);
  await run("vips", ["gaussblur", small, blurred, "6"], deadline);
  await run("vips", ["resize", blurred, background, String(STILL.w / 240), "--vscale", String(STILL.h / 135)], deadline);
  const dark = join(tmp, "bg-dark.tif");
  await run("vips", ["linear", background, dark, "0.55", "0", "--uchar"], deadline);
  const scale = STILL.h / size.h;
  await run("vips", ["resize", upright, foreground, String(scale)], deadline);
  const fgWidth = Math.round(size.w * scale);
  const left = Math.round((STILL.w - fgWidth) / 2);
  const placed = join(tmp, "placed.tif");
  await run("vips", ["insert", dark, foreground, placed, String(left), "0"], deadline);
  await run("vips", ["jpegsave", placed, out, "--Q", "92"], deadline);
  return { still: out, focus: focusOf(faces, (x, y) => [(left + x * fgWidth) / STILL.w, y]) };
}

type Source =
  | { kind: "photo"; still: string; focus: [number, number]; frames: number }
  | { kind: "video"; file: string; start: number; frames: number };

// ffmpeg's input for frames [from, from + count) of a source, and the filter that turns them into
// 1080p video frames (`label` keeps two sources' filters apart in one graph).
function framesOf(source: Source, from: number, count: number, label: string): { input: string[]; filter: string } {
  if (source.kind === "photo") {
    const [fx, fy] = source.focus;
    return {
      input: ["-loop", "1", "-framerate", String(FPS), "-i", source.still],
      filter: `zoompan=z='1+${ZOOM}*(on+${from})/${source.frames}':x='(iw-iw/zoom)*${fx.toFixed(3)}':y='(ih-ih/zoom)*${fy.toFixed(3)}'` +
        `:d=1:s=${W}x${H}:fps=${FPS},${TO_TV}`,
    };
  }
  return {
    input: ["-threads", "2", "-ss", (source.start + from / FPS).toFixed(3), "-t", ((count + 2) / FPS).toFixed(3), "-i", source.file],
    filter: `split[${label}a][${label}b];` +
      `[${label}a]scale=240:135:force_original_aspect_ratio=increase,crop=240:135,boxblur=6,scale=${W}:${H},eq=brightness=-0.2[${label}bg];` +
      `[${label}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[${label}fg];` +
      `[${label}bg][${label}fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS},setsar=1,${TO_TV}`,
  };
}

// A few seconds from a little before a video's middle, in whole frames.
function clipSource(file: string, durationMs: number): Source {
  const seconds = Math.max(1, Math.min(CLIP_SECONDS, durationMs / 1000 - 0.2));
  return { kind: "video", file, start: Math.max(0, (durationMs / 1000 - seconds) * 0.4), frames: Math.round(seconds * FPS) };
}

// The final video's parts, in order: each source's middle, and the crossfades between them.
async function parts(sources: Source[], tmp: string, deadline: Deadline): Promise<string[]> {
  const fade = Math.round(FADE * FPS);
  const out: string[] = [];
  for (const [i, source] of sources.entries()) {
    const from = i === 0 ? 0 : fade;
    const to = i === sources.length - 1 ? source.frames : source.frames - fade;
    const middle = framesOf(source, from, to - from, "s");
    const part = join(tmp, `part-${i}.mp4`);
    await run("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y", ...middle.input, "-filter_complex", `[0:v]${middle.filter}[v]`, "-map", "[v]",
      "-frames:v", String(to - from), ...FINAL, part,
    ], deadline, 240_000);
    out.push(part);
    if (i === sources.length - 1) break;
    const end = framesOf(source, source.frames - fade, fade, "a");
    const start = framesOf(sources[i + 1]!, 0, fade, "b");
    const crossfade = join(tmp, `fade-${i}.mp4`);
    await run("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y", ...end.input, ...start.input,
      "-filter_complex", `[0:v]${end.filter}[x];[1:v]${start.filter}[y];[x][y]xfade=transition=fade:duration=${FADE}:offset=0[v]`,
      "-map", "[v]", "-frames:v", String(fade), ...FINAL, crossfade,
    ], deadline, 120_000);
    out.push(crossfade);
  }
  return out;
}

// The job's track among the music folder's files: one of its moods', else any; none if no audio.
export function pickTrack(names: string[], moods: readonly Mood[], id: string): string | null {
  const tracks = names.filter((f) => MUSIC.test(f)).sort();
  const matching = tracks.filter((f) => moods.some((m) => f.startsWith(`${m}-`)));
  const pool = matching.length > 0 ? matching : tracks;
  if (pool.length === 0) return null;
  return pool[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % pool.length]!;
}

async function musicTrack(dir: string | undefined, job: RecapJob): Promise<string | null> {
  if (!dir) return null;
  const track = pickTrack(await readdir(dir).catch(() => [] as string[]), job.moods, job.id);
  return track && join(dir, track);
}

export async function renderRecap(job: RecapJob, dir: string, tmp: string, deadline: Deadline, maxBytes: number, musicDir?: string): Promise<void> {
  const sources: Source[] = [];
  for (const [i, item] of job.items.entries()) {
    sources.push(item.kind === "photo"
      ? { kind: "photo", ...(await frame(join(dir, item.file), item.faces, tmp, i, deadline)), frames: Math.round(PHOTO_SECONDS * FPS) }
      : clipSource(join(dir, item.file), item.durationMs));
  }
  const list = await parts(sources, tmp, deadline);
  const total = (sources.reduce((n, s) => n + s.frames, 0) - Math.round(FADE * FPS) * (sources.length - 1)) / FPS;
  const listFile = join(tmp, "parts.txt");
  await writeFile(listFile, list.map((p) => `file '${p}'`).join("\n"));
  const track = await musicTrack(musicDir, job);
  const out = join(dir, OUTPUT_FILE.recap);
  // The parts joined as they are (no re-encoding), with the music faded in and out.
  await run("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    ...(track ? ["-stream_loop", "-1", "-i", track, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k",
      "-af", `afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2`] : ["-map", "0:v"]),
    "-c:v", "copy", "-t", total.toFixed(3), ...mp4Output(job.stamp, maxBytes), out,
  ], deadline);
  const { size } = await stat(out);
  if (size >= maxBytes) throw new Error(`the video came out too big (${size} bytes)`);
}
