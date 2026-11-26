// SelfPhotos themed memories: calls to Memento's extras service (memento-extras) at /extras.

import { request } from '#lib/ai-edit/ai-edit-api.ts';

// One themed memory's title (at most 26 characters), for showing where Immich writes "N years
// ago".
export type MemoryLabel = { memoryId: string; label: string };

// The person's own choices.
export type MemorySettings = { enabled: boolean; creations: boolean; pausedReason: string | null };

export const getMemoryLabels = () => request<{ memories: MemoryLabel[] }>('GET', '/memories/labels', undefined, 10_000);

export const getMemorySettings = () => request<MemorySettings>('GET', '/memories/settings');

// Turning `enabled` on makes a key in the person's name in Immich.
export const updateMemorySettings = (change: Partial<Pick<MemorySettings, 'enabled' | 'creations'>>) =>
  request<MemorySettings>('PUT', '/memories/settings', change);
