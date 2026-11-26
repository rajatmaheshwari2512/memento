// SelfPhotos AI tools: highlighting an area, and pasting just that area back.

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

// The copy the AI gets with the photo.
export async function markedCopy(image: ImageBitmap, strokes: Stroke[]): Promise<Blob> {
  const size = fit(image, AREA.markLongSide);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const layer = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d')!;
  const [r, g, b, alpha] = AREA.tint;
  context.drawImage(image, 0, 0, size.width, size.height);
  drawStrokes(layer.getContext('2d')!, strokes, size, `rgb(${r}, ${g}, ${b})`);
  context.globalAlpha = alpha;
  context.drawImage(layer, 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: AREA.markQuality });
}

function feather(alpha: Float32Array, { width, height }: Size, radius: number): Float32Array {
  let soft = alpha;
  for (let n = 0; n < 3; n++) {
    soft = boxBlur(soft, width, height, radius);
  }
  return soft;
}

export type AreaMask = {
  canvas: OffscreenCanvas;
  bounds: Rect | null;
};

// The highlighted area of a photo of shape `shape`.
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

// Whether the AI kept the photo's shape.
export const sameShape = (result: Size, original: Size) =>
  Math.abs(result.width / result.height / (original.width / original.height) - 1) <= AREA.shapeTolerance;

// The AI's result can't be pasted.
export class ShapeChangedError extends Error {
  constructor(readonly alignment: Alignment | null = null) {
    super('The AI’s result doesn’t line up with the photo');
  }
}

export const refusalOf = (error: unknown): 'shape' | 'failed' =>
  error instanceof ShapeChangedError ? 'shape' : 'failed';

// The photo can't be read here at full size (isFullSize).
export class NeedsOriginalError extends Error {}

// For a first highlighted edit.
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

function pixelsOf(image: CanvasImageSource, size: Size) {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height).data;
}

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

function changedOf(strokes: Stroke[], size: Size): Grey {
  const data = pixelsOf(areaMask(strokes, size).canvas, size);
  const alpha = new Float32Array(size.width * size.height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3];
  }
  return { ...size, data: alpha };
}

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

function region(bounds: Rect, size: Size): Rect {
  const x = Math.max(0, Math.floor(bounds.x * size.width) - 2);
  const y = Math.max(0, Math.floor(bounds.y * size.height) - 2);
  const right = Math.min(size.width, Math.ceil((bounds.x + bounds.width) * size.width) + 2);
  const bottom = Math.min(size.height, Math.ceil((bounds.y + bounds.height) * size.height) + 2);
  return { x, y, width: right - x, height: bottom - y };
}

function pasteTile(
  context: Context2D,
  layer: OffscreenCanvas,
  result: ImageBitmap,
  mask: AreaMask,
  size: Size,
  tile: Rect,
  alignment: Alignment,
) {
  layer.width = tile.width;
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
// (alignFor), encoded.
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
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const blob = await toBlob(canvas, type);
    if (!blob || blob.size === 0) {
      throw new AdjustExportError('too-large');
    }
    return { blob, size };
  } finally {
    canvas.width = canvas.height = 0;
    layer.width = layer.height = 0;
  }
}

// The copy saved for an edit of a highlighted area.
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
