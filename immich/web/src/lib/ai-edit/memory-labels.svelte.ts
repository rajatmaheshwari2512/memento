// SelfPhotos themed memories.

import { isThemedMemoriesEnabled, loadMementoFlags } from '#lib/ai-edit/flags.svelte.ts';
import { getMemoryLabels } from '#lib/ai-edit/memories-api.ts';

const REFRESH_MS = 60_000;

const labels = $state<{ byId: Record<string, string> }>({ byId: {} });
let loadedAt = 0;
let loading: Promise<void> | undefined;

// Memento's title for this memory, if it made it (and an admin hasn't switched them off since).
export const memoryLabel = (memoryId: string): string | undefined =>
  isThemedMemoriesEnabled() ? labels.byId[memoryId] : undefined;

export const loadMemoryLabels = (): Promise<void> => {
  if (loading || Date.now() - loadedAt < REFRESH_MS) {
    return loading ?? Promise.resolve();
  }
  loading = (async () => {
    try {
      await loadMementoFlags();
      const { memories } = isThemedMemoriesEnabled() ? await getMemoryLabels() : { memories: [] };
      labels.byId = Object.fromEntries(memories.map(({ memoryId, label }) => [memoryId, label]));
    } catch {
    } finally {
      loadedAt = Date.now();
      loading = undefined;
    }
  })();
  return loading;
};
