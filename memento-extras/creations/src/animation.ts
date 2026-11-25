// An animation, Google Photos style: a burst of near-identical photos played forward, then back,
// a few frames a second, as a short silent loop (an MP4, video.ts).
//
//   1. Each photo turned upright and made the first one's size (at most 1920 × 1080, either way
//      up; one cropped differently is cropped to fit), one at a time, by vips.
//   2. Only near-identical photos: a tiny grey copy of each is compared with the one before, and
//      the longest stretch of photos that each look like the one before is kept. Fewer than
//      three, and it's not a burst (Unsuitable: the service drops the job, never retries it).
//   3. Lightly aligned: vid.stab in "virtual tripod" mode matches every frame to the first, so a
//      hand's shake is steadied. The shift and turn it may apply are capped, so a frame that
//      really differs is never wrenched into place, and a slight zoom hides the edges. If the
//      alignment fails, the photos are used as they are (the log says at which step).
//   4. Forward then back, repeated to last at least MIN_SECONDS, encoded once.
// Memory stays small: one photo at a time in vips, at most a dozen frames in ffmpeg. The job's
// deadline stops every step.

import { link, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AnimationJob, LIMITS, OUTPUT_FILE, type RenderNotes, Unsuitable } from "./job.ts";
import type { Size } from "./layout.ts";
import { type Grey, parsePnm } from "./quality.ts";
import { type Deadline, run } from "./run.ts";
import { fitPhoto, framePhoto, h264, mp4Output, TO_TV } from "./video.ts";

const MIN_SECONDS = 2.4;
const MAX_SHIFT = 0.04; // of the frame's width: the most a frame is moved to line up
const MAX_ANGLE = 0.035; // radians (2°): the most it's turned
const SAFE_PATH = /^[\w/.-]+$/; // vid.stab's file option can't be quoted: other paths skip alignment
// Near-identical: the correlation of two photos' 16-pixel grey copies (exposure and contrast
// don't count). Measured on generated sets: a handheld burst 0.83–0.99 unaligned, a still
// camera 0.98, four unrelated scenes 0.15–0.31.
const TINY = 16;
const SIMILAR = 0.5;

// How it plays: frames a second, and which photo each frame shows. Forward then back without
// repeating either end (0 1 2 3 2 1), so it loops smoothly, as many times as it takes to last
// MIN_SECONDS.
export function playOrder(photos: number): { fps: number; order: number[] } {
  const fps = photos >= 10 ? 6 : 5;
  const cycle = [...Array.from({ length: photos }, (_, i) => i), ...Array.from({ length: photos - 2 }, (_, i) => photos - 2 - i)];
  const repeats = Math.max(1, Math.ceil((MIN_SECONDS * fps) / cycle.length));
  return { fps, order: Array.from({ length: repeats }, () => cycle).flat() };
}

// Whether `b` looks like `a`: same size, and its pixels rise and fall with a's. Two flat
// images (no detail) count as alike if they're about as bright.
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
  const flat = a.pixels.length * 4; // a standard deviation under 2 grey levels
  if (aa < flat || bb < flat) return aa < flat && bb < flat && Math.abs(ma - mb) < 16;
  return ab / Math.sqrt(aa * bb) >= SIMILAR;
}

// The longest stretch [start, end) of photos that each look like the one before (the first
// one found, if two are as long).
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

// The near-identical stretch of the photos, as tmp/burst-<k>.tif (links, no copies); Unsuitable
// if it's shorter than an animation takes.
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

// The burst lined up with its first photo, as tmp/aligned-<k>.tif; or, if that couldn't be
// done, the step that failed.
async function align(tmp: string, size: Size, fps: number, deadline: Deadline): Promise<{ aligned: true } | { aligned: false; failed: string }> {
  const motion = join(tmp, "motion.trf");
  if (!SAFE_PATH.test(motion)) return { aligned: false, failed: "path" };
  const frames = ["-framerate", String(fps), "-start_number", "0", "-i", join(tmp, "burst-%d.tif")];
  let step = "detect";
  try {
    // vid.stab takes planar frames only: grey to measure the motion, YUV to move them.
    await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...frames, "-vf", `format=gray,vidstabdetect=result=${motion}:shakiness=8:accuracy=15:tripod=1`, "-f", "null", "-"], deadline);
    step = "transform";
    const transform = `vidstabtransform=input=${motion}:tripod=1:optzoom=1:maxshift=${Math.round(size.w * MAX_SHIFT)}:maxangle=${MAX_ANGLE}:interpol=bicubic`;
    await run("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y", ...frames, "-vf", `format=yuv444p,${transform},unsharp=5:5:0.5:3:3:0.2,format=rgb24`,
      "-start_number", "0", join(tmp, "aligned-%d.tif"),
    ], deadline);
    return { aligned: true };
  } catch {
    return { aligned: false, failed: step }; // used as they are (if it ran out of time, the next step says so)
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
