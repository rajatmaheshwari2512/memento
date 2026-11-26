// SelfPhotos Adjust: where it opens from.

import { isAdjustEnabled } from '#lib/ai-edit/flags.svelte.ts';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import type { ActionItem } from '@immich/ui';
import { mdiTune } from '@mdi/js';
import { goto } from '$app/navigation';

export type AdjustTab = 'adjust' | 'filters' | 'straighten' | 'markup';

export const adjustPath = (assetId: string, tab: AdjustTab = 'adjust') => `/photos/adjust/${assetId}?tab=${tab}`;

type Target = {
  id: string;
  isImage: boolean;
  isTrashed: boolean;
  isOwner: boolean;
};

// Whether Adjust can work on this photo (the server checks the same).
export const canAdjust = (target: Target | undefined): target is Target =>
  isAdjustEnabled() && !!target && target.isOwner && target.isImage && !target.isTrashed;

// The same, for a photo as Immich describes it.
export const canAdjustAsset = (asset: AssetResponseDto) =>
  authManager.authenticated &&
  canAdjust({
    id: asset.id,
    isImage: asset.type === AssetTypeEnum.Image,
    isTrashed: asset.isTrashed,
    isOwner: asset.ownerId === authManager.user.id && asset.visibility !== AssetVisibility.Locked,
  });

export const getAdjustAction = (
  target: Target | undefined,
  immichEditShown: () => boolean,
  title: string,
): ActionItem => {
  return {
    title,
    icon: mdiTune,
    $if: () => !immichEditShown() && canAdjust(target),
    onAction: async () => {
      if (target) {
        await goto(adjustPath(target.id));
      }
    },
  };
};
