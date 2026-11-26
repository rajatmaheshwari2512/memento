// SelfPhotos Adjust: the full-size render that's saved as the copy.

import {
  outputSize,
  sourceRect,
  tileSizeFor,
  tileSizeWithin,
  tiles,
  type Size,
} from '#lib/ai-edit/adjust/adjust-geometry.ts';
import { shaderValues, type AdjustState } from '#lib/ai-edit/adjust/adjust-params.ts';
import { AdjustRenderer } from '#lib/ai-edit/adjust/adjust-renderer.ts';
import { drawMarkup, markupFontReady, type MarkupItem } from '#lib/ai-edit/adjust/markup.ts';
import { getAssetMediaUrl } from '#lib/utils.ts';
import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';

const BROWSER_FORMATS = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
]);

const JPEG_QUALITY = 0.92;

const MAX_PART = 4096;

export class AdjustExportError extends Error {
  constructor(readonly reason: 'too-large' | 'unreadable' | 'gpu') {
    super(reason);
  }
}

export type ExportResult = {
  blob: Blob;
  size: Size;
  fromPreview: boolean;
};

// The pictures to try, best first.
export function sourceUrls(asset: AssetResponseDto): string[] {
  const { id, isEdited } = asset;
  const urls: string[] = [];
  if (isEdited || BROWSER_FORMATS.has(asset.originalMimeType ?? '')) {
    urls.push(getAssetMediaUrl({ id, size: AssetMediaSize.Original, edited: isEdited }));
  }
  urls.push(
    getAssetMediaUrl({ id, size: AssetMediaSize.Fullsize, edited: isEdited }),
    getAssetMediaUrl({ id, size: AssetMediaSize.Preview, edited: true }),
  );
  return [...new Set(urls)];
}

// Reads a picture upright, with its colours as stored (not premultiplied).
export async function readImage(url: string): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await createImageBitmap(await response.blob(), {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'default',
    });
  } catch {
    return null;
  }
}

// The best of sourceUrls this browser can read.
export async function readSource(asset: AssetResponseDto): Promise<ImageBitmap> {
  for (const url of sourceUrls(asset)) {
    const image = await readImage(url);
    if (image) {
      return image;
    }
  }
  throw new AdjustExportError('unreadable');
}

const hasVisiblePixel = (pixels: Uint8ClampedArray) => {
  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
    if (pixels[alpha] > 0) {
      return true;
    }
  }
  return false;
};

export const toBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));

// PNG originals stay PNG (they may have transparent parts); everything else becomes a JPEG.
export const copyType = (asset: AssetResponseDto) =>
  /\.png$/i.test(asset.originalFileName) ? ('image/png' as const) : ('image/jpeg' as const);

export const fromPreview = (asset: AssetResponseDto, image: ImageBitmap) => {
  const largest = Math.max(asset.width ?? 0, asset.height ?? 0);
  return largest > 0 && Math.max(image.width, image.height) < largest * 0.9;
};

// Renders `image` with the editor's settings at full size, draws the `markup` on top, and encodes
// it.
export async function renderImage(
  image: ImageBitmap,
  state: AdjustState,
  type: 'image/jpeg' | 'image/png',
  onProgress?: (done: number, total: number) => void,
  tileSize?: number,
  markup: MarkupItem[] = [],
): Promise<{ blob: Blob; size: Size }> {
  const source = { width: image.width, height: image.height };
  const output = outputSize(state.angle, source, state.perspective);
  const values = shaderValues(state);

  const canvas = document.createElement('canvas');
  const work = document.createElement('canvas');
  const part = new OffscreenCanvas(1, 1);
  const partContext = part.getContext('2d');
  let renderer: AdjustRenderer | undefined;
  try {
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext('2d');
    if (!context || !partContext || canvas.width !== output.width || canvas.height !== output.height) {
      throw new AdjustExportError('too-large');
    }
    renderer = new AdjustRenderer(work);
    let size = tileSize ?? tileSizeFor(renderer.maxTextureSize);
    if (state.perspective) {
      const limit = Math.min(renderer.maxTextureSize, MAX_PART);
      size = tileSizeWithin(output, source, state.angle, state.perspective, size, limit);
    }
    const parts = tiles(output, size);
    for (const [index, tile] of parts.entries()) {
      const texture = sourceRect(tile, output, source, state.angle, state.perspective);
      part.width = texture.width;
      part.height = texture.height;
      partContext.drawImage(
        image,
        texture.x,
        texture.y,
        texture.width,
        texture.height,
        0,
        0,
        texture.width,
        texture.height,
      );
      work.width = tile.width;
      work.height = tile.height;
      renderer.setImage(part);
      renderer.render({
        values,
        degrees: state.angle,
        perspective: state.perspective,
        source,
        output,
        tile,
        texture,
        onScreen: false,
      });
      const pixels = renderer.read(tile.width, tile.height);
      if (!renderer.ok || (type === 'image/jpeg' && !hasVisiblePixel(pixels))) {
        throw new AdjustExportError('gpu');
      }
      context.putImageData(new ImageData(pixels, tile.width, tile.height), tile.x, tile.y);
      const centre = Math.floor(tile.height / 2) * tile.width + Math.floor(tile.width / 2);
      const check = context.getImageData(
        tile.x + Math.floor(tile.width / 2),
        tile.y + Math.floor(tile.height / 2),
        1,
        1,
      );
      if (check.data[3] !== pixels[centre * 4 + 3]) {
        throw new AdjustExportError('too-large');
      }
      onProgress?.(index + 1, parts.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (markup.length > 0) {
      await markupFontReady();
      drawMarkup(context, markup, output);
    }

    const blob = await toBlob(canvas, type);
    if (!blob || blob.size === 0) {
      throw new AdjustExportError('too-large');
    }
    return { blob, size: output };
  } finally {
    renderer?.dispose();
    canvas.width = canvas.height = 0;
    part.width = part.height = 0;
  }
}

// The copy: the photo with the editor's settings and the markup, at full size.
export async function exportAdjusted(
  asset: AssetResponseDto,
  state: AdjustState,
  onProgress?: (done: number, total: number) => void,
  markup: MarkupItem[] = [],
): Promise<ExportResult> {
  const image = await readSource(asset);
  try {
    const { blob, size } = await renderImage(image, state, copyType(asset), onProgress, undefined, markup);
    return { blob, size, fromPreview: fromPreview(asset, image) };
  } finally {
    image.close();
  }
}
