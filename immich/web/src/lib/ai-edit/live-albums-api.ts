// SelfPhotos live albums: calls to Memento's extras service (memento-extras) at /extras.

import { request } from '#lib/ai-edit/ai-edit-api.ts';

export type LiveAlbum = {
  id: string;
  albumId: string;
  albumName: string;
  match: 'any' | 'all';
  include: string[];
  exclude: string[];
  since: string | null;
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

// Stops it adding photos.
export const deleteLiveAlbum = (id: string) => request<void>('DELETE', `/live-albums/${encodeURIComponent(id)}`, {});

export const checkLiveAlbum = (id: string) =>
  request<{ added: number; considered: number; skipped: string | null; liveAlbum: LiveAlbum }>(
    'POST',
    `/live-albums/${encodeURIComponent(id)}/check`,
    {},
  );
