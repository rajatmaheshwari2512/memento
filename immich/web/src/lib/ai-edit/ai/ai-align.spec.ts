import { IDENTITY, estimateAlignment, type Alignment } from '#lib/ai-edit/ai/ai-align.ts';
import { alignFor, pasteOnto, type Stroke } from '#lib/ai-edit/ai/ai-area.ts';

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

const texture = (x: number, y: number) => {
  const v =
    128 +
    40 * Math.sin(x / 4.3 + y / 9.1) +
    35 * Math.sin(y / 5.2 - x / 13.7) +
    25 * Math.sin((x + 2 * y) / 7.9) +
    20 * Math.sin(x / 11.3);
  return [v, v * 0.8 + 20, 255 - v, 255];
};

const [W, H] = [1024, 768];

function makePhoto() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      data.set(texture(x, y), (y * W + x) * 4);
    }
  }
  return createImageBitmap(new ImageData(data, W, H), { premultiplyAlpha: 'none' });
}

async function drifted(
  base: ImageBitmap,
  size: { width: number; height: number },
  scale: number,
  offset: [number, number],
) {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(base, offset[0] * size.width, offset[1] * size.height, scale * size.width, scale * size.height);
  return createImageBitmap(canvas);
}

async function decode(blob: Blob): Promise<Pixels> {
  const image = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

const dot: Stroke[] = [{ points: [[0.5, 0.5]], radius: 0.1 }];

function insideEdge(out: Pixels) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const distance = Math.hypot(x - W / 2, y - H / 2);
      if (distance < 60 || distance > 95) {
        continue;
      }
      const i = (y * out.width + x) * 4;
      const expected = texture(x, y);
      sum += (Math.abs(out.data[i] - expected[0]) + Math.abs(out.data[i + 2] - expected[2])) / 2;
      count++;
    }
  }
  return sum / count;
}

async function pasted(base: ImageBitmap, result: ImageBitmap, alignment: Alignment) {
  const { blob } = await pasteOnto(base, result, dot, 'image/png', alignment);
  return decode(blob);
}

describe('alignFor', () => {
  it('finds how far the result drifted, and pasting with it lines the edge up', async () => {
    const base = await makePhoto();
    const result = await drifted(base, { width: 1000, height: 750 }, 1.006, [-0.001, 0.004]);
    const alignment = await alignFor(base, result, dot);
    expect(alignment.scaleX).toBeCloseTo(1.006, 3);
    expect(alignment.scaleY).toBeCloseTo(1.006, 3);
    expect(alignment.offsetX).toBeCloseTo(-0.001, 3);
    expect(alignment.offsetY).toBeCloseTo(0.004, 3);
    expect(alignment.error * W).toBeLessThan(0.5);

    expect(insideEdge(await pasted(base, result, alignment))).toBeLessThan(6);
    expect(insideEdge(await pasted(base, result, IDENTITY))).toBeGreaterThan(10);
  });

  it('still finds the drift when the highlighted parts are far apart (two corners)', async () => {
    const base = await makePhoto();
    const result = await drifted(base, { width: 1000, height: 750 }, 1.006, [-0.001, 0.004]);
    const corners: Stroke[] = [
      { points: [[0.1, 0.1]], radius: 0.05 },
      { points: [[0.9, 0.9]], radius: 0.05 },
    ];
    const alignment = await alignFor(base, result, corners);
    expect(alignment.scaleX).toBeCloseTo(1.006, 3);
    expect(alignment.offsetY).toBeCloseTo(0.004, 3);
  });

  it('finds nothing to correct when the result is only another size', async () => {
    const base = await makePhoto();
    const alignment = await alignFor(base, await drifted(base, { width: 1000, height: 750 }, 1, [0, 0]), dot);
    expect(alignment.scaleX).toBeCloseTo(1, 3);
    expect(alignment.offsetX * W).toBeCloseTo(0, 0);
    expect(alignment.offsetY * H).toBeCloseTo(0, 0);
  });

  it('pastes a stroke at the photo’s edge, where the lined-up result runs out', async () => {
    const base = await makePhoto();
    const result = await drifted(base, { width: 1000, height: 750 }, 1.01, [0.004, 0]);
    const edge: Stroke[] = [{ points: [[0.99, 0.5]], radius: 0.05 }];
    const { size } = await pasteOnto(base, result, edge, 'image/png', await alignFor(base, result, edge));
    expect(size).toEqual({ width: W, height: H });
  });
});

describe('estimateAlignment', () => {
  it('gives up when nothing has texture to match (nothing would show a seam either)', () => {
    const flat = { width: 300, height: 200, data: new Float32Array(300 * 200).fill(90) };
    expect(estimateAlignment(flat, flat, null)).toBeNull();
  });
});
