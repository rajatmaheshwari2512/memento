import en from '#i18n/en.json';
import core from '#lib/ai-edit/adjust/adjust-core.glsl?raw';
import {
  FILTERS,
  SLIDERS,
  initialState,
  isUnchanged,
  neutralAdjustments,
  shaderValues,
} from '#lib/ai-edit/adjust/adjust-params.ts';

const translations: Record<string, unknown> = en;

describe('shaderValues', () => {
  it('is all zeros with nothing set', () => {
    const values = shaderValues(initialState());
    for (const { key } of SLIDERS) {
      expect(values[key]).toBe(0);
    }
    expect(values.fade).toBe(0);
    expect(values.toneShadows).toEqual([0, 0, 0]);
    expect(values.toneHighlights).toEqual([0, 0, 0]);
  });

  it('adds the filter at its strength to the sliders', () => {
    const adjustments = { ...neutralAdjustments(), warmth: 0.1, contrast: -0.2 };
    const values = shaderValues({ adjustments, filter: 'golden', strength: 0.5 });
    expect(values.warmth).toBeCloseTo(0.1 + 0.25 * 0.5, 9);
    expect(values.contrast).toBeCloseTo(-0.2 + 0.1 * 0.5, 9);
    expect(values.toneHighlights).toEqual([0.2, 0.125, -0.1]);
    expect(values.exposure).toBe(0);
  });

  it('keeps every value in range', () => {
    const adjustments = { ...neutralAdjustments(), saturation: -0.8, contrast: 1 };
    const values = shaderValues({ adjustments, filter: 'noir', strength: 1 });
    expect(values.saturation).toBe(-1);
    expect(values.contrast).toBe(1);
    expect(shaderValues({ adjustments, filter: 'matte', strength: 7 }).fade).toBe(0.6);
  });

  it('ignores an unknown filter', () => {
    expect(shaderValues({ adjustments: neutralAdjustments(), filter: 'nope', strength: 1 })).toEqual(
      shaderValues(initialState()),
    );
  });
});

describe('isUnchanged', () => {
  it('notices any slider, filter or turn', () => {
    expect(isUnchanged(initialState())).toBe(true);
    expect(isUnchanged({ ...initialState(), angle: 0.5 })).toBe(false);
    expect(isUnchanged({ ...initialState(), filter: 'mono' })).toBe(false);
    expect(isUnchanged({ ...initialState(), adjustments: { ...neutralAdjustments(), tint: 0.01 } })).toBe(false);
  });
});

describe('filters', () => {
  it('have unique ids, known settings in range, and a name in every language file we ship (en)', () => {
    const known = new Set([...SLIDERS.map(({ key }) => key), 'fade', 'toneShadows', 'toneHighlights', 'id']);
    expect(new Set(FILTERS.map(({ id }) => id)).size).toBe(FILTERS.length);
    expect(FILTERS.length).toBeGreaterThanOrEqual(8);
    for (const filter of FILTERS) {
      for (const [key, value] of Object.entries(filter)) {
        expect(known.has(key), `${filter.id}.${key}`).toBe(true);
        for (const number of Array.isArray(value) ? value : typeof value === 'number' ? [value] : []) {
          expect(Math.abs(number)).toBeLessThanOrEqual(1);
        }
      }
      expect(translations[`editor_filter_${filter.id}`], filter.id).toBeTruthy();
    }
  });

  it('only use settings the shader has', () => {
    for (const key of [...SLIDERS.map(({ key }) => key), 'fade', 'toneShadows', 'toneHighlights']) {
      expect(core).toMatch(new RegExp(`uniform (float|vec3) u${key[0].toUpperCase()}${key.slice(1)};`));
    }
  });

  it('every slider has its label', () => {
    for (const { label } of SLIDERS) {
      expect(translations[label], label).toBeTruthy();
    }
  });
});
