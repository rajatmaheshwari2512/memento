import { renderImage } from '#lib/ai-edit/adjust/adjust-export.ts';
import { initialState, neutralAdjustments, type AdjustState } from '#lib/ai-edit/adjust/adjust-params.ts';
import parity from '#lib/ai-edit/adjust/adjust-parity.json';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

async function makeImage(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return createImageBitmap(new ImageData(data, width, height), { premultiplyAlpha: 'none' });
}

const pattern = (width: number, height: number) =>
  makeImage(width, height, (x, y) => [
    Math.round((x / (width - 1)) * 255),
    Math.round((y / (height - 1)) * 255),
    (x * 7 + y * 13) % 256,
    255,
  ]);

async function render(image: ImageBitmap, state: AdjustState, tileSize?: number): Promise<Pixels> {
  const { blob, size } = await renderImage(image, state, 'image/png', undefined, tileSize);
  const decoded = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(decoded, 0, 0);
  return { ...size, data: context.getImageData(0, 0, size.width, size.height).data };
}

const at = ({ width, data }: Pixels, x: number, y: number) => [
  ...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];
const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const maxDifference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
};

const busy: AdjustState = {
  adjustments: { ...neutralAdjustments(), exposure: 0.2, contrast: 0.4, shadows: 0.5, warmth: -0.3, vignette: 0.6 },
  filter: 'film',
  strength: 0.8,
  angle: 7.3,
};

describe('the Adjust shader', () => {
  it('changes nothing with nothing set', async () => {
    const image = await pattern(64, 48);
    const source = await render(image, { ...initialState() });
    const out = await render(image, initialState());
    expect(out.width).toBe(64);
    const original = new OffscreenCanvas(64, 48).getContext('2d')!;
    original.drawImage(image, 0, 0);
    expect(maxDifference(out.data, original.getImageData(0, 0, 64, 48).data)).toBeLessThanOrEqual(1);
    expect(maxDifference(out.data, source.data)).toBe(0);
  });

  it('gives the same picture in small tiles as in one piece, turned and with everything set', async () => {
    const image = await pattern(301, 203);
    const whole = await render(image, busy);
    const tiled = await render(image, busy, 64);
    expect([tiled.width, tiled.height]).toEqual([whole.width, whole.height]);
    expect(maxDifference(tiled.data, whole.data)).toBeLessThanOrEqual(1);
  });

  it('never swaps tones, even with the sliders at their ends', async () => {
    const ramp = await makeImage(256, 1, (x) => [x, x, x, 255]);
    for (const extreme of [
      { shadows: 1, highlights: -1 },
      { shadows: -1, highlights: 1 },
      { shadows: 1, highlights: 1, contrast: 1 },
      { shadows: -1, highlights: -1, contrast: -1 },
      { brightness: 1, contrast: 1 },
    ]) {
      const out = await render(ramp, { ...initialState(), adjustments: { ...neutralAdjustments(), ...extreme } });
      for (let x = 1; x < 256; x++) {
        expect(luma(at(out, x, 0)), `${JSON.stringify(extreme)} at ${x}`).toBeGreaterThanOrEqual(
          luma(at(out, x - 1, 0)) - 1,
        );
      }
    }
  });

  it('moves the picture the way each slider says', async () => {
    const grey = await makeImage(32, 32, () => [120, 110, 100, 255]);
    const centre = async (adjustments: Partial<AdjustState['adjustments']>) =>
      at(await render(grey, { ...initialState(), adjustments: { ...neutralAdjustments(), ...adjustments } }), 16, 16);
    const plain = await centre({});
    expect(luma(await centre({ exposure: 0.5 }))).toBeGreaterThan(luma(plain) + 20);
    expect(luma(await centre({ brightness: -0.5 }))).toBeLessThan(luma(plain) - 10);
    const [r, g, b] = await centre({ saturation: -1 });
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
    const warm = await centre({ warmth: 0.6 });
    expect(warm[0] - warm[2]).toBeGreaterThan(plain[0] - plain[2] + 10);
    const vignette = await render(grey, { ...initialState(), adjustments: { ...neutralAdjustments(), vignette: 1 } });
    expect(luma(at(vignette, 0, 0))).toBeLessThan(luma(at(vignette, 16, 16)) - 30);
    expect(
      maxDifference(new Uint8ClampedArray(at(vignette, 16, 16)), new Uint8ClampedArray(plain)),
    ).toBeLessThanOrEqual(2);
  });

  it('straightens: the copy is the auto-crop, the same shape, with no empty corners', async () => {
    const image = await makeImage(400, 300, () => [200, 100, 50, 255]);
    const out = await render(image, { ...initialState(), angle: 30 });
    expect(out.width / out.height).toBeCloseTo(4 / 3, 1);
    expect(out.width).toBe(Math.round(400 / (Math.cos(Math.PI / 6) + (4 / 3) * Math.sin(Math.PI / 6))));
    for (const [x, y] of [
      [0, 0],
      [out.width - 1, 0],
      [0, out.height - 1],
      [out.width - 1, out.height - 1],
    ]) {
      expect(at(out, x, y)).toEqual([200, 100, 50, 255]);
    }
  });

  it('warps for perspective: the same picture in tiles as in one piece, and nothing for a rectangle of corners unturned', async () => {
    const image = await pattern(301, 203);
    const leaning: AdjustState = {
      ...busy,
      perspective: [
        [0.15, 0.05],
        [0.8, 0.1],
        [1, 0.9],
        [0, 1],
      ],
    };
    const whole = await render(image, leaning);
    const tiled = await render(image, leaning, 64);
    expect([tiled.width, tiled.height]).toEqual([whole.width, whole.height]);
    expect(maxDifference(tiled.data, whole.data)).toBeLessThanOrEqual(1);
    const straightened = await render(image, busy);
    expect(whole.width).not.toBe(straightened.width);

    const unturned = await render(image, { ...busy, angle: 0 });
    const rectangle = await render(image, {
      ...busy,
      angle: 0,
      perspective: [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
    });
    expect([rectangle.width, rectangle.height]).toEqual([unturned.width, unturned.height]);
    expect(maxDifference(rectangle.data, unturned.data)).toBeLessThanOrEqual(1);
  });

  it('reads EXIF-rotated photos the right way round, tile by tile', async () => {
    const stored = new OffscreenCanvas(64, 48);
    const draw = stored.getContext('2d')!;
    for (const [x, y, colour] of [
      [0, 0, '#e74c3c'],
      [32, 0, '#2ecc71'],
      [0, 24, '#3498db'],
      [32, 24, '#f1c40f'],
    ] as const) {
      draw.fillStyle = colour;
      draw.fillRect(x, y, 32, 24);
    }
    const encoded = await stored.convertToBlob({ type: 'image/jpeg', quality: 1 });
    const jpeg = new Uint8Array(await encoded.arrayBuffer());
    const exif = [
      0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00,
      0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    const afterJfif = 4 + ((jpeg[4] << 8) | jpeg[5]);
    const tagged = new Blob([jpeg.slice(0, afterJfif), new Uint8Array(exif), jpeg.slice(afterJfif)], {
      type: 'image/jpeg',
    });

    const upright = await createImageBitmap(tagged, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
    expect([upright.width, upright.height]).toEqual([48, 64]);
    const expected = new OffscreenCanvas(48, 64).getContext('2d')!;
    expected.drawImage(upright, 0, 0);

    const out = await render(upright, initialState(), 16);
    expect(maxDifference(out.data, expected.getImageData(0, 0, 48, 64).data)).toBeLessThanOrEqual(2);
  });

  it('matches the parity table that the Android app is checked against', async () => {
    const { width, height, pixels } = parity.image;
    const image = await makeImage(width, height, (x, y) => pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    const actual: number[][] = [];
    for (const { state } of parity.cases) {
      const adjustments = { ...neutralAdjustments(), ...state.adjustments };
      const out = await render(image, { ...initialState(), ...state, adjustments } as AdjustState);
      actual.push([...out.data]);
    }
    const worst = Math.max(
      ...parity.cases.map(({ expected }, i) =>
        expected.length === actual[i].length
          ? maxDifference(new Uint8ClampedArray(expected), new Uint8ClampedArray(actual[i]))
          : 255,
      ),
    );
    expect(worst, `actual pixels: ${JSON.stringify(actual)}`).toBeLessThanOrEqual(2);
  });
});
