// SelfPhotos Adjust page: /photos/adjust/<photo id>?tab=adjust/filters/straighten/markup.
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
