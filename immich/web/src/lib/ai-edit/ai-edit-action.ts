// SelfPhotos AI edit: the "AI Edit" menu item, shared by the photo viewer's menu and the
// timeline's selection menu. It opens AI Edit, /photos/edit/<photo id>; nothing else does.

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

// Whether AI edits can work on this photo, as Immich describes it (the server checks the same):
// switched on, yours (logged in, not in the locked folder: the copy would land outside it), a
// photo, not in the trash.
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
  // Only your own photos: the edit is saved into your library, stacked with the original.
  isOwner: boolean;
};

export const getAiEditAction = (target: Target | undefined, beforeOpen?: () => void): ActionItem => {
  void loadMementoFlags();
  return {
    title: AI_EDIT_TITLE,
    icon: mdiCreationOutline,
    // Hidden when an admin has switched Gemini edits off (Administration → Settings → Memento Features).
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
