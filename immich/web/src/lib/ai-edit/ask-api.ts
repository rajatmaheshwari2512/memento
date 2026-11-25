// SelfPhotos Ask Photos: a question in plain English → matching photos, answered by
// Memento's extras service (memento-extras, POST /ask). See SelfPhotos FEATURES.md, section 4.

import { request } from '#lib/ai-edit/ai-edit-api.ts';
import type { AssetResponseDto } from '@immich/sdk';

// What the service understood from the question, shown as chips above the results.
export type AskUnderstood = {
  text: string; // the words left for the search model ('' when none)
  people: Array<{ id: string; name: string }>; // all of them in the photo
  dates: { label: string } | null;
  place: { name: string; kind: 'city' | 'state' | 'country' } | null; // a place in the asker's photos ("in Goa")
  type: 'IMAGE' | 'VIDEO' | null;
  favorite: boolean;
  order: 'newest' | 'oldest' | null; // "the last time …", "earliest …"; null: best match first
  hints: string[]; // e.g. how to make "me" work
};

export type AskResult = { understood: AskUnderstood; assets: AssetResponseDto[]; nextCursor: string | null };

// "Last December" and "today" are read in this browser's time zone.
export const askPhotos = (question: string, language: string, cursor?: string) =>
  request<AskResult>('POST', '/ask', {
    question,
    language,
    timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(cursor && { cursor }),
  });
