// A collage, with the vips command-line tools: each photo turned upright, cropped to its cell
// around its faces (layout.ts), made sRGB, scaled to fit, then placed on an off-white canvas
// and saved as a JPEG with its date and place (exif.ts). Every step writes an uncompressed TIFF
// into the job's tmp folder (server.ts removes it after the job): vips' own format is one of
// the "untrusted" loaders the container blocks.

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withExif } from "./exif.ts";
import { type CollageJob, OUTPUT_FILE } from "./job.ts";
import { chooseLayout, cropFor, type Size } from "./layout.ts";
import { type Deadline, run } from "./run.ts";
import { sizeOf } from "./vips.ts";

const BACKGROUND = "250 250 247";
const QUALITY = "88";

export async function renderCollage(job: CollageJob, dir: string, tmp: string, deadline: Deadline, maxBytes: number): Promise<void> {
  const upright: string[] = [];
  const sizes: Size[] = [];
  for (const [i, photo] of job.photos.entries()) {
    const file = join(tmp, `${i}-upright.tif`);
    await run("vips", ["autorot", join(dir, photo.file), file], deadline);
    upright.push(file);
    sizes.push(await sizeOf(file, deadline));
  }

  const layout = chooseLayout(sizes);
  await run("vips", ["black", join(tmp, "black.tif"), String(layout.canvas.w), String(layout.canvas.h), "--bands", "3"], deadline);
  let canvas = join(tmp, "canvas-0.tif");
  await run("vips", ["linear", join(tmp, "black.tif"), canvas, "1 1 1", BACKGROUND, "--uchar"], deadline);

  for (const [c, cell] of layout.cells.entries()) {
    const i = layout.order[c]!;
    const crop = cropFor(sizes[i]!, job.photos[i]!.faces, cell);
    const cropped = join(tmp, `${i}-crop.tif`);
    const srgb = join(tmp, `${i}-srgb.tif`);
    const scaled = join(tmp, `${i}-scaled.tif`);
    const tile = join(tmp, `${i}-tile.tif`);
    await run("vips", ["extract_area", upright[i]!, cropped, String(crop.x), String(crop.y), String(crop.w), String(crop.h)], deadline);
    await run("vips", ["icc_transform", cropped, srgb, "srgb", "--embedded", "--intent", "perceptual"], deadline);
    const scale = Math.max(cell.w / crop.w, cell.h / crop.h);
    await run("vips", ["resize", srgb, scaled, String(scale), "--kernel", "lanczos3"], deadline);
    await run("vips", ["extract_area", scaled, tile, "0", "0", String(cell.w), String(cell.h)], deadline);
    const next = join(tmp, `canvas-${c + 1}.tif`);
    await run("vips", ["insert", canvas, tile, next, String(cell.x), String(cell.y)], deadline);
    canvas = next;
  }

  const plain = join(tmp, "plain.jpg");
  await run("vips", ["jpegsave", canvas, plain, "--Q", QUALITY, "--keep", "none", "--optimize-coding"], deadline);
  const out = join(dir, OUTPUT_FILE.collage);
  await writeFile(out, withExif(await readFile(plain), job.stamp, layout.canvas));
  const { size } = await stat(out);
  if (size > maxBytes) throw new Error(`the collage came out too big (${size} bytes)`);
}
