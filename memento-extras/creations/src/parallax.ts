// The 3D camera move of a cinematic photo (cinematic.ts): from a photo and its depth (depth.py), the
// frames of a slow push-in with a slight sideways orbit around the subject.
// Run as its own process, it writes the frames as raw RGB to stdout, for ffmpeg:
// node parallax.ts <frame.ppm> <depth.pgm> <plan json>

import { readFile } from "node:fs/promises";
import { pnmHeader } from "./vips.ts";

export type Rgb = { w: number; h: number; data: Uint8Array };
export type Plane = { w: number; h: number; data: Float32Array };

export type Scene = { cut: number; subject: number; focus: { x: number; y: number }; edges: number; area: number };

export type Plan = { scene: Scene; frames: number; drift: 1 | -1 };

// How big the camera move is: the one number to tune (1 is very subtle).
export const MOVE_SIZE = 2;
const MOVE = {
  zoom: 0.05 * MOVE_SIZE,
  zoomDepth: 0.05 * MOVE_SIZE,
  orbit: 0.035 * MOVE_SIZE,
};
const MAX_MARGIN = 0.2;
const JUMP = 0.1;
const SOFT = 0.03;
const GROW = 2;
const CLEAR = 3;
const ITERATIONS = 4;
const GRID = 8;

// --- Reading the files vips and depth.py write --------------------------------------------------

export function readPpm(bytes: Uint8Array): Rgb {
  const { magic, w, h, max, offset } = pnmHeader(bytes);
  if (magic !== "P6" || max !== 255 || !(w > 0 && h > 0) || bytes.length - offset < w * h * 3) throw new Error("not an 8-bit PPM");
  return { w, h, data: bytes.subarray(offset, offset + w * h * 3) };
}

// A 16-bit PGM (as depth.py writes it) as values 0–1.
export function readDepth(bytes: Uint8Array): Plane {
  const { magic, w, h, max, offset } = pnmHeader(bytes);
  if (magic !== "P5" || max !== 65535 || !(w > 0 && h > 0) || bytes.length - offset < w * h * 2) throw new Error("not a 16-bit PGM");
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = ((bytes[offset + 2 * i]! << 8) | bytes[offset + 2 * i + 1]!) / 65535;
  return { w, h, data };
}

// --- Small operations on planes -----------------------------------------------------------------

const smoothstep = (lo: number, hi: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

function map(p: Plane, f: (v: number) => number): Plane {
  return { w: p.w, h: p.h, data: p.data.map(f) };
}

// One pass of a separable filter (box blur or maximum) of radius r, along x or y.
function pass(p: Plane, r: number, along: "x" | "y", op: "mean" | "max"): Plane {
  const { w, h, data } = p;
  const out = new Float32Array(w * h);
  const [n, len, step, stride] = along === "x" ? [h, w, 1, w] : [w, h, w, 1];
  for (let line = 0; line < n; line++) {
    const base = line * stride;
    for (let i = 0; i < len; i++) {
      let acc = op === "max" ? -Infinity : 0;
      for (let k = -r; k <= r; k++) {
        const v = data[base + Math.min(len - 1, Math.max(0, i + k)) * step]!;
        acc = op === "max" ? Math.max(acc, v) : acc + v;
      }
      out[base + i * step] = op === "max" ? acc : acc / (2 * r + 1);
    }
  }
  return { w, h, data: out };
}

export function blur(p: Plane, r: number): Plane {
  if (r < 1) return p;
  return pass(pass(pass(pass(p, r, "x", "mean"), r, "y", "mean"), r, "x", "mean"), r, "y", "mean");
}

export function dilate(p: Plane, r: number): Plane {
  return r < 1 ? p : pass(pass(p, r, "x", "max"), r, "y", "max");
}

// Fills in values where `weight` is low from the values around them; `channels` values a pixel.
export function fill(values: Float32Array, weight: Float32Array, w: number, h: number, channels: number): Float32Array {
  if (w <= 1 && h <= 1) return weight[0]! > 0 ? values.slice(0, channels) : new Float32Array(channels);
  const w2 = Math.ceil(w / 2);
  const h2 = Math.ceil(h / 2);
  const cv = new Float32Array(w2 * h2 * channels);
  const cw = new Float32Array(w2 * h2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const j = (y >> 1) * w2 + (x >> 1);
      const wt = weight[i]!;
      cw[j]! += wt;
      for (let c = 0; c < channels; c++) cv[j * channels + c]! += wt * values[i * channels + c]!;
    }
  }
  for (let j = 0; j < w2 * h2; j++) {
    const wt = cw[j]!;
    for (let c = 0; c < channels; c++) cv[j * channels + c] = wt > 0 ? cv[j * channels + c]! / wt : 0;
    cw[j] = Math.min(1, wt);
  }
  const coarse = fill(cv, cw, w2, h2, channels);
  const out = new Float32Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2));
    const y0 = Math.floor(cy);
    const y1 = Math.min(h2 - 1, y0 + 1);
    const fy = cy - y0;
    for (let x = 0; x < w; x++) {
      const cx = Math.min(w2 - 1, Math.max(0, (x - 0.5) / 2));
      const x0 = Math.floor(cx);
      const x1 = Math.min(w2 - 1, x0 + 1);
      const fx = cx - x0;
      const i = y * w + x;
      const wt = weight[i]!;
      for (let c = 0; c < channels; c++) {
        const top = coarse[(y0 * w2 + x0) * channels + c]! * (1 - fx) + coarse[(y0 * w2 + x1) * channels + c]! * fx;
        const bottom = coarse[(y1 * w2 + x0) * channels + c]! * (1 - fx) + coarse[(y1 * w2 + x1) * channels + c]! * fx;
        out[i * channels + c] = wt * values[i * channels + c]! + (1 - wt) * (top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

function fillPlane(p: Plane, weight: Plane): Plane {
  return { w: p.w, h: p.h, data: fill(p.data, weight.data, p.w, p.h, 1) };
}

// The plane's value at (x, y) in its own pixels, interpolated; clamped at the edges.
function sample(p: Plane, x: number, y: number): number {
  const { w, h, data } = p;
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = cx - x0;
  const fy = cy - y0;
  const top = data[y0 * w + x0]! + (data[y0 * w + x1]! - data[y0 * w + x0]!) * fx;
  const bottom = data[y1 * w + x0]! + (data[y1 * w + x1]! - data[y1 * w + x0]!) * fx;
  return top + (bottom - top) * fy;
}

// --- What the depth says ------------------------------------------------------------------------

// Finds the subject's outline in the depth; `faces` (fractions of the frame, if any) say where the subject is.
// Null if there's no clear outline.
export function analyse(depth: Plane, faces: Array<[number, number, number, number]> = []): Scene | null {
  const d = blur(depth, 1);
  const { w, h } = d;
  const BINS = 40;
  const votes = new Float64Array(BINS);
  const jumps: Array<{ near: number; far: number; x: number; y: number; dx: number; dy: number }> = [];
  for (let y = 0; y < h - 2; y++) {
    for (let x = 0; x < w - 2; x++) {
      const a = d.data[y * w + x]!;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const b = d.data[(y + 2 * dy) * w + x + 2 * dx]!;
        if (Math.abs(a - b) < JUMP) continue;
        jumps.push(a > b ? { near: a, far: b, x, y, dx: -dx, dy: -dy } : { near: b, far: a, x: x + 2 * dx, y: y + 2 * dy, dx, dy });
        for (let k = Math.ceil(Math.min(a, b) * BINS); k < Math.max(a, b) * BINS && k < BINS; k++) votes[k]!++;
      }
    }
  }
  let best = 0;
  for (let k = 1; k < BINS; k++) if (votes[k]! > votes[best]!) best = k;
  const cut = best / BINS;
  const outline = jumps.filter((j) => j.far < cut && j.near > cut);
  if (outline.length === 0) return null;
  const edges = outline.length / (w + h);
  const area = d.data.reduce((n, v) => n + (v > cut ? 1 : 0), 0) / (w * h);
  const inside = outline.map(({ x, y, dx, dy }) => {
    let v = 0;
    for (let k = 0; k <= 3; k++) {
      const px = Math.min(w - 1, Math.max(0, x + k * dx));
      const py = Math.min(h - 1, Math.max(0, y + k * dy));
      v = Math.max(v, depth.data[py * w + px]!);
    }
    return v;
  }).sort((a, b) => a - b);
  const subject = inside[Math.floor(inside.length / 2)]!;
  const middle = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
  const focus = faces.length > 0
    ? { x: middle(faces.map((f) => (f[0] + f[2]) / 2)), y: middle(faces.map((f) => (f[1] + f[3]) / 2)) }
    : { x: middle(outline.map((j) => j.x)) / (w - 1), y: middle(outline.map((j) => j.y)) / (h - 1) };
  return { cut, subject, focus, edges, area };
}

// --- The layers and the move --------------------------------------------------------------------

export type Layers = {
  photo: Rgb;
  background: Rgb;
  alpha: Plane;
  near: Plane;
  far: Plane;
  box: { x0: number; y0: number; x1: number; y1: number };
};

export function layers(photo: Rgb, depth: Plane, scene: Scene): Layers {
  const grown = dilate(depth, GROW);
  const alpha = map(grown, (v) => smoothstep(scene.cut - SOFT, scene.cut + SOFT, v));
  const solid = map(alpha, (a) => smoothstep(0.5, 1, a));
  const near = blur(fillPlane(grown, solid), 1);
  const clean = map(dilate(alpha, CLEAR), (a) => 1 - a);
  const far = blur(fillPlane(depth, clean), 3);

  const { w, h, data } = photo;
  const sx = depth.w / w;
  const sy = depth.h / h;
  const weight = new Float32Array(w * h);
  const values = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      weight[i] = sample(clean, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      values[i * 3] = data[i * 3]!;
      values[i * 3 + 1] = data[i * 3 + 1]!;
      values[i * 3 + 2] = data[i * 3 + 2]!;
    }
  }
  const filled = fill(values, weight, w, h, 3);
  const background = new Uint8Array(w * h * 3);
  let box = { x0: w, y0: h, x1: -1, y1: -1 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = sample(alpha, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      const k = smoothstep(0, 0.25, a);
      for (let c = 0; c < 3; c++) background[i * 3 + c] = Math.round((1 - k) * data[i * 3 + c]! + k * filled[i * 3 + c]!);
      if (a > 0.004) box = { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
    }
  }
  return { photo, background: { w, h, data: background }, alpha, near, far, box };
}

// The camera at time e (0 → 1, eased): the zoom centre, and how a pixel at depth v is scaled and shifted.
type Camera = { cx: number; cy: number; scale: (v: number) => number; shift: (v: number) => number };

function camera(plan: Plan, w: number, h: number, e: number, margin: number): Camera {
  const { scene, drift } = plan;
  const cx = ((0.5 + scene.focus.x) / 2) * w;
  const cy = ((0.5 + scene.focus.y) / 2) * h;
  const long = Math.max(w, h);
  return {
    cx,
    cy,
    scale: (v) => (1 + margin) * (1 + e * (MOVE.zoom + MOVE.zoomDepth * (v - scene.subject))),
    shift: (v) => (e - 0.5) * MOVE.orbit * long * (v - scene.subject) * drift,
  };
}

// The zoom that keeps the frame's edges inside the photo, at most MAX_MARGIN.
export function marginFor(plan: Plan, w: number, h: number): number {
  for (let margin = 0; margin < MAX_MARGIN; margin += 0.005) {
    let inside = true;
    for (const e of [0, 0.5, 1]) {
      const cam = camera(plan, w, h, e, margin);
      for (const v of [0, 1]) {
        for (const x of [0, w]) {
          const u = cam.cx + (x - cam.cx - cam.shift(v)) / cam.scale(v);
          if (u < 0 || u > w) inside = false;
        }
      }
    }
    if (inside) return margin;
  }
  return MAX_MARGIN;
}

// Eased time for frame i of n: slow in, slow out.
export const ease = (i: number, n: number) => smoothstep(0, 1, n > 1 ? i / (n - 1) : 0);

// Where each point of a GRID-pixel grid over the frame comes from in a layer of depth `depth`, as x, y pairs.
function locate(depth: Plane, cam: Camera, w: number, h: number, gw: number, gh: number): Float32Array {
  const sx = depth.w / w;
  const sy = depth.h / h;
  const out = new Float32Array(gw * gh * 2);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * GRID;
      const y = gy * GRID;
      let ux = x;
      let uy = y;
      for (let k = 0; k < ITERATIONS; k++) {
        const v = sample(depth, (ux + 0.5) * sx - 0.5, (uy + 0.5) * sy - 0.5);
        const s = cam.scale(v);
        ux = cam.cx + (x - cam.cx - cam.shift(v)) / s;
        uy = cam.cy + (y - cam.cy) / s;
      }
      out[(gy * gw + gx) * 2] = ux;
      out[(gy * gw + gx) * 2 + 1] = uy;
    }
  }
  return out;
}

// The colour of `img` (w × h) at (x, y), interpolated, into rgb.
function read(img: Uint8Array, w: number, h: number, x: number, y: number, rgb: Float32Array): void {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = (y0 * w + x0) * 3;
  const b = x0 + 1 < w ? a + 3 : a;
  const c = y0 + 1 < h ? a + w * 3 : a;
  const d = x0 + 1 < w ? c + 3 : c;
  for (let k = 0; k < 3; k++) {
    const top = img[a + k]! + (img[b + k]! - img[a + k]!) * fx;
    const bottom = img[c + k]! + (img[d + k]! - img[c + k]!) * fx;
    rgb[k] = top + (bottom - top) * fy;
  }
}

// Draws frame i into `out` (w × h × 3 bytes, the photo's size).
export function drawFrame(l: Layers, plan: Plan, i: number, margin: number, out: Uint8Array): void {
  const { w, h } = l.photo;
  const cam = camera(plan, w, h, ease(i, plan.frames), margin);
  const gw = Math.ceil((w - 1) / GRID) + 1;
  const gh = Math.ceil((h - 1) / GRID) + 1;
  const hasSubject = l.box.x1 >= 0;
  const near = hasSubject ? locate(l.near, cam, w, h, gw, gh) : null;
  const far = locate(l.far, cam, w, h, gw, gh);
  const corners = [[l.box.x0, l.box.y0], [l.box.x1 + 1, l.box.y1 + 1]].flatMap(([x, y]) =>
    [0, 1].map((v) => [cam.cx + (x! - cam.cx) * cam.scale(v) + cam.shift(v), cam.cy + (y! - cam.cy) * cam.scale(v)]));
  const bx0 = Math.min(...corners.map((c) => c[0]!)) - 1;
  const bx1 = Math.max(...corners.map((c) => c[0]!)) + 1;
  const by0 = Math.min(...corners.map((c) => c[1]!)) - 1;
  const by1 = Math.max(...corners.map((c) => c[1]!)) + 1;
  const sx = l.alpha.w / w;
  const sy = l.alpha.h / h;
  const front = new Float32Array(3);
  const back = new Float32Array(3);

  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / GRID);
    const fy = y / GRID - gy;
    const inRows = hasSubject && y >= by0 && y <= by1;
    for (let x = 0; x < w; x++) {
      const gx = Math.floor(x / GRID);
      const fx = x / GRID - gx;
      const p = (gy * gw + gx) * 2;
      const q = p + gw * 2;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      let alpha = 0;
      if (inRows && x >= bx0 && x <= bx1) {
        const ux = near![p]! * w00 + near![p + 2]! * w10 + near![q]! * w01 + near![q + 2]! * w11;
        const uy = near![p + 1]! * w00 + near![p + 3]! * w10 + near![q + 1]! * w01 + near![q + 3]! * w11;
        alpha = sample(l.alpha, (ux + 0.5) * sx - 0.5, (uy + 0.5) * sy - 0.5);
        if (alpha > 0.002) read(l.photo.data, w, h, ux, uy, front);
      }
      if (alpha < 0.998) {
        const ux = far[p]! * w00 + far[p + 2]! * w10 + far[q]! * w01 + far[q + 2]! * w11;
        const uy = far[p + 1]! * w00 + far[p + 3]! * w10 + far[q + 1]! * w01 + far[q + 3]! * w11;
        read(l.background.data, w, h, ux, uy, back);
      }
      const o = (y * w + x) * 3;
      if (alpha <= 0.002) {
        out[o] = back[0]! + 0.5;
        out[o + 1] = back[1]! + 0.5;
        out[o + 2] = back[2]! + 0.5;
      } else if (alpha >= 0.998) {
        out[o] = front[0]! + 0.5;
        out[o + 1] = front[1]! + 0.5;
        out[o + 2] = front[2]! + 0.5;
      } else {
        out[o] = alpha * front[0]! + (1 - alpha) * back[0]! + 0.5;
        out[o + 1] = alpha * front[1]! + (1 - alpha) * back[1]! + 0.5;
        out[o + 2] = alpha * front[2]! + (1 - alpha) * back[2]! + 0.5;
      }
    }
  }
}

// --- As its own process ---------------------------------------------------------------------------

async function main(framePath: string, depthPath: string, planJson: string): Promise<void> {
  const plan = JSON.parse(planJson) as Plan;
  const photo = readPpm(await readFile(framePath));
  const depth = readDepth(await readFile(depthPath));
  const l = layers(photo, depth, plan.scene);
  const margin = marginFor(plan, photo.w, photo.h);
  const out = Buffer.alloc(photo.w * photo.h * 3);
  for (let i = 0; i < plan.frames; i++) {
    drawFrame(l, plan, i, margin, out);
    await new Promise<void>((resolve, reject) => process.stdout.write(out, (error) => (error ? reject(error) : resolve())));
  }
}

if (import.meta.main) {
  const [framePath, depthPath, planJson] = process.argv.slice(2);
  main(framePath!, depthPath!, planJson!).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
