// AI tools' paste-back, run for real with canvases in the test browser: only the highlighted
// area of the AI's result lands on the photo, with a soft edge; everything else keeps the
// photo's own pixels.
import { AdjustExportError } from '#lib/ai-edit/adjust/adjust-export.ts';
import { IDENTITY } from '#lib/ai-edit/ai/ai-align.ts';
import {
  NeedsOriginalError,
  ShapeChangedError,
  alignFor,
  areaMask,
  markedCopy,
  pasteBack,
  pasteOnto,
  refusalOf,
  sameShape,
  uprightPhoto,
  type Stroke,
} from '#lib/ai-edit/ai/ai-area.ts';
import { AREA } from '#lib/ai-edit/ai/ai-tools.ts';
import type { AssetResponseDto } from '@immich/sdk';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

function makeImage(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return createImageBitmap(new ImageData(data, width, height), { premultiplyAlpha: 'none' });
}

async function decode(blob: Blob): Promise<Pixels> {
  const image = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

const at = ({ width, data }: Pixels, x: number, y: number) => [
  ...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];

// The photo: a gradient with a fine pattern, so any resampling of it would show.
const photoPixel = (x: number, y: number) => [
  Math.round((x / 399) * 255),
  Math.round((y / 299) * 255),
  (x * 7 + y * 13) % 256,
  255,
];
// The AI's result: its own size class (a little smaller, the same shape) and other colours.
const resultPixel = () => [20, 200, 90, 255];

// A dot in the middle, 40 px across at 400 px wide (the radius is a share of the longer side).
const dot: Stroke[] = [{ points: [[0.5, 0.5]], radius: 0.1 }];

describe('pasteOnto', () => {
  it('keeps every pixel outside the highlighted area, takes the result inside, and blends at the edge', async () => {
    const base = await makeImage(400, 300, photoPixel);
    const result = await makeImage(392, 294, resultPixel);
    // Small tiles, so the paste crosses tile edges.
    const { blob, size } = await pasteOnto(base, result, dot, 'image/png', undefined, 64);
    expect(size).toEqual({ width: 400, height: 300 });
    const out = await decode(blob);

    // Outside the dot and its soft edge (the mask's feather, stretched from its own size).
    const softEdge = ((AREA.feather * AREA.maskLongSide * 4 + 2) * 400) / AREA.maskLongSide;
    let changed = 0;
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 400; x++) {
        if (Math.hypot(x + 0.5 - 200, y + 0.5 - 150) > 40 + softEdge) {
          changed += at(out, x, y).some((value, i) => value !== photoPixel(x, y)[i]) ? 1 : 0;
        }
      }
    }
    expect(changed).toBe(0);

    // Inside: the result.
    for (const [x, y] of [
      [200, 150],
      [185, 150],
      [200, 168],
    ]) {
      const pixel = at(out, x, y);
      for (const [i, value] of resultPixel().entries()) {
        expect(Math.abs(pixel[i] - value)).toBeLessThanOrEqual(2);
      }
    }

    // At the edge: some of each.
    const edge = at(out, 240, 150);
    const [photoGreen, resultGreen] = [photoPixel(240, 150)[1], resultPixel()[1]];
    expect(edge[1]).toBeGreaterThan(Math.min(photoGreen, resultGreen) + 10);
    expect(edge[1]).toBeLessThan(Math.max(photoGreen, resultGreen) - 10);
  });

  it('refuses to paste a result of another shape (portrait for landscape, or a crop): it would misalign', async () => {
    const base = await makeImage(400, 300, photoPixel);
    for (const [width, height] of [
      [294, 392],
      [300, 300],
    ]) {
      const result = await makeImage(width, height, resultPixel);
      await expect(pasteOnto(base, result, dot, 'image/png')).rejects.toBeInstanceOf(ShapeChangedError);
    }
  });

  it('with nothing highlighted, the photo comes back as it was', async () => {
    const base = await makeImage(120, 90, photoPixel);
    const result = await makeImage(118, 88, resultPixel);
    const { blob } = await pasteOnto(base, result, [], 'image/png');
    const out = await decode(blob);
    expect(at(out, 60, 45)).toEqual(photoPixel(60, 45));
  });
});

describe('areaMask', () => {
  it('covers the strokes, with bounds a little wider than them', () => {
    const { canvas, bounds } = areaMask(
      [
        {
          points: [
            [0.2, 0.3],
            [0.6, 0.3],
          ],
          radius: 0.05,
        },
      ],
      { width: 4000, height: 3000 },
    );
    expect(Math.max(canvas.width, canvas.height)).toBe(AREA.maskLongSide);
    expect(bounds!.x).toBeLessThan(0.2 - 0.05 * (4 / 3) * 0.75);
    expect(bounds!.x + bounds!.width).toBeGreaterThan(0.65);
    expect(bounds!.y).toBeLessThan(0.3 - 0.05 * (4 / 3));
    expect(bounds!.y + bounds!.height).toBeLessThan(0.5);
  });

  it('covers nothing without strokes', () => {
    expect(areaMask([], { width: 100, height: 100 }).bounds).toBeNull();
  });
});

describe('markedCopy', () => {
  it('is a small JPEG with the highlighted area tinted red and the rest as it was', async () => {
    const photo = await makeImage(2000, 1500, () => [40, 120, 200, 255]);
    const out = await decode(await markedCopy(photo, dot));
    expect([out.width, out.height]).toEqual([AREA.markLongSide, (AREA.markLongSide * 3) / 4]);
    const [centre, corner] = [at(out, out.width / 2, out.height / 2), at(out, 10, 10)];
    expect(centre[0]).toBeGreaterThan(120); // half red over the blue-ish photo
    expect(centre[2]).toBeLessThan(140);
    for (const [i, value] of [40, 120, 200].entries()) {
      expect(Math.abs(corner[i] - value)).toBeLessThanOrEqual(4);
    }
  });
});

describe('sameShape', () => {
  it("allows the AI's own size class, not a different shape", () => {
    expect(sameShape({ width: 3050, height: 1408 }, { width: 3120, height: 1440 })).toBe(true);
    expect(sameShape({ width: 4096, height: 3072 }, { width: 4080, height: 3072 })).toBe(true);
    expect(sameShape({ width: 3072, height: 4096 }, { width: 4080, height: 3072 })).toBe(false);
    expect(sameShape({ width: 2048, height: 2048 }, { width: 4080, height: 3072 })).toBe(false);
  });
});

describe('refusalOf', () => {
  it("counts a result of another shape as the normal refusal ('shape')", async () => {
    const base = await makeImage(400, 300, photoPixel);
    const portrait = await makeImage(294, 392, resultPixel);
    const refusal = await alignFor(base, portrait, dot).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ShapeChangedError);
    expect(refusalOf(refusal)).toBe('shape');
  });

  it("counts anything else that goes wrong lining it up or pasting it as a failure ('failed')", async () => {
    const base = await makeImage(400, 300, photoPixel);
    const result = await makeImage(392, 294, resultPixel);
    // A canvas error while lining it up (a brush the canvas can't draw).
    const broken: Stroke[] = [{ points: [[0.5, 0.5]], radius: -0.1 }];
    const failure = await alignFor(base, result, broken).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DOMException);
    expect(refusalOf(failure)).toBe('failed');
    // The photo too large for this browser's canvas while pasting.
    expect(refusalOf(new AdjustExportError('too-large'))).toBe('failed');
  });
});

// The photo's picture as this browser reads it, stubbed: always 600×400 (a PNG), whatever the
// photo's size as Immich shows it.
describe('the full-size picture a highlighted edit needs', () => {
  const photo = (width: number, height: number) =>
    ({
      id: 'photo',
      isEdited: false,
      originalMimeType: 'image/png',
      originalFileName: 'photo.png',
      width,
      height,
    }) as AssetResponseDto;

  beforeEach(async () => {
    const canvas = new OffscreenCanvas(600, 400);
    canvas.getContext('2d')!.fillRect(0, 0, 600, 400);
    const picture = await canvas.convertToBlob({ type: 'image/png' });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(picture)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uprightPhoto takes the photo at full size, and refuses a smaller picture (nothing is sent or paid for)', async () => {
    const upright = await uprightPhoto(photo(600, 400));
    expect([upright.image.width, upright.image.height]).toEqual([600, 400]);
    upright.image.close();
    await expect(uprightPhoto(photo(6000, 4000))).rejects.toBeInstanceOf(NeedsOriginalError);
  });

  it('pasteBack pastes onto the photo at full size, and refuses a smaller picture (nothing is uploaded)', async () => {
    const result = await makeImage(600, 400, resultPixel);
    const copy = await decode(await pasteBack(photo(600, 400), result, dot, IDENTITY));
    expect([copy.width, copy.height]).toEqual([600, 400]);
    await expect(pasteBack(photo(6000, 4000), result, dot, IDENTITY)).rejects.toBeInstanceOf(NeedsOriginalError);
  });
});
