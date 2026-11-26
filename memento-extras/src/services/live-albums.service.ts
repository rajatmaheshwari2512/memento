// Live albums: an album that fills itself with photos of chosen people. Every few minutes this service asks Immich for those people's photos and adds the new ones to the album. It only adds, with a key of the user's own (KEY_PERMISSIONS), only for their own albums and people, never Memento's own creations. Off (the liveAlbums flag) stops the checks and refuses changes.

import { randomUUID } from "node:crypto";
import { addToAlbum, createAlbum, deleteApiKey, getAlbum, KeyRejected, personExists, searchAll } from "../clients/immich.client.ts";
import { config } from "../config.ts";
import { ADD_BATCH, KEY_BROKEN, KEY_NAME, KEY_PERMISSIONS, KEY_PURPOSE, LIVE_ALBUMS_OFF } from "../constants/live-albums.constants.ts";
import { atomically } from "../db/database.ts";
import { type KeySpec, openKey, renewKey } from "./api-key.service.ts";
import { getFlags } from "./flags.service.ts";
import { creationAssetIds } from "./repositories/creations.repository.ts";
import {
  activeLiveAlbumIds, addedCount, deleteLiveAlbumRow, deleteUserKey, insertLiveAlbum, isLiveAlbum, liveAlbumCount, liveAlbumRow,
  liveAlbumRows, peopleOf, recordRun, rememberSeen, savePeople, saveUserKey, seenAssetIds, setPaused, updateLiveAlbumRules, userKey,
} from "./repositories/live-albums.repository.ts";
import type { Credential, User } from "../types/immich.types.ts";
import type { CheckResult, LiveAlbum, NewLiveAlbum, Row, Rules, RunResult, Seen } from "../types/live-albums.types.ts";
import { HttpError, isUuid } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";

const running = new Set<string>();
let passRunning = false;

// Every few minutes, plus once shortly after start. unref: never keeps the process alive.
export function startLiveAlbumChecks(): void {
  setTimeout(() => void runAll(), 30_000).unref();
  setInterval(() => void runAll(), config.liveAlbumsIntervalSeconds * 1000).unref();
}

function toLiveAlbum(r: Row): LiveAlbum {
  return {
    id: r.id, albumId: r.album_id, albumName: r.album_name, match: r.match === "all" ? "all" : "any",
    ...peopleOf(r.id), since: r.since, createdAt: r.created_at, lastRunAt: r.last_run_at, lastAdded: r.last_added,
    totalAdded: addedCount(r.id), pausedReason: r.paused_reason,
  };
}

function rowFor(id: string, userId: string): Row {
  const row = isUuid(id) ? liveAlbumRow(id) : undefined;
  if (!row || row.user_id !== userId) throw new HttpError(404, "Live album not found.");
  return row;
}

function pause(id: string, reason: string): void {
  setPaused(id, reason);
  log({ event: "live_album_paused", liveAlbum: id, reason });
}

// --- The user's key ---

const KEY: KeySpec = {
  purpose: KEY_PURPOSE, name: KEY_NAME, permissions: KEY_PERMISSIONS, what: "live albums",
  // Still accepted by Immich? A quick read with it answers that.
  check: (key) => getAlbum(key, "00000000-0000-4000-8000-000000000000"),
};

function readKey(userId: string): Credential | null {
  const stored = userKey(userId);
  return stored ? openKey(KEY, userId, stored.sealed) : null;
}

// Makes sure the user has a working key, using their login (they're saving a live album).
async function ensureKey(user: User, cred: Credential): Promise<void> {
  const renewed = await renewKey(user, cred, KEY, userKey(user.id), true);
  if (renewed) saveUserKey(user.id, renewed);
}

// --- Checking one live album ---

export async function runLiveAlbum(id: string): Promise<RunResult> {
  if (running.has(id)) return { added: 0, considered: 0, skipped: "already running" };
  const row = liveAlbumRow(id);
  if (!row) return { added: 0, considered: 0, skipped: "not found" };
  if (row.paused_reason) return { added: 0, considered: 0, skipped: "paused" };
  running.add(id);
  const started = Date.now();
  try {
    let cred: Credential | null;
    try {
      cred = readKey(row.user_id);
    } catch {
      pause(id, KEY_BROKEN);
      return { added: 0, considered: 0, skipped: "key unreadable" };
    }
    if (!cred) {
      pause(id, KEY_BROKEN);
      return { added: 0, considered: 0, skipped: "no key" };
    }
    const album = await getAlbum(cred, row.album_id);
    if (!album) {
      pause(id, "The album was deleted. Remove this live album, or make a new one.");
      return { added: 0, considered: 0, skipped: "album gone" };
    }

    const { include, exclude } = peopleOf(id);
    const filter: Record<string, unknown> = {
      personIds: { [row.match === "all" ? "all" : "any"]: include, ...(exclude.length > 0 ? { none: exclude } : {}) },
      albumIds: { none: [row.album_id] },
      visibility: { in: ["timeline"] },
      ...(row.since ? { takenAt: { gte: `${row.since}T00:00:00.000Z` } } : {}),
    };
    const found = await searchAll(cred, { filter }, 200, (a) => a.id);
    const seen = seenAssetIds(id);
    const creations = creationAssetIds(row.user_id);
    const fresh = found.filter((assetId) => !seen.has(assetId) && !creations.has(assetId));

    let added = 0;
    for (let i = 0; i < fresh.length; i += ADD_BATCH) {
      const results = await addToAlbum(cred, row.album_id, fresh.slice(i, i + ADD_BATCH));
      const seenNow = results.map((r): Seen => {
        const outcome = r.success ? "added" : r.error === "duplicate" ? "duplicate" : "refused";
        return { assetId: r.id, outcome, error: outcome === "refused" ? (r.error ?? "unknown") : null };
      });
      atomically(() => rememberSeen(id, seenNow));
      added += seenNow.filter((r) => r.outcome === "added").length;
    }

    recordRun(id, added, album.albumName);
    if (fresh.length > 0) log({ event: "live_album_run", liveAlbum: id, user: row.user_id, considered: fresh.length, added, ms: Date.now() - started });
    return { added, considered: fresh.length, skipped: null };
  } catch (error) {
    if (error instanceof KeyRejected) {
      pause(id, KEY_BROKEN);
      return { added: 0, considered: 0, skipped: "key rejected" };
    }
    log({ event: "live_album_failed", liveAlbum: id, error: error instanceof Error ? error.message : String(error) });
    return { added: 0, considered: 0, skipped: "error" };
  } finally {
    running.delete(id);
  }
}

// One pass over every live album, one at a time. Skipped while the flag is off.
export async function runAll(): Promise<void> {
  if (passRunning || !getFlags().liveAlbums.enabled) return;
  passRunning = true;
  try {
    for (const id of activeLiveAlbumIds()) await runLiveAlbum(id);
  } finally {
    passRunning = false;
  }
}

// --- What the apps call ---

export function requireLiveAlbums(): void {
  if (!getFlags().liveAlbums.enabled) throw new HttpError(403, LIVE_ALBUMS_OFF);
}

async function checkPeople(cred: Credential, { include, exclude }: Rules): Promise<void> {
  for (const person of [...include, ...exclude]) {
    if (!(await personExists(cred, person))) throw new HttpError(400, "One of the chosen people wasn't found.");
  }
}

export function listLiveAlbums(user: User): LiveAlbum[] {
  return liveAlbumRows(user.id).map(toLiveAlbum);
}

// An album of the user's ({ albumId }) or a new one ({ albumName }), with its rules.
export async function createLiveAlbum(user: User, cred: Credential, { album: choice, rules }: NewLiveAlbum): Promise<LiveAlbum> {
  if (liveAlbumCount(user.id) >= config.maxLiveAlbumsPerUser) throw new HttpError(400, `You can have at most ${config.maxLiveAlbumsPerUser} live albums.`);
  await checkPeople(cred, rules);
  await ensureKey(user, cred);

  let album;
  if ("albumId" in choice) {
    album = await getAlbum(cred, choice.albumId);
    if (!album) throw new HttpError(404, "Album not found.");
    if (album.ownerId !== user.id) throw new HttpError(403, "Only your own albums can be live albums.");
    if (isLiveAlbum(album.id)) {
      throw new HttpError(409, "That album is already a live album.");
    }
  } else {
    album = await createAlbum(cred, choice.albumName);
  }

  const id = randomUUID();
  atomically(() => {
    insertLiveAlbum(id, user.id, album, rules);
    savePeople(id, rules);
  });
  log({ event: "live_album_created", liveAlbum: id, user: user.id, album: album.id, people: rules.include.length, match: rules.match });
  void runLiveAlbum(id);
  return toLiveAlbum(rowFor(id, user.id));
}

// Changes the rules. Saving also clears a pause and replaces a key that stopped working.
export async function updateLiveAlbum(user: User, cred: Credential, id: string, rules: Rules): Promise<LiveAlbum> {
  rowFor(id, user.id);
  await checkPeople(cred, rules);
  await ensureKey(user, cred);
  atomically(() => {
    updateLiveAlbumRules(id, rules);
    savePeople(id, rules);
  });
  log({ event: "live_album_updated", liveAlbum: id, user: user.id });
  void runLiveAlbum(id);
  return toLiveAlbum(rowFor(id, user.id));
}

// Stops it filling. The album and its photos stay. With no live albums left, the user's
// key is deleted in Immich too.
export async function deleteLiveAlbum(user: User, cred: Credential, id: string): Promise<void> {
  rowFor(id, user.id);
  deleteLiveAlbumRow(id);
  log({ event: "live_album_deleted", liveAlbum: id, user: user.id });
  if (liveAlbumCount(user.id) === 0) {
    const key = userKey(user.id);
    if (key) {
      await deleteApiKey(cred, key.keyId).catch((error: unknown) => log({ event: "live_album_key_delete_failed", user: user.id, error: String(error) }));
      deleteUserKey(user.id);
      log({ event: "live_album_key_deleted", user: user.id, keyId: key.keyId });
    }
  }
}

export async function checkNow(user: User, id: string): Promise<CheckResult> {
  rowFor(id, user.id);
  const result = await runLiveAlbum(id);
  return { ...result, liveAlbum: toLiveAlbum(rowFor(id, user.id)) };
}
