// SelfPhotos Adjust: what the sliders and filters set, and how they become the shader's
// values (adjust-core.glsl). Not part of Immich. Android has the same logic in
// mobile/lib/selfphotos/adjust/adjust_params.dart.

import filterList from '#lib/ai-edit/adjust/adjust-filters.json';
import { isPhotoCorners, type Quad } from '#lib/ai-edit/adjust/adjust-geometry.ts';
import { clamp } from 'lodash-es';

// The sliders, in the order they're shown. Each is -1..1 (shown as -100..100), 0 = unchanged.
// The labels are i18n keys; editor_exposure and editor_contrast are the names Immich's own
// brightness/contrast change (PR #31040) uses.
// `group` is the heading they're under (an existing Immich key: "Light", "Color").
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

// A filter: some sliders, plus two settings only filters use (fade, and colours pushed
// into the shadows and highlights).
export type Filter = { id: string } & Partial<Adjustments> & { fade?: number; toneShadows?: Rgb; toneHighlights?: Rgb };

export const FILTERS: Filter[] = filterList.filters as Filter[];

// Straighten: the slider's range, in degrees (clockwise is positive).
export const MAX_ANGLE = 45;

// Everything the editor holds. `filter` is a filter id or null; `strength` 0..1;
// `perspective` the four corners (adjust-geometry.ts), null or left out for none.
export type AdjustState = {
  adjustments: Adjustments;
  filter: string | null;
  strength: number;
  angle: number;
  perspective?: Quad | null;
};

// The values the shader takes (adjust-core.glsl's uniforms without the u prefix).
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

// The sliders, plus the filter at its strength. Each ends up -1..1 (fade 0..1).
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
