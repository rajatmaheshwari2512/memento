// SelfPhotos themed memories: calls to Memento's extras service (memento-extras) at /extras.
// Memento makes memories of its own (Spotlight on a person, Best of last month, trips, big
// days, a weekly card) as normal Immich memories, and keeps a short title for each.

import { request } from '#lib/ai-edit/ai-edit-api.ts';

// One themed memory's title (at most 26 characters), for showing where Immich writes
// "N years ago". Matched by Immich's memory id.
export type MemoryLabel = { memoryId: string; label: string };

// The person's own choices. `pausedReason`: why Memento stopped making them (e.g. its key
// was deleted in Immich), or null.
export type MemorySettings = { enabled: boolean; creations: boolean; pausedReason: string | null };

// Given up after 10 s: Immich's own titles show meanwhile.
export const getMemoryLabels = () => request<{ memories: MemoryLabel[] }>('GET', '/memories/labels', undefined, 10_000);

export const getMemorySettings = () => request<MemorySettings>('GET', '/memories/settings');

// Turning `enabled` on makes a key in the person's name in Immich (so memories can be made at
// night); it needs a logged-in browser, which the cookie is.
export const updateMemorySettings = (change: Partial<Pick<MemorySettings, 'enabled' | 'creations'>>) =>
  request<MemorySettings>('PUT', '/memories/settings', change);
