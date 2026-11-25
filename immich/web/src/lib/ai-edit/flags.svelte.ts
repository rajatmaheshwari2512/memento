// SelfPhotos feature flags, as Memento's extras service reports them, for hiding the buttons of
// switched-off features. Loaded once per page load; the admin section updates it after a
// save.
//
// Until loaded, or if the service can't be reached, every feature counts as on, except Ask
// Photos (below). The service itself refuses anything switched off, with a message, so a slow
// or failed load never hides a feature that works.

import { getMementoFlags, type MementoFlags } from '#lib/ai-edit/ai-edit-api.ts';

export const mementoFlags = $state<{ value: MementoFlags | null }>({ value: null });

let loading: Promise<void> | undefined;

export const loadMementoFlags = () => {
  loading ??= getMementoFlags()
    .then(({ flags }) => {
      mementoFlags.value = flags;
    })
    .catch(() => {
      loading = undefined; // try again next time
    });
  return loading;
};

export const isGeminiEnabled = () => mementoFlags.value?.gemini.enabled ?? true;

// The AI tools (presets and highlighting): a service that predates the switch has neither, so
// counts as off.
export const isAiToolsEnabled = () =>
  mementoFlags.value === null || (mementoFlags.value.gemini.enabled && (mementoFlags.value.gemini.tools ?? false));

export const isLiveAlbumsEnabled = () => mementoFlags.value?.liveAlbums.enabled ?? true;

// A service that predates the switch has no Adjust save, so counts as off.
export const isAdjustEnabled = () => mementoFlags.value === null || (mementoFlags.value.adjust?.enabled ?? false);

// Reduce noise for videos: the same (a service from before it can't clean videos).
export const isReduceNoiseEnabled = () =>
  mementoFlags.value === null || (mementoFlags.value.reduceNoise?.enabled ?? false);

// Off until the flags are known: hiding Ask for a moment is better than showing it to someone
// whose admin switched it off. A service that predates the switch counts as off too.
export const isAskPhotosEnabled = () => mementoFlags.value?.askPhotos?.enabled ?? false;

// Known to be off (loaded, and off). Not the same as !isAskPhotosEnabled(), which is also
// true while loading.
export const isAskPhotosOff = () => mementoFlags.value !== null && !isAskPhotosEnabled();

// Themed memories and their collages and videos: off until the flags are known, and when the
// service doesn't list them. Off hides their titles and the person's settings.
export const isThemedMemoriesEnabled = () => mementoFlags.value?.themedMemories?.enabled ?? false;
export const isCreationsEnabled = () => mementoFlags.value?.creations?.enabled ?? false;
