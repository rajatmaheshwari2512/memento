// SelfPhotos feature flags.

import { getMementoFlags, type MementoFlags } from '#lib/ai-edit/ai-edit-api.ts';

export const mementoFlags = $state<{ value: MementoFlags | null }>({ value: null });

let loading: Promise<void> | undefined;

export const loadMementoFlags = () => {
  loading ??= getMementoFlags()
    .then(({ flags }) => {
      mementoFlags.value = flags;
    })
    .catch(() => {
      loading = undefined;
    });
  return loading;
};

export const isGeminiEnabled = () => mementoFlags.value?.gemini.enabled ?? true;

// The AI tools (presets and highlighting).
export const isAiToolsEnabled = () =>
  mementoFlags.value === null || (mementoFlags.value.gemini.enabled && (mementoFlags.value.gemini.tools ?? false));

export const isLiveAlbumsEnabled = () => mementoFlags.value?.liveAlbums.enabled ?? true;

export const isAdjustEnabled = () => mementoFlags.value === null || (mementoFlags.value.adjust?.enabled ?? false);

export const isReduceNoiseEnabled = () =>
  mementoFlags.value === null || (mementoFlags.value.reduceNoise?.enabled ?? false);

// Off until the flags are known.
export const isAskPhotosEnabled = () => mementoFlags.value?.askPhotos?.enabled ?? false;

// Known to be off (loaded, and off).
export const isAskPhotosOff = () => mementoFlags.value !== null && !isAskPhotosEnabled();

// Themed memories and their collages and videos.
export const isThemedMemoriesEnabled = () => mementoFlags.value?.themedMemories?.enabled ?? false;
export const isCreationsEnabled = () => mementoFlags.value?.creations?.enabled ?? false;
