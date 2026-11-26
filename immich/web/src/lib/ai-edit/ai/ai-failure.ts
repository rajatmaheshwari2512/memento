// SelfPhotos AI Edit: what a failure says, in plain words, never an exception's own technical
// text.

import { AdjustExportError } from '#lib/ai-edit/adjust/adjust-export.ts';
import { AiEditError, IMAGE_UNAVAILABLE, PHOTO_TOO_LARGE } from '#lib/ai-edit/ai-edit-api.ts';
import { NeedsOriginalError } from '#lib/ai-edit/ai/ai-area.ts';
import { MAX_PHOTO } from '#lib/ai-edit/ai/ai-tools.ts';
import { locale } from '#lib/stores/preferences.store.ts';
import type { Translations } from 'svelte-i18n';
import { get } from 'svelte/store';

type Translate = (key: Translations, options?: { values: Record<string, string> }) => string;

// The photo is too large for AI edits.
export const tooLargeMessage = (t: Translate) => {
  const $locale = get(locale);
  return t('editor_ai_too_large', {
    values: {
      megapixels: MAX_PHOTO.megapixels.toLocaleString($locale),
      pixels: MAX_PHOTO.longSide.toLocaleString($locale),
    },
  });
};

// A failure in AI Edit as a message to show (inside editor_ai_failed).
export function failureMessage(error: unknown, t: Translate): string {
  if (error instanceof AiEditError) {
    if (error.code === PHOTO_TOO_LARGE) {
      return tooLargeMessage(t);
    }
    if (error.fromService) {
      return error.message;
    }
    if (error.status === 0) {
      return t('errors.unable_to_connect');
    }
    return t(error.code === IMAGE_UNAVAILABLE ? 'error_loading_image' : 'errors.something_went_wrong');
  }
  if (error instanceof AdjustExportError) {
    return t(error.reason === 'unreadable' ? 'error_loading_image' : 'editor_copy_too_large');
  }
  if (error instanceof NeedsOriginalError) {
    return t('editor_ai_needs_original');
  }
  return t('errors.something_went_wrong');
}
