// SelfPhotos AI edit: the "AI Edit" menu item, shared by the photo viewer's menu and the
// timeline's selection menu.

import { isGeminiEnabled, loadMementoFlags } from '#lib/ai-edit/flags.svelte.ts';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import type { ActionItem } from '@immich/ui';
import { mdiCreationOutline } from '@mdi/js';
import { goto } from '$app/navigation';

// Its name: the button's, and AI Edit's page title and header.
export const AI_EDIT_TITLE = 'AI Edit';

// AI Edit's page (routes/(user)/photos/edit/[id=id]).
export const aiEditPath = (assetId: string) => `/photos/edit/${assetId}`;

// Whether AI edits can work on this photo.
export const canAiEditAsset = (asset: AssetResponseDto) =>
  isGeminiEnabled() &&
  authManager.authenticated &&
  asset.ownerId === authManager.user.id &&
  asset.type === AssetTypeEnum.Image &&
  !asset.isTrashed &&
  asset.visibility !== AssetVisibility.Locked;

type Target = {
  id: string;
  isImage: boolean;
  isTrashed: boolean;
  isOwner: boolean;
};

export const getAiEditAction = (target: Target | undefined, beforeOpen?: () => void): ActionItem => {
  void loadMementoFlags();
  return {
    title: AI_EDIT_TITLE,
    icon: mdiCreationOutline,
    $if: () => isGeminiEnabled() && !!target && target.isOwner && target.isImage && !target.isTrashed,
    onAction: async () => {
      if (!target) {
        return;
      }
      beforeOpen?.();
      await goto(aiEditPath(target.id));
    },
  };
};
