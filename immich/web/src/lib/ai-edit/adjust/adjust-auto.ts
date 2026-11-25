// SelfPhotos Adjust's Auto: one tap sets the light and colour sliders from the photo itself,
// from its histogram and average colour. No AI and nothing sent anywhere. Not part of Immich.
// Android has the same logic in mobile/lib/selfphotos/adjust/adjust_auto.dart; both read
// adjust-auto.json and are checked against adjust-auto-parity.json.
//
// It looks at Immich's preview of the photo (already loaded for the editor), every few pixels,
// and works in the order the shader applies the sliders (adjust-core.glsl):
//   - exposure lifts the brightest tones towards white (never darker, never the middle tone past
//     the middle brightness aims for);
//   - contrast takes the darkest tones down towards black;
//   - brightness moves the middle tone part of the way into a comfortable range;
//   - shadows lift what's crushed to black, highlights tame what's blown out;
//   - warmth nudges the average colour of the greyish parts (white walls, roads, clouds: not a
//     blue sky or a red dress) towards neutral, blue as strong as red;
//   - saturation makes a dull photo a little more colourful.
// Black-and-white photos keep their colour sliders at 0. Each value is capped (adjust-auto.json)
// so the result stays natural, and rounded to the slider's steps.

import settings from '#lib/ai-edit/adjust/adjust-auto.json';
import type { SliderKey } from '#lib/ai-edit/adjust/adjust-params.ts';

// The sliders Auto sets (the rest keep their values).
export const AUTO_SLIDERS = [
  'exposure',
  'brightness',
  'contrast',
  'highlights',
  'shadows',
  'saturation',
  'warmth',
] as const satisfies SliderKey[];

export type AutoValues = Record<(typeof AUTO_SLIDERS)[number], number>;

// What Auto sees of a photo. Tones 0..1 (sRGB).
export type PhotoStats = {
  // The tones the darkest 0.5%, half, and all but the brightest 0.5% of the photo are at or below.
  low: number;
  median: number;
  high: number;
  // The share crushed to black, and blown out to white.
  darkClipped: number;
  brightClipped: number;
  // The greyish midtones' average colour, as light (linear red, green, blue), and their share.
  balance: [number, number, number];
  greyish: number;
  // The midtones' average saturation, 0 (grey) to 1.
  saturation: number;
};

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const LINEAR = Array.from({ length: 256 }, (_, v) => toLinear(v / 255));

// Looks at the photo (RGBA, unpremultiplied, rows top first): every `step`-th pixel of every
// `step`-th row, so at most about `settings.samples` of them.
export function measure(pixels: ArrayLike<number>, width: number, height: number): PhotoStats {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / settings.samples)));
  const histogram = Array.from({ length: 256 }, () => 0);
  const [lowCut, highCut] = settings.midtones.map((tone) => Math.round(tone * 255));
  let count = 0;
  let midtones = 0;
  let greyish = 0;
  const balance: [number, number, number] = [0, 0, 0];
  let saturation = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // How bright it looks, 0..255, in whole numbers so both apps agree exactly.
      const luma = Math.floor((2126 * r + 7152 * g + 722 * b + 5000) / 10_000);
      histogram[luma]++;
      count++;
      if (luma < lowCut || luma > highCut) {
        continue;
      }
      const top = Math.max(r, g, b);
      const colour = (top - Math.min(r, g, b)) / top;
      saturation += colour;
      midtones++;
      if (!(colour <= settings.warmth.greyish)) {
        continue;
      }

      balance[0] += LINEAR[r];
      balance[1] += LINEAR[g];
      balance[2] += LINEAR[b];
      greyish++;
    }
  }
  const toneAt = (share: number) => {
    let total = 0;
    for (let tone = 0; tone < 256; tone++) {
      total += histogram[tone];
      if (total >= share * count) {
        return tone / 255;
      }
    }
    return 1;
  };
  const shareOf = (from: number, to: number) => {
    let total = 0;
    for (let tone = from; tone <= to; tone++) {
      total += histogram[tone];
    }
    return total / count;
  };
  return {
    low: toneAt(settings.ends),
    median: toneAt(0.5),
    high: toneAt(1 - settings.ends),
    darkClipped: shareOf(0, Math.round(settings.shadows.clipped * 255)),
    brightClipped: shareOf(Math.round(settings.highlights.clipped * 255), 255),
    balance: greyish > 0 ? [balance[0] / greyish, balance[1] / greyish, balance[2] / greyish] : [0, 0, 0],
    greyish: greyish / count,
    saturation: midtones > 0 ? saturation / midtones : 0,
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// To the slider's steps (1/100), halves away from zero as Dart rounds, and never -0.
const toStep = (value: number) => (Math.sign(value) * Math.round(Math.abs(value) * 100)) / 100 + 0;

// The sliders for a photo with these stats.
export function autoValues(stats: PhotoStats): AutoValues {
  const { exposure: e, contrast: c, brightness: b, shadows: s, highlights: h, warmth: w } = settings;

  const [lowest, highest] = b.middle;
  const toWhite = 0.5 * Math.log2(toLinear(e.white) / toLinear(Math.max(stats.high, 1 / 255)));
  const toMiddle = 0.5 * Math.log2(toLinear(lowest) / toLinear(Math.max(stats.median, 1 / 255)));
  const exposure = toStep(clamp(Math.min(toWhite, toMiddle), 0, e.max));
  const gain = 2 ** (2 * exposure);
  const exposed = (tone: number) => toSrgb(Math.min(1, toLinear(tone) * gain));

  // The shader's contrast curve below the middle is 0.5·(2v)^k, k = 1 + 1.5·contrast.
  const low = exposed(stats.low);
  const contrast =
    low > c.black && low < 0.5 ? toStep(clamp((Math.log(2 * c.black) / Math.log(2 * low) - 1) / 1.5, 0, c.max)) : 0;
  const k = 1 + 1.5 * contrast;

  // Brightness raises tones to a power. The middle tone, after exposure and contrast, if it's
  // outside the range, part of the way to it; aimed at the tone contrast then turns into it.
  const contrasted = (tone: number) => (tone < 0.5 ? 0.5 * (2 * tone) ** k : 1 - 0.5 * (2 * (1 - tone)) ** k);
  const uncontrasted = (tone: number) =>
    tone < 0.5 ? 0.5 * (2 * tone) ** (1 / k) : 1 - 0.5 * (2 * (1 - tone)) ** (1 / k);
  const middle = clamp(exposed(stats.median), 0.01, 0.99);
  const shown = contrasted(middle);
  const aim = shown < lowest ? uncontrasted(lowest) : shown > highest ? uncontrasted(highest) : middle;
  const brightness = toStep(clamp((-Math.log2(Math.log(aim) / Math.log(middle)) / 0.75) * b.strength, b.min, b.max));

  const shadows = toStep(clamp((stats.darkClipped - s.allowed) * s.perClipped, 0, s.max));
  const highlights = toStep(-clamp((stats.brightClipped - h.allowed) * h.perClipped, 0, h.max));

  const colourful = stats.saturation >= settings.grey;
  const balanced = colourful && stats.greyish >= w.minShare && stats.balance[0] > 0 && stats.balance[2] > 0;
  const ratio = stats.balance[2] / stats.balance[0];
  const warmth = balanced ? toStep(clamp(((4 * (ratio - 1)) / (1 + ratio)) * w.strength, -w.max, w.max)) : 0;
  const saturation = colourful
    ? toStep(
        clamp(
          (settings.saturation.target - stats.saturation) * settings.saturation.strength,
          0,
          settings.saturation.max,
        ),
      )
    : 0;

  return { exposure, brightness, contrast, highlights, shadows, saturation, warmth };
}

export const autoAdjust = (pixels: ArrayLike<number>, width: number, height: number) =>
  autoValues(measure(pixels, width, height));
