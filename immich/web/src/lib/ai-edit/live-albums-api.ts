// SelfPhotos live albums: calls to Memento's extras service (memento-extras) at /extras.
// An album that fills itself with photos of chosen people. See SelfPhotos FEATURES.md.

import { request } from '#lib/ai-edit/ai-edit-api.ts';

export type LiveAlbum = {
  id: string;
  albumId: string;
  albumName: string;
  match: 'any' | 'all'; // any: at least one of the people; all: all of them in the same photo
  include: string[];
  exclude: string[];
  since: string | null; // YYYY-MM-DD
  createdAt: string;
  lastRunAt: string | null;
  lastAdded: number;
  totalAdded: number;
  pausedReason: string | null;
};

export type LiveAlbumRules = { include: string[]; exclude: string[]; match: 'any' | 'all'; since: string | null };

export const listLiveAlbums = () => request<LiveAlbum[]>('GET', '/live-albums');

// A new album ({ albumName }) or one of yours ({ albumId }).
export const createLiveAlbum = (target: { albumName: string } | { albumId: string }, rules: LiveAlbumRules) =>
  request<LiveAlbum>('POST', '/live-albums', { ...target, ...rules });

export const updateLiveAlbum = (id: string, rules: LiveAlbumRules) =>
  request<LiveAlbum>('PUT', `/live-albums/${encodeURIComponent(id)}`, rules);

// Stops it adding photos. The album and its photos stay.
export const deleteLiveAlbum = (id: string) => request<void>('DELETE', `/live-albums/${encodeURIComponent(id)}`, {});

export const checkLiveAlbum = (id: string) =>
  request<{ added: number; considered: number; skipped: string | null; liveAlbum: LiveAlbum }>(
    'POST',
    `/live-albums/${encodeURIComponent(id)}/check`,
    {},
  );
