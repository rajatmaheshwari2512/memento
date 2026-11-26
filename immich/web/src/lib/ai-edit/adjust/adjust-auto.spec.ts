import parity from '#lib/ai-edit/adjust/adjust-auto-parity.json';
import settings from '#lib/ai-edit/adjust/adjust-auto.json';
import { AUTO_SLIDERS, autoAdjust, measure } from '#lib/ai-edit/adjust/adjust-auto.ts';
import { renderImage } from '#lib/ai-edit/adjust/adjust-export.ts';
import { initialState, neutralAdjustments } from '#lib/ai-edit/adjust/adjust-params.ts';

type Run = number[];

const picture = (runs: Run[]) => {
  const width = runs.reduce((sum, run) => sum + run[3], 0);
  const data = new Uint8ClampedArray(width * 4);
  let x = 0;
  for (const [r, g, b, count] of runs) {
    for (let i = 0; i < count; i++, x++) {
      data.set([r, g, b, 255], x * 4);
    }
  }
  return { data, width };
};

async function withAuto(runs: Run[]) {
  const { data, width } = picture(runs);
  const values = autoAdjust(data, width, 1);
  const image = await createImageBitmap(new ImageData(data, width, 1), { premultiplyAlpha: 'none' });
  const adjustments = { ...neutralAdjustments(), ...values };
  const { blob, size } = await renderImage(image, { ...initialState(), adjustments }, 'image/png');
  const decoded = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(size.width, size.height);
  canvas.getContext('2d')!.drawImage(decoded, 0, 0);
  const after = canvas.getContext('2d')!.getImageData(0, 0, size.width, size.height).data;
  return { values, before: measure(data, width, 1), after: measure(after, size.width, size.height) };
}

const ramp = (from: number, to: number): Run[] =>
  Array.from({ length: 24 }, (_, i) => {
    const tone = Math.round(from + ((to - from) * i) / 23);
    return [tone, tone, Math.round(tone * 0.9), 10];
  });

describe('Auto', () => {
  it('gives the values the Android app is checked against', () => {
    for (const { name, runs, expected } of parity.cases) {
      const { data, width } = picture(runs);
      expect(autoAdjust(data, width, 1), name).toEqual(expected);
    }
  });

  it('sets only its own sliders, each within its limit', () => {
    const limits: Record<string, [number, number]> = {
      exposure: [0, settings.exposure.max],
      brightness: [settings.brightness.min, settings.brightness.max],
      contrast: [0, settings.contrast.max],
      highlights: [-settings.highlights.max, 0],
      shadows: [0, settings.shadows.max],
      saturation: [0, settings.saturation.max],
      warmth: [-settings.warmth.max, settings.warmth.max],
    };
    for (const { runs } of parity.cases) {
      const { data, width } = picture(runs);
      const values = autoAdjust(data, width, 1);
      expect(Object.keys(values).toSorted()).toEqual([...AUTO_SLIDERS].toSorted());
      for (const [key, value] of Object.entries(values)) {
        expect(value, key).toBeGreaterThanOrEqual(limits[key][0]);
        expect(value, key).toBeLessThanOrEqual(limits[key][1]);
        expect(Math.round(value * 100) / 100, key).toBe(value);
      }
    }
  });

  it('leaves a well-exposed photo nearly as it is', () => {
    const { data, width } = picture(parity.cases[0].runs);
    for (const value of Object.values(autoAdjust(data, width, 1))) {
      expect(Math.abs(value)).toBeLessThanOrEqual(0.05);
    }
  });

  it('brightens a dark photo: its brightest and middle tones go up, through the shader', async () => {
    const { values, before, after } = await withAuto(ramp(0, 110));
    expect(values.exposure).toBeGreaterThan(0);
    expect(after.high).toBeGreaterThan(before.high + 0.15);
    expect(after.median).toBeGreaterThan(before.median + 0.08);
    expect(after.median).toBeLessThanOrEqual(settings.brightness.middle[1]);
  });

  it('gives a flat photo more contrast: its darkest tones go down and its brightest up', async () => {
    const { values, before, after } = await withAuto(ramp(95, 175));
    expect(values.contrast).toBeGreaterThan(0);
    expect(after.low).toBeLessThan(before.low - 0.01);
    expect(after.high).toBeGreaterThan(before.high + 0.01);
    expect(Math.abs(after.median - before.median)).toBeLessThan(0.05);
  });

  it('nudges a blue cast towards neutral grey', async () => {
    const blue = ramp(20, 240).map(([r, g, , count]) => [Math.round(r * 0.9), Math.round(g * 0.95), r, count]);
    const { values, before, after } = await withAuto(blue);
    expect(values.warmth).toBeGreaterThan(0);
    const ratio = ({ balance }: typeof before) => balance[2] / balance[0];
    expect(ratio(after)).toBeLessThan(ratio(before));
    expect(ratio(after)).toBeGreaterThan(1);
  });

  it("doesn't cool a sunset or warm a pale blue sky: only greyish parts set warmth", () => {
    const warm = parity.cases.filter(({ name }) => /sunset|sky/.test(name));
    expect(warm).toHaveLength(2);
    for (const { name, runs } of warm) {
      const { data, width } = picture(runs);
      expect(autoAdjust(data, width, 1).warmth, name).toBe(0);
    }
  });

  it('looks at every pixel of a small picture, and at most about the sample count of a large one', () => {
    const small = new Uint8ClampedArray(64 * 48 * 4).fill(200);
    expect(measure(small, 64, 48).median).toBeCloseTo(200 / 255, 6);
    const large = new Uint8ClampedArray(1000 * 1000 * 4);
    for (let i = 0; i < large.length; i += 4) {
      const x = (i / 4) % 1000;
      large.set(x % 3 === 0 ? [40, 40, 40, 255] : [250, 250, 250, 255], i);
    }
    expect(measure(large, 1000, 1000).median).toBeCloseTo(40 / 255, 6);
  });
});
