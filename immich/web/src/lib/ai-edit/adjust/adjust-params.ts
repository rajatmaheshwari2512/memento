// SelfPhotos Adjust: what the sliders and filters set, and how they become the shader's values
// (adjust-core.glsl).

import filterList from '#lib/ai-edit/adjust/adjust-filters.json';
import { isPhotoCorners, type Quad } from '#lib/ai-edit/adjust/adjust-geometry.ts';
import { clamp } from 'lodash-es';

// The sliders, in the order they're shown.
export const SLIDERS = [
  { key: 'exposure', label: 'editor_exposure', group: 'light' },
  { key: 'brightness', label: 'editor_brightness', group: 'light' },
  { key: 'contrast', label: 'editor_contrast', group: 'light' },
  { key: 'highlights', label: 'editor_highlights', group: 'light' },
  { key: 'shadows', label: 'editor_shadows', group: 'light' },
  { key: 'vignette', label: 'editor_vignette', group: 'light' },
  { key: 'saturation', label: 'editor_saturation', group: 'color' },
  { key: 'warmth', label: 'editor_warmth', group: 'color' },
  { key: 'tint', label: 'editor_tint', group: 'color' },
] as const;

export type SliderKey = (typeof SLIDERS)[number]['key'];
export type Adjustments = Record<SliderKey, number>;
type Rgb = [number, number, number];

// A filter: some sliders, plus two settings only filters use (fade, and colours pushed into the
// shadows and highlights).
export type Filter = { id: string } & Partial<Adjustments> & { fade?: number; toneShadows?: Rgb; toneHighlights?: Rgb };

export const FILTERS: Filter[] = filterList.filters as Filter[];

// Straighten: the slider's range, in degrees (clockwise is positive).
export const MAX_ANGLE = 45;

// Everything the editor holds.
export type AdjustState = {
  adjustments: Adjustments;
  filter: string | null;
  strength: number;
  angle: number;
  perspective?: Quad | null;
};

export type ShaderValues = Adjustments & { fade: number; toneShadows: Rgb; toneHighlights: Rgb };

export const neutralAdjustments = (): Adjustments =>
  Object.fromEntries(SLIDERS.map(({ key }) => [key, 0])) as Adjustments;

export const initialState = (): AdjustState => ({
  adjustments: neutralAdjustments(),
  filter: null,
  strength: 1,
  angle: 0,
  perspective: null,
});

// The corners to keep: the photo's own are no perspective (null).
export const perspectiveOf = (corners: Quad | null) => (corners && !isPhotoCorners(corners) ? corners : null);

// The sliders, plus the filter at its strength.
export function shaderValues(state: Pick<AdjustState, 'adjustments' | 'filter' | 'strength'>): ShaderValues {
  const filter = FILTERS.find(({ id }) => id === state.filter);
  const strength = filter ? clamp(state.strength, 0, 1) : 0;
  const scaled = (rgb: Rgb | undefined): Rgb =>
    rgb ? [rgb[0] * strength, rgb[1] * strength, rgb[2] * strength] : [0, 0, 0];
  const values = Object.fromEntries(
    SLIDERS.map(({ key }) => [key, clamp(state.adjustments[key] + (filter?.[key] ?? 0) * strength, -1, 1)]),
  ) as Adjustments;
  return {
    ...values,
    fade: clamp((filter?.fade ?? 0) * strength, 0, 1),
    toneShadows: scaled(filter?.toneShadows),
    toneHighlights: scaled(filter?.toneHighlights),
  };
}

// Nothing changed: no slider moved, no filter, not turned, no perspective.
export const isUnchanged = (state: AdjustState) =>
  state.filter === null &&
  state.angle === 0 &&
  !state.perspective &&
  SLIDERS.every(({ key }) => state.adjustments[key] === 0);
