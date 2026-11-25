// SelfPhotos Adjust: where it opens from. Not part of Immich.
//   - Immich's editor (its Edit button): our tabs next to its crop tool (AdjustEntry.svelte).
//   - Photos Immich's editor won't open (motion photos): an Edit button of ours, looking the
//     same, that opens Adjust directly.
// The page is /photos/adjust/<photo id>?tab=adjust|filters|straighten|markup.

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
  // Only your own photos: the copy is saved into your library, stacked on the original.
  isOwner: boolean;
};

// Whether Adjust can work on this photo (the server checks the same).
export const canAdjust = (target: Target | undefined): target is Target =>
  isAdjustEnabled() && !!target && target.isOwner && target.isImage && !target.isTrashed;

// The same, for a photo as Immich describes it: yours (logged in, not in the locked folder:
// the copy would land outside it), a photo, not in the trash.
export const canAdjustAsset = (asset: AssetResponseDto) =>
  authManager.authenticated &&
  canAdjust({
    id: asset.id,
    isImage: asset.type === AssetTypeEnum.Image,
    isTrashed: asset.isTrashed,
    isOwner: asset.ownerId === authManager.user.id && asset.visibility !== AssetVisibility.Locked,
  });

// The Edit button for photos Immich's own editor doesn't open. `immichEditShown` is whether
// Immich's Edit button is there (then Adjust is a tab inside its editor instead).
export const getAdjustAction = (
  target: Target | undefined,
  immichEditShown: () => boolean,
  title: string,
): ActionItem => {
  // Until the switches are loaded (by the editor, AI Edit's button or the admin page) Adjust
  // counts as on; the service refuses it if it's off.
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
