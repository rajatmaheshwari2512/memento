// What AI Edit's failures say: the service's own words, or a translated text, never an
// exception's technical text nor the app's own English. The Android app's tests
// (ai_edit_layout_test.dart, ai_edit_service_test.dart) check the same.
import { AdjustExportError } from '#lib/ai-edit/adjust/adjust-export.ts';
import {
  AiEditError,
  IMAGE_UNAVAILABLE,
  PHOTO_TOO_LARGE,
  createAiEdit,
  getAiEditImage,
  saveAiEditArea,
} from '#lib/ai-edit/ai-edit-api.ts';
import { NeedsOriginalError, ShapeChangedError } from '#lib/ai-edit/ai/ai-area.ts';
import { failureMessage, tooLargeMessage } from '#lib/ai-edit/ai/ai-failure.ts';
import { MAX_PHOTO } from '#lib/ai-edit/ai/ai-tools.ts';
import { locale } from '#lib/stores/preferences.store.ts';
import { get } from 'svelte/store';

// The translation's key and the values put in it, so the test sees which text was picked.
const t = (key: string, options?: { values: Record<string, string> }) =>
  options ? `[${key} ${JSON.stringify(options.values)}]` : `[${key}]`;

// The too-large text, with the limits in ai-tools.json as this browser writes numbers.
const tooLarge = `[editor_ai_too_large ${JSON.stringify({
  megapixels: MAX_PHOTO.megapixels.toLocaleString(),
  pixels: MAX_PHOTO.longSide.toLocaleString(),
})}]`;

// What `promise` failed with.
const failure = (promise: Promise<unknown>) => promise.then(() => null).catch((error: unknown) => error);

describe('failureMessage', () => {
  it("shows the service's own words", () => {
    const refused = new AiEditError(429, 'You have used all your AI edits for today.', { fromService: true });
    expect(failureMessage(refused, t)).toBe('You have used all your AI edits for today.');
  });

  it('says a photo too large for AI edits, as the service refuses it, in its own text', () => {
    const refused = new AiEditError(413, 'Photo too large.', { code: PHOTO_TOO_LARGE, fromService: true });
    expect(failureMessage(refused, t)).toBe(tooLarge);
  });

  it('says how large a photo AI edits take, from ai-tools.json, its numbers written as the locale writes them', () => {
    expect(tooLargeMessage(t)).toBe(tooLarge);
    // In the person's locale, whatever this browser's is: in English as the text said before it
    // took them from the file ("12,000", not "12000"); in German, "12.000".
    const before = get(locale);
    try {
      locale.set('en-US');
      expect(tooLargeMessage(t)).toContain('"megapixels":"100","pixels":"12,000"');
      locale.set('de-DE');
      expect(tooLargeMessage(t)).toContain('"megapixels":"100","pixels":"12.000"');
    } finally {
      locale.set(before);
    }
  });

  it("says the service couldn't be reached, or an edit's picture couldn't be loaded, in translated texts", () => {
    const unreachable = new AiEditError(0, "Couldn't reach Memento's extras service. Check your connection.");
    expect(failureMessage(unreachable, t)).toBe('[errors.unable_to_connect]');
    const image = new AiEditError(500, "Couldn't load the edited photo (500).", { code: IMAGE_UNAVAILABLE });
    expect(failureMessage(image, t)).toBe('[error_loading_image]');
  });

  it("never shows the app's own English for an answer that isn't the service's", () => {
    expect(failureMessage(new AiEditError(502, 'AI edit failed (502).'), t)).toBe('[errors.something_went_wrong]');
  });

  it('says an unreadable photo, or one too large for this browser, in translated texts', () => {
    expect(failureMessage(new AdjustExportError('unreadable'), t)).toBe('[error_loading_image]');
    expect(failureMessage(new AdjustExportError('too-large'), t)).toBe('[editor_copy_too_large]');
    expect(failureMessage(new NeedsOriginalError(), t)).toBe('[editor_ai_needs_original]');
  });

  it('never shows the shape note, which offers buttons only a kept result has', () => {
    expect(failureMessage(new ShapeChangedError(), t)).toBe('[errors.something_went_wrong]');
  });

  it('never shows anything else’s technical text', () => {
    for (const error of [
      new TypeError('Failed to fetch'),
      new DOMException('The source image could not be decoded.', 'InvalidStateError'),
      new Error('boom'),
      'a string',
      undefined,
    ]) {
      expect(failureMessage(error, t)).toBe('[errors.something_went_wrong]');
    }
  });
});

describe("the service's answers, as AI Edit reads them", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (status: number, body: string) =>
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status })));

  it("keeps a refusal's words, its reason and today's usage", async () => {
    answer(
      413,
      JSON.stringify({
        error: 'This photo is too large for AI edits.',
        code: 'photo_too_large',
        usage: { today: { used: 3, limit: 20 }, thisMonth: { used: 100, limit: 500, estimatedCostUsd: 1 } },
      }),
    );
    const refused = (await failure(createAiEdit('asset', 'make it warmer'))) as AiEditError;
    expect(refused).toBeInstanceOf(AiEditError);
    expect([refused.status, refused.code, refused.fromService, refused.usage?.today.used]).toEqual([
      413,
      'photo_too_large',
      true,
      3,
    ]);
    expect(failureMessage(refused, t)).toBe(tooLarge);
  });

  it("shows a saved paste's refusal in the service's own words", async () => {
    answer(400, JSON.stringify({ error: "That isn't this photo at its full size." }));
    const refused = await failure(saveAiEditArea('edit', new Blob(['x'], { type: 'image/jpeg' })));
    expect(failureMessage(refused, t)).toBe("That isn't this photo at its full size.");
  });

  it('says something went wrong when something other than the service answered', async () => {
    answer(502, '<html>Bad gateway</html>');
    const refused = (await failure(createAiEdit('asset', 'make it warmer'))) as AiEditError;
    expect(refused.fromService).toBe(false);
    expect(failureMessage(refused, t)).toBe('[errors.something_went_wrong]');
  });

  it("says an edit's picture couldn't be loaded, or the service couldn't be reached", async () => {
    answer(404, JSON.stringify({ error: 'No such edit.' }));
    expect(failureMessage(await failure(getAiEditImage('edit')), t)).toBe('[error_loading_image]');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const unreachable = (await failure(getAiEditImage('edit'))) as AiEditError;
    expect(failureMessage(unreachable, t)).toBe('[errors.unable_to_connect]');
    expect(unreachable.cause).toBeInstanceOf(TypeError); // the real cause, for the console
    expect(failureMessage(await failure(createAiEdit('asset', 'make it warmer')), t)).toBe(
      '[errors.unable_to_connect]',
    );
  });
});
