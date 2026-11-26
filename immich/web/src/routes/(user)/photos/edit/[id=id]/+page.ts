// SelfPhotos AI edit page: /photos/edit/<photo id>.
import { AI_EDIT_TITLE } from '#lib/ai-edit/ai-edit-action.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { getAssetInfo } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url, params }) => {
  await authenticate(url);
  const editAsset = await getAssetInfo({ id: params.id });

  return {
    editAsset,
    meta: {
      title: AI_EDIT_TITLE,
    },
  };
}) satisfies PageLoad;
