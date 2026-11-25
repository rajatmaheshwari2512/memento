// Live albums: the key they use in Immich, batch sizes, and the switched-off message
// (services/live-albums.service.ts).

export const KEY_NAME = "Memento live albums";

export const KEY_PERMISSIONS = ["asset.read", "album.read", "albumAsset.create"];

export const KEY_PURPOSE = "live-albums api-keys";

export const MAX_PEOPLE = 20;

export const ADD_BATCH = 1000;

export const KEY_BROKEN = "Memento's key for live albums stopped working. Open Live albums and save any of them to fix it.";

export const LIVE_ALBUMS_OFF = "Live albums are switched off. An admin can turn them on in Administration → Settings → Memento Features.";
