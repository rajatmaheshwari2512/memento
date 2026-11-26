// An animation: a burst of near-identical photos played forward, then back, as a short silent loop (MP4).

import { link, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AnimationJob, LIMITS, OUTPUT_FILE, type RenderNotes, Unsuitable } from "./job.ts";
import type { Size } from "./layout.ts";
import { type Grey, parsePnm } from "./quality.ts";
import { type Deadline, run } from "./run.ts";
import { fitPhoto, framePhoto, h264, mp4Output, TO_TV } from "./video.ts";

const MIN_SECONDS = 2.4;
const MAX_SHIFT = 0.04;
const MAX_ANGLE = 0.035;
const SAFE_PATH = /^[\w/.-]+$/;
const TINY = 16;
const SIMILAR = 0.5;

export function playOrder(photos: number): { fps: number; order: number[] } {
  const fps = photos >= 10 ? 6 : 5;
  const cycle = [...Array.from({ length: photos }, (_, i) => i), ...Array.from({ length: photos - 2 }, (_, i) => photos - 2 - i)];
  const repeats = Math.max(1, Math.ceil((MIN_SECONDS * fps) / cycle.length));
  return { fps, order: Array.from({ length: repeats }, () => cycle).flat() };
}

export function alike(a: Grey, b: Grey): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  const mean = (p: Uint8Array) => p.reduce((s, v) => s + v, 0) / p.length;
  const ma = mean(a.pixels);
  const mb = mean(b.pixels);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    const x = a.pixels[i]! - ma;
    const y = b.pixels[i]! - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  const flat = a.pixels.length * 4;
  if (aa < flat || bb < flat) return aa < flat && bb < flat && Math.abs(ma - mb) < 16;
  return ab / Math.sqrt(aa * bb) >= SIMILAR;
}

export function burstStretch(tiny: Grey[]): { start: number; end: number } {
  let best = { start: 0, end: Math.min(1, tiny.length) };
  let start = 0;
  for (let i = 1; i <= tiny.length; i++) {
    if (i < tiny.length && alike(tiny[i - 1]!, tiny[i]!)) continue;
    if (i - start > best.end - best.start) best = { start, end: i };
    start = i;
  }
  return best;
}

// The photos, upright and the same size, as tmp/frame-<i>.tif.
async function normalise(job: AnimationJob, dir: string, tmp: string, deadline: Deadline): Promise<Size> {
  const size = await fitPhoto(join(dir, job.frames[0]!), join(tmp, "first.tif"), deadline);
  for (const [i, file] of job.frames.entries()) await framePhoto(join(dir, file), size, join(tmp, `frame-${i}.tif`), deadline);
  return size;
}

// The near-identical stretch of the photos, as tmp/burst-<k>.tif; Unsuitable if too short for an animation.
async function keepBurst(count: number, tmp: string, deadline: Deadline): Promise<number> {
  const tiny: Grey[] = [];
  for (let i = 0; i < count; i++) {
    const copy = join(tmp, `tiny-${i}.ppm`);
    await run("vips", ["thumbnail", join(tmp, `frame-${i}.tif`), copy, String(TINY), "--height", String(TINY)], deadline);
    tiny.push(parsePnm(await readFile(copy)));
  }
  const { start, end } = burstStretch(tiny);
  if (end - start < LIMITS.animationFrames.min) throw new Unsuitable("its photos aren't one burst of near-identical shots");
  for (let k = 0; k < end - start; k++) await link(join(tmp, `frame-${start + k}.tif`), join(tmp, `burst-${k}.tif`));
  return end - start;
}

// The burst lined up with its first photo, as tmp/aligned-<k>.tif; else the step that failed.
async function align(tmp: string, size: Size, fps: number, deadline: Deadline): Promise<{ aligned: true } | { aligned: false; failed: string }> {
  const motion = join(tmp, "motion.trf");
  if (!SAFE_PATH.test(motion)) return { aligned: false, failed: "path" };
  const frames = ["-framerate", String(fps), "-start_number", "0", "-i", join(tmp, "burst-%d.tif")];
  let step = "detect";
  try {
    await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...frames, "-vf", `format=gray,vidstabdetect=result=${motion}:shakiness=8:accuracy=15:tripod=1`, "-f", "null", "-"], deadline);
    step = "transform";
    const transform = `vidstabtransform=input=${motion}:tripod=1:optzoom=1:maxshift=${Math.round(size.w * MAX_SHIFT)}:maxangle=${MAX_ANGLE}:interpol=bicubic`;
    await run("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y", ...frames, "-vf", `format=yuv444p,${transform},unsharp=5:5:0.5:3:3:0.2,format=rgb24`,
      "-start_number", "0", join(tmp, "aligned-%d.tif"),
    ], deadline);
    return { aligned: true };
  } catch {
    return { aligned: false, failed: step };
  }
}

export async function renderAnimation(job: AnimationJob, dir: string, tmp: string, deadline: Deadline, maxBytes: number): Promise<RenderNotes> {
  const size = await normalise(job, dir, tmp, deadline);
  const kept = await keepBurst(job.frames.length, tmp, deadline);
  const { fps, order } = playOrder(kept);
  const alignment = await align(tmp, size, fps, deadline);
  const source = alignment.aligned ? "aligned" : "burst";
  // The play order as a numbered sequence of links to the frames (no copies).
  for (const [k, i] of order.entries()) await link(join(tmp, `${source}-${i}.tif`), join(tmp, `play-${k}.tif`));
  const out = join(dir, OUTPUT_FILE.animation);
  await run("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-framerate", String(fps), "-start_number", "0", "-i", join(tmp, "play-%d.tif"),
    "-vf", TO_TV, "-frames:v", String(order.length), ...h264(fps, "4M"), ...mp4Output(job.stamp, maxBytes), out,
  ], deadline);
  const { size: bytes } = await stat(out);
  if (bytes >= maxBytes) throw new Error(`the animation came out too big (${bytes} bytes)`);
  return { kept, ...(alignment.aligned ? { aligned: true } : { aligned: false, alignFailed: alignment.failed }) };
}
