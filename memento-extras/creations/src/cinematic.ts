// A cinematic photo: one still photo as a short silent video (MP4) with a slow 3D camera move.
// Unsuitable if the photo has no clear subject.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type CinematicJob, OUTPUT_FILE, type RenderNotes, Unsuitable } from "./job.ts";
import { analyse, type Plan, readDepth } from "./parallax.ts";
import { type Deadline, pipeline, run } from "./run.ts";
import { fitPhoto, framePhoto, h264, mp4Output, TO_TV } from "./video.ts";

const FPS = 25;
const SECONDS = 5;
const MODEL_SIDE = 518;
const MODEL = "/app/model/depth.onnx";
const DEPTH_PY = new URL("./depth.py", import.meta.url).pathname;
const PARALLAX = new URL("./parallax.ts", import.meta.url).pathname;
const MIN_EDGES = 0.35;
const AREA = { min: 0.03, max: 0.85 };

export function modelSize(frame: { w: number; h: number }): { w: number; h: number } {
  const scale = MODEL_SIDE / Math.max(frame.w, frame.h);
  const side = (v: number) => Math.max(14, Math.round((v * scale) / 14) * 14);
  return { w: side(frame.w), h: side(frame.h) };
}

export async function renderCinematic(job: CinematicJob, dir: string, tmp: string, deadline: Deadline, maxBytes: number): Promise<RenderNotes> {
  const upright = join(tmp, "upright.tif");
  const size = await fitPhoto(join(dir, job.photo.file), upright, deadline);
  const framed = join(tmp, "frame.tif");
  await framePhoto(upright, size, framed, deadline);
  const frame = join(tmp, "frame.ppm");
  await run("vips", ["copy", framed, frame], deadline);
  const small = modelSize(size);
  const input = join(tmp, "small.ppm");
  await run("vips", ["thumbnail", framed, input, String(small.w), "--height", String(small.h), "--size", "force"], deadline);

  const started = Date.now();
  const depthFile = join(tmp, "depth.pgm");
  await run("python3", [DEPTH_PY, MODEL, input, depthFile], deadline, 90_000);
  const depthMs = Date.now() - started;

  const scene = analyse(readDepth(await readFile(depthFile)), job.photo.faces);
  if (!scene || scene.edges < MIN_EDGES || scene.area < AREA.min || scene.area > AREA.max) {
    throw new Unsuitable("it has no clear subject in front of a background");
  }

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
