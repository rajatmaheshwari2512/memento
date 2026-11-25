// SelfPhotos AI tools: highlighting an area, and pasting just that area back. Not part of Immich.
//
// The AI redraws fine detail across the whole photo, even when asked to change one area
// (FEATURES.md, section 5: the test). So for an edit of a highlighted area:
//   1. the brush's strokes mark the area; the AI gets the photo, plus a small copy with that
//      area tinted red (markedCopy), and "change only the highlighted area";
//   2. only that area of its result is pasted onto the original, with a soft edge (pasteOnto,
//      on the screen-sized preview to show it, and pasteBack at full size to save it): the rest
//      of the photo keeps its own pixels.
// LATER (phase 2, FEATURES.md "Cutting Gemini's cost"; not built): the AI gets the whole photo at
// 4K (~₹12). Phase 2 sends only a crop of about twice the highlighted area at 2K (~₹4–5.5); the
// paste here would then place the result over that crop instead of over the whole photo.
//
// Strokes are kept in the photo's own proportions (x and y from 0 to 1, the radius as a share of
// the longer side), so the same strokes draw the highlight on screen, the marked copy and the
// mask at any size. Android does the same with the same numbers (ai-tools.json, "area").
//
// The full-size paste starts from the same picture Adjust saves from (readSource: the original
// as Immich shows it, upright, with Immich's own crop), stretches the result to its size, lines
// it up (ai-align.ts: the AI's content drifts by a fraction of a percent), and works only on the
// part of the photo the mask covers, a tile at a time. If the AI changed the photo's shape
// (portrait for landscape, or a crop), or its result can't be lined up closely enough, nothing
// is pasted (ShapeChangedError) and the person is offered another try (alignFor). The result
// was paid for, so it's kept, to use whole or try again; also when anything else goes wrong
// lining it up or pasting it (refusalOf), on the preview or at full size at Save.

import { AdjustExportError, copyType, readSource, toBlob } from '#lib/ai-edit/adjust/adjust-export.ts';
import { tiles, type Rect, type Size } from '#lib/ai-edit/adjust/adjust-geometry.ts';
import { IDENTITY, boxBlur, estimateAlignment, type Alignment, type Grey } from '#lib/ai-edit/ai/ai-align.ts';
import { AREA, isFullSize } from '#lib/ai-edit/ai/ai-tools.ts';
import type { Point } from '#lib/ai-edit/pointer.ts';
import type { AssetResponseDto } from '@immich/sdk';

export type Stroke = { points: Point[]; radius: number };

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const fit = (size: Size, longSide: number): Size => {
  const scale = Math.min(1, longSide / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
};

// The strokes, filled in one colour, on a canvas of `size`.
export function drawStrokes(context: Context2D, strokes: Stroke[], size: Size, colour: string) {
  const longer = Math.max(size.width, size.height);
  context.save();
  context.fillStyle = colour;
  context.strokeStyle = colour;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const { points, radius } of strokes) {
    const [first, ...rest] = points;
    if (!first) {
      continue;
    }
    const r = radius * longer;
    if (rest.length === 0) {
      context.beginPath();
      context.arc(first[0] * size.width, first[1] * size.height, r, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.lineWidth = r * 2;
    context.beginPath();
    context.moveTo(first[0] * size.width, first[1] * size.height);
    for (const [x, y] of rest) {
      context.lineTo(x * size.width, y * size.height);
    }
    context.stroke();
  }
  context.restore();
}

// The copy the AI gets with the photo: `image` (what the user brushed on), small, with the
// highlighted area tinted red, as a JPEG.
export async function markedCopy(image: ImageBitmap, strokes: Stroke[]): Promise<Blob> {
  const size = fit(image, AREA.markLongSide);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const layer = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d')!;
  const [r, g, b, alpha] = AREA.tint;
  context.drawImage(image, 0, 0, size.width, size.height);
  // Drawn solid on a layer first, so overlapping strokes aren't darker.
  drawStrokes(layer.getContext('2d')!, strokes, size, `rgb(${r}, ${g}, ${b})`);
  context.globalAlpha = alpha;
  context.drawImage(layer, 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: AREA.markQuality });
}

// Softens a mask's edges: three box blurs, about a Gaussian's (canvas blur filters aren't in
// every browser).
function feather(alpha: Float32Array, { width, height }: Size, radius: number): Float32Array {
  let soft = alpha;
  for (let n = 0; n < 3; n++) {
    soft = boxBlur(soft, width, height, radius);
  }
  return soft;
}

export type AreaMask = {
  canvas: OffscreenCanvas;
  // The part of the photo it covers (0–1), or null when it covers nothing.
  bounds: Rect | null;
};

// The highlighted area of a photo of shape `shape`: white with soft edges on transparent,
// small (it's stretched to any size).
export function areaMask(strokes: Stroke[], shape: Size): AreaMask {
  const size = fit(shape, AREA.maskLongSide);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  drawStrokes(context, strokes, size, '#fff');
  const pixels = context.getImageData(0, 0, size.width, size.height);
  const alpha = new Float32Array(size.width * size.height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = pixels.data[i * 4 + 3];
  }
  const soft = feather(alpha, size, Math.max(1, Math.round(AREA.feather * Math.max(size.width, size.height))));
  let [x0, y0, x1, y1] = [size.width, size.height, -1, -1];
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const value = Math.round(soft[y * size.width + x]);
      pixels.data.set([255, 255, 255, value], (y * size.width + x) * 4);
      if (value > 0) {
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    }
  }
  context.putImageData(pixels, 0, 0);
  const bounds =
    x1 < 0
      ? null
      : {
          x: x0 / size.width,
          y: y0 / size.height,
          width: (x1 + 1 - x0) / size.width,
          height: (y1 + 1 - y0) / size.height,
        };
  return { canvas, bounds };
}

// Whether the AI kept the photo's shape, so its result lines up with the original (it returns
// its own size class, e.g. 3050×1408 for 3120×1440).
export const sameShape = (result: Size, original: Size) =>
  Math.abs(result.width / result.height / (original.width / original.height) - 1) <= AREA.shapeTolerance;

// The AI's result can't be pasted: another shape, or (`alignment`) it couldn't be lined up
// closely enough. The person can still use the whole result, or try again.
export class ShapeChangedError extends Error {
  constructor(readonly alignment: Alignment | null = null) {
    super('The AI’s result doesn’t line up with the photo');
  }
}

// Why a paid highlighted edit's result is kept unpasted, to use whole or try again: 'shape' for
// the normal refusal (ShapeChangedError), 'failed' for anything else that went wrong lining it up
// or pasting it (it was paid for, so it's never thrown away). Each has its own note.
export const refusalOf = (error: unknown): 'shape' | 'failed' =>
  error instanceof ShapeChangedError ? 'shape' : 'failed';

// The photo can't be read here at full size (isFullSize), only Immich's preview of it (e.g. HEIC
// outside Safari): a highlighted edit's copy couldn't be saved (the service refuses one that isn't
// full size), so the edit isn't made (said before anything is paid for), nor its copy pasted.
export class NeedsOriginalError extends Error {}

// For a first highlighted edit: the photo upright, as the paste starts from it (readSource), at
// most AREA.photoLongSide, as a JPEG for the AI, and that picture (for the mark, so the two match).
export async function uprightPhoto(asset: AssetResponseDto): Promise<{ blob: Blob; image: ImageBitmap }> {
  const source = await readSource(asset);
  try {
    if (!isFullSize(source, asset)) {
      throw new NeedsOriginalError();
    }
    const size = fit(source, AREA.photoLongSide);
    const image = await createImageBitmap(source, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: 'high',
    });
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: AREA.photoQuality }), image };
  } finally {
    source.close();
  }
}

// The pixels of `image` stretched to `size`.
function pixelsOf(image: CanvasImageSource, size: Size) {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height).data;
}

// `image` shrunk to `size` (smoothly: a 4K result is shrunk about 4×), in grey.
async function greyOf(image: ImageBitmap, size: Size): Promise<Grey> {
  const small = await createImageBitmap(image, {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality: 'high',
  });
  try {
    const data = pixelsOf(small, size);
    const grey = new Float32Array(size.width * size.height);
    for (let i = 0; i < grey.length; i++) {
      grey[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return { ...size, data: grey };
  } finally {
    small.close();
  }
}

// The highlighted area at `size`: its mask's alpha.
function changedOf(strokes: Stroke[], size: Size): Grey {
  const data = pixelsOf(areaMask(strokes, size).canvas, size);
  const alpha = new Float32Array(size.width * size.height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3];
  }
  return { ...size, data: alpha };
}

// How to line `result` up with `base` (the photo as shown) before pasting the highlighted area,
// measured once and used for the preview and the full-size copy alike. Throws ShapeChangedError
// when the result has another shape or can't be lined up closely enough: pasting would misalign.
export async function alignFor(base: ImageBitmap, result: ImageBitmap, strokes: Stroke[]): Promise<Alignment> {
  if (!sameShape(result, base)) {
    throw new ShapeChangedError();
  }
  const size = fit(base, AREA.alignLongSide);
  const alignment = estimateAlignment(await greyOf(base, size), await greyOf(result, size), changedOf(strokes, size));
  if (alignment && alignment.error > AREA.maxMisalignment) {
    throw new ShapeChangedError(alignment);
  }
  return alignment ?? IDENTITY;
}

// The pixels of the photo (`size`) the mask's bounds cover, a little wider, on whole pixels.
function region(bounds: Rect, size: Size): Rect {
  const x = Math.max(0, Math.floor(bounds.x * size.width) - 2);
  const y = Math.max(0, Math.floor(bounds.y * size.height) - 2);
  const right = Math.min(size.width, Math.ceil((bounds.x + bounds.width) * size.width) + 2);
  const bottom = Math.min(size.height, Math.ceil((bounds.y + bounds.height) * size.height) + 2);
  return { x, y, width: right - x, height: bottom - y };
}

// `result` drawn through the mask onto `context` (which shows the base at `size`), in `tile`, lined
// up by `alignment`.
function pasteTile(
  context: Context2D,
  layer: OffscreenCanvas,
  result: ImageBitmap,
  mask: AreaMask,
  size: Size,
  tile: Rect,
  alignment: Alignment,
) {
  layer.width = tile.width; // also clears it
  layer.height = tile.height;
  const work = layer.getContext('2d')!;
  const part = (source: Size, { scaleX, offsetX, scaleY, offsetY }: Alignment) => {
    const sx = source.width / size.width;
    const sy = source.height / size.height;
    return [
      (tile.x * scaleX + offsetX * size.width) * sx,
      (tile.y * scaleY + offsetY * size.height) * sy,
      tile.width * scaleX * sx,
      tile.height * scaleY * sy,
    ] as const;
  };
  work.drawImage(result, ...part(result, alignment), 0, 0, tile.width, tile.height);
  work.globalCompositeOperation = 'destination-in';
  work.drawImage(mask.canvas, ...part(mask.canvas, IDENTITY), 0, 0, tile.width, tile.height);
  context.drawImage(layer, tile.x, tile.y);
}

// The highlighted area of `result` pasted onto `base`, at base's size, lined up by `alignment`
// (alignFor), encoded. Works a tile at a time, only where the mask is. `tileSize` is only set by
// the tests.
export async function pasteOnto(
  base: ImageBitmap,
  result: ImageBitmap,
  strokes: Stroke[],
  type: 'image/jpeg' | 'image/png',
  alignment: Alignment = IDENTITY,
  tileSize = 2048,
): Promise<{ blob: Blob; size: Size }> {
  const size = { width: base.width, height: base.height };
  if (!sameShape(result, size)) {
    throw new ShapeChangedError();
  }
  const canvas = document.createElement('canvas');
  const layer = new OffscreenCanvas(1, 1);
  try {
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context || canvas.width !== size.width || canvas.height !== size.height) {
      throw new AdjustExportError('too-large');
    }
    context.drawImage(base, 0, 0);
    // A canvas that's too big for the browser takes nothing in, without an error: compare its
    // centre with the base's.
    const probe = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
    const [cx, cy] = [Math.floor(size.width / 2), Math.floor(size.height / 2)];
    probe.drawImage(base, cx, cy, 1, 1, 0, 0, 1, 1);
    if (context.getImageData(cx, cy, 1, 1).data[3] !== probe.getImageData(0, 0, 1, 1).data[3]) {
      throw new AdjustExportError('too-large');
    }

    const mask = areaMask(strokes, size);
    if (mask.bounds) {
      const area = region(mask.bounds, size);
      for (const tile of tiles(area, tileSize)) {
        pasteTile(context, layer, result, mask, size, { ...tile, x: area.x + tile.x, y: area.y + tile.y }, alignment);
        await new Promise((resolve) => setTimeout(resolve, 0)); // let the page update between tiles
      }
    }

    const blob = await toBlob(canvas, type);
    if (!blob || blob.size === 0) {
      throw new AdjustExportError('too-large');
    }
    return { blob, size };
  } finally {
    // Free their memory now, not at the next garbage collection.
    canvas.width = canvas.height = 0;
    layer.width = layer.height = 0;
  }
}

// The copy saved for an edit of a highlighted area: the original at full size, as Adjust reads
// it, with that area of the AI's result pasted on, lined up as on the preview. Only from the photo
// at full size (isFullSize): from anything smaller (NeedsOriginalError), nothing is pasted or sent.
export async function pasteBack(
  asset: AssetResponseDto,
  result: ImageBitmap,
  strokes: Stroke[],
  alignment: Alignment,
): Promise<Blob> {
  const image = await readSource(asset);
  try {
    if (!isFullSize(image, asset)) {
      throw new NeedsOriginalError();
    }
    const { blob } = await pasteOnto(image, result, strokes, copyType(asset), alignment);
    return blob;
  } finally {
    image.close();
  }
}
