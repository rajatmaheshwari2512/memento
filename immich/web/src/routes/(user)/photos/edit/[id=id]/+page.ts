// SelfPhotos AI edit page: /photos/edit/<photo id>.
// The param is called `id`, not `assetId`, on purpose: the (user) layout opens the photo
// viewer for any route with an assetId, and this page must not open in the viewer.
// For the same reason the photo is returned as `editAsset`, not `asset`.
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
