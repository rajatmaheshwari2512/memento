// A cinematic photo, Google Photos style: one still photo as a short silent video in which a
// virtual camera slowly pushes in and orbits a little around the subject, so the background
// shifts behind it (an MP4, video.ts).
//
//   1. The photo upright at the video's size (at most 1920 × 1080, either way up, never
//      enlarged), and a small copy for the depth model, by vips.
//   2. Its depth, by Depth Anything V2 Small (depth.py; about a second, about 200 MB).
//   3. The subject found in the depth: the depth where its sharpest edges are (parallax.ts). No
//      clear subject in front of a background (a flat scene, a landscape, a document): it
//      wouldn't look 3D, so it's Unsuitable (the service drops the job, never retries it).
//   4. The frames drawn by parallax.ts in its own process and handed straight to ffmpeg (no
//      frames on disk), encoded once.
// Every step runs at the lowest priority, one after the other, so memory is the largest step's,
// not their sum; the job's deadline stops every step.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type CinematicJob, OUTPUT_FILE, type RenderNotes, Unsuitable } from "./job.ts";
import { analyse, type Plan, readDepth } from "./parallax.ts";
import { type Deadline, pipeline, run } from "./run.ts";
import { fitPhoto, framePhoto, h264, mp4Output, TO_TV } from "./video.ts";

const FPS = 25;
const SECONDS = 5;
const MODEL_SIDE = 518; // the depth model's input: its long side (it was trained at 518), each side a multiple of 14
const MODEL = process.env.DEPTH_MODEL ?? "/app/model/depth.onnx"; // fetched and checked when the image is built (Dockerfile)
const DEPTH_PY = new URL("./depth.py", import.meta.url).pathname;
const PARALLAX = new URL("./parallax.ts", import.meta.url).pathname;
// A clear subject: its outline runs along at least this much of the frame (1 ≈ the frame's
// height plus width), and it covers a sensible share of the frame. Measured: real photos of
// people, a dog, cats in front of a scene 0.41–9; screenshots 0–0.03; a collage has none.
const MIN_EDGES = 0.35;
const AREA = { min: 0.03, max: 0.85 };

// The model's input size for a frame: the long side MODEL_SIDE, both sides multiples of 14.
export function modelSize(frame: { w: number; h: number }): { w: number; h: number } {
  const scale = MODEL_SIDE / Math.max(frame.w, frame.h);
  const side = (v: number) => Math.max(14, Math.round((v * scale) / 14) * 14);
  return { w: side(frame.w), h: side(frame.h) };
}

export async function renderCinematic(job: CinematicJob, dir: string, tmp: string, deadline: Deadline, maxBytes: number): Promise<RenderNotes> {
  // 1. The frame (in 8-bit sRGB colour, even from a black-and-white photo), and the model's copy
  //    of it (made from the frame, so the two line up exactly), as plain pixels for our own code
  //    (vips writes PPM; it reads only TIFF and photo formats).
  const upright = join(tmp, "upright.tif");
  const size = await fitPhoto(join(dir, job.photo.file), upright, deadline);
  const framed = join(tmp, "frame.tif");
  await framePhoto(upright, size, framed, deadline);
  const frame = join(tmp, "frame.ppm");
  await run("vips", ["copy", framed, frame], deadline);
  const small = modelSize(size);
  const input = join(tmp, "small.ppm");
  await run("vips", ["thumbnail", framed, input, String(small.w), "--height", String(small.h), "--size", "force"], deadline);

  // 2. Its depth.
  const started = Date.now();
  const depthFile = join(tmp, "depth.pgm");
  await run("python3", [DEPTH_PY, MODEL, input, depthFile], deadline, 90_000);
  const depthMs = Date.now() - started;

  // 3. The subject.
  const scene = analyse(readDepth(await readFile(depthFile)), job.photo.faces);
  if (!scene || scene.edges < MIN_EDGES || scene.area < AREA.min || scene.area > AREA.max) {
    throw new Unsuitable("it has no clear subject in front of a background");
  }

  // 4. The frames, straight into ffmpeg. The drift's direction varies from job to job.
  const plan: Plan = { scene, frames: FPS * SECONDS, drift: parseInt(job.id.slice(-1), 16) % 2 === 0 ? 1 : -1 };
  const out = join(dir, OUTPUT_FILE.cinematic);
  const drawing = Date.now();
  await pipeline([
    [process.execPath, ["--disable-warning=ExperimentalWarning", PARALLAX, frame, depthFile, JSON.stringify(plan)]],
    ["ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${size.w}x${size.h}`, "-framerate", String(FPS), "-i", "pipe:0",
      "-vf", TO_TV, "-frames:v", String(plan.frames), ...h264(FPS, "4M"), ...mp4Output(job.stamp, maxBytes), out,
    ]],
  ], deadline, 150_000);
  const { size: bytes } = await stat(out);
  if (bytes >= maxBytes) throw new Error(`the cinematic photo came out too big (${bytes} bytes)`);
  const round = (v: number) => Math.round(v * 100) / 100;
  return { depthMs, drawMs: Date.now() - drawing, cut: round(scene.cut), subject: round(scene.subject), edges: round(scene.edges), area: round(scene.area) };
}
