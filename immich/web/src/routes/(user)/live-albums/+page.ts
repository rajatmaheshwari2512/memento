// SelfPhotos: the Live albums page (memento-extras). Not part of Immich.
import { authenticate } from '#lib/utils/auth.ts';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  return {
    meta: {
      title: 'Live albums',
    },
  };
}) satisfies PageLoad;
