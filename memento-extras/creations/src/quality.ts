// A cheap check of a photo from Immich's small thumbnail: how sharp it is and how it's exposed
// (mean brightness, how dark its brightest pixels or how bright its darkest are).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Deadline, run } from "./run.ts";
import { pnmHeader } from "./vips.ts";

export type Quality = {
  sharpness: number; // variance of the Laplacian; blurred shots are low
  brightness: number; // mean, 0–255
  p2: number; // 2% of pixels are darker than this
  p98: number; // 2% are brighter than this
};

export type Grey = { w: number; h: number; pixels: Uint8Array };

// A binary PPM (P6, colour) or PGM (P5, grey) as greyscale.
export function parsePnm(bytes: Uint8Array): Grey {
  const { magic, w, h, max, offset: pos } = pnmHeader(bytes);
  const bands = magic === "P6" ? 3 : magic === "P5" ? 1 : 0;
  if (!bands || !(w > 0 && h > 0) || max !== 255 || bytes.length - pos < w * h * bands) throw new Error("not an 8-bit PPM/PGM");
  const pixels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const at = pos + i * bands;
    pixels[i] = bands === 1 ? bytes[at]! : Math.round(0.299 * bytes[at]! + 0.587 * bytes[at + 1]! + 0.114 * bytes[at + 2]!);
  }
  return { w, h, pixels };
}

export function measure({ w, h, pixels }: Grey): Quality {
  if (w < 3 || h < 3) throw new Error("too small to measure");
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * pixels[i]! - pixels[i - 1]! - pixels[i + 1]! - pixels[i - w]! - pixels[i + w]!;
      sum += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  const histogram = new Array<number>(256).fill(0);
  let total = 0;
  for (const p of pixels) {
    histogram[p]!++;
    total += p;
  }
  const percentile = (q: number) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += histogram[v]!;
      if (seen >= q * pixels.length) return v;
    }
    return 255;
  };
  const mean = sum / n;
  return { sharpness: sum2 / n - mean * mean, brightness: total / pixels.length, p2: percentile(0.02), p98: percentile(0.98) };
}

// Each file in the job's folder, measured; null for one that couldn't be read.
export async function measureFiles(files: string[], dir: string, tmp: string, deadline: Deadline): Promise<Array<Quality | null>> {
  const out: Array<Quality | null> = [];
  for (const [i, file] of files.entries()) {
    try {
      const pnm = join(tmp, `${i}.ppm`);
      await run("vips", ["thumbnail", join(dir, file), pnm, "256"], deadline, 20_000);
      out.push(measure(parsePnm(await readFile(pnm))));
    } catch (error) {
      if (error instanceof Error && error.message === "took too long") throw error;
      out.push(null);
    }
  }
  return out;
}
