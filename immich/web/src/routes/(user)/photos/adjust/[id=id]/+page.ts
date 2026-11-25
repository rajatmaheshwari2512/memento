// SelfPhotos Adjust page: /photos/adjust/<photo id>?tab=adjust|filters|straighten|markup.
// As with the AI Edit page, the param is `id` and the photo `adjustAsset`, not
// `assetId`/`asset`: the (user) layout opens the photo viewer for those.
import type { AdjustTab } from '#lib/ai-edit/adjust/adjust-action.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { getAssetInfo } from '@immich/sdk';
import type { PageLoad } from './$types';

const TABS = new Set<AdjustTab>(['adjust', 'filters', 'straighten', 'markup']);

export const load = (async ({ url, params }) => {
  await authenticate(url);
  const adjustAsset = await getAssetInfo({ id: params.id });
  const requested = url.searchParams.get('tab') as AdjustTab | null;
  const $t = await getFormatter();

  return {
    adjustAsset,
    tab: requested && TABS.has(requested) ? requested : ('adjust' as AdjustTab),
    meta: {
      title: $t('editor'),
    },
  };
}) satisfies PageLoad;
