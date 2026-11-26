// Cinematic photos' own maths (parallax.ts, cinematic.ts): the subject, the fill behind it, and the 3D move.

import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSize } from "../creations/src/cinematic.ts";
import { analyse, drawFrame, fill, layers, marginFor, type Plan, type Plane, readDepth, type Rgb } from "../creations/src/parallax.ts";

function square(w: number, h: number): Plane {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x >= w / 3 && x < (2 * w) / 3 && y >= h / 3 && y < (2 * h) / 3 ? 0.9 : 0.2;
  return { w, h, data };
}

test("the model's input: its long side 518, both sides multiples of 14, the frame's shape", () => {
  assert.deepEqual(modelSize({ w: 1440, h: 1080 }), { w: 518, h: 392 });
  assert.deepEqual(modelSize({ w: 1080, h: 1920 }), { w: 294, h: 518 });
  assert.deepEqual(modelSize({ w: 640, h: 480 }), { w: 518, h: 392 });
  assert.deepEqual(modelSize({ w: 1920, h: 200 }), { w: 518, h: 56 });
});

test("depth.py's 16-bit map is read as 0–1, nearest 1", () => {
  const header = Buffer.from("P5\n2 1\n65535\n", "latin1");
  const depth = readDepth(Buffer.concat([header, Buffer.from([0xff, 0xff, 0x00, 0x00])]));
  assert.deepEqual([...depth.data], [1, 0]);
  assert.throws(() => readDepth(Buffer.from("P5\n2 1\n255\n\0\0", "latin1")));
});

test("the subject is what's in front of the sharpest depth edges; a flat scene has none", () => {
  const scene = analyse(square(90, 60))!;
  assert.ok(scene.cut > 0.2 && scene.cut < 0.9, `cut ${scene.cut}`);
  assert.ok(Math.abs(scene.subject - 0.9) < 0.1, `subject ${scene.subject}`);
  assert.ok(Math.abs(scene.focus.x - 0.5) < 0.05 && Math.abs(scene.focus.y - 0.5) < 0.05, "its outline's middle");
  assert.ok(scene.edges > 0.35 && Math.abs(scene.area - 1 / 9) < 0.03);
  const withFaces = analyse(square(90, 60), [[0.1, 0.1, 0.2, 0.3]])!.focus;
  assert.ok(Math.abs(withFaces.x - 0.15) < 1e-9 && Math.abs(withFaces.y - 0.2) < 1e-9);
  assert.equal(analyse({ w: 40, h: 30, data: new Float32Array(1200).fill(0.5) }), null);
  const slope = { w: 40, h: 30, data: Float32Array.from({ length: 1200 }, (_, i) => Math.floor(i / 40) / 30) };
  assert.equal(analyse(slope), null);
});

test("filling in keeps what's there and spreads the neighbours into what isn't", () => {
  const values = Float32Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? 10 : 30));
  const weight = Float32Array.from({ length: 64 }, (_, i) => (i % 8 === 3 || i % 8 === 4 ? 0 : 1));
  const out = fill(values, weight, 8, 8, 1);
  for (let i = 0; i < 64; i++) {
    if (weight[i]) assert.equal(out[i], values[i]);
    else assert.ok(out[i]! > 10 && out[i]! < 30, `between its neighbours: ${out[i]}`);
  }
});

test("the move: the background slides behind a still subject, with no holes and no edge showing", () => {
  const w = 120;
  const h = 80;
  const depthMap = square(60, 40);
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const near = x >= w / 3 && x < (2 * w) / 3 && y >= h / 3 && y < (2 * h) / 3;
      data.set(near ? [0, 0, 255] : [40 + x * 1.5, 120, 0], (y * w + x) * 3);
    }
  }
  const photo: Rgb = { w, h, data };
  const scene = analyse(depthMap)!;
  const plan: Plan = { scene, frames: 25, drift: 1 };
  const l = layers(photo, depthMap, scene);
  const margin = marginFor(plan, w, h);
  assert.ok(margin > 0 && margin < 0.2);
  const frame = (i: number) => {
    const out = new Uint8Array(w * h * 3);
    drawFrame(l, plan, i, margin, out);
    return out;
  };
  const first = frame(0);
  const last = frame(24);
  const blueMiddle = (f: Uint8Array) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < w * h; i++) if (f[i * 3 + 2]! > 200 && f[i * 3]! < 60) (sum += i % w), n++;
    return sum / n;
  };
  for (const f of [first, last]) {
    for (let i = 0; i < w * h; i++) assert.ok(f[i * 3]! + f[i * 3 + 1]! + f[i * 3 + 2]! > 60, "no black holes or torn edges");
  }
  assert.ok(Math.abs(blueMiddle(first) - blueMiddle(last)) < 4, "the subject stays (about) where it is");
  const left = (f: Uint8Array) => f[(40 * w + 5) * 3]!;
  assert.ok(left(last) - left(first) > 3, `the background slides: ${left(first)} → ${left(last)}`);
});
