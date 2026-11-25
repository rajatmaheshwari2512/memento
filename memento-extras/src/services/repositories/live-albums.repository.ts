// Live albums as stored in data.db (tables defined in db/migrations.ts):
//   live_albums        one row per live album: which album, any or all, from when, its status
//   live_album_people  the people in each one's rules, included or left out
//   live_album_seen    every photo each live album has already considered, and what happened
//   user_keys          each user's encrypted key, and its ID in Immich (to delete it later)
// What they do: services/live-albums.service.ts.

import { database } from "../../db/database.ts";
import type { Album } from "../../types/immich.types.ts";
import type { People, Row, Rules, Seen, StoredKey } from "../../types/live-albums.types.ts";

// --- live albums ---

export function liveAlbumRow(id: string): Row | undefined {
  return database().prepare("SELECT * FROM live_albums WHERE id = ?").get(id) as Row | undefined;
}

export function liveAlbumRows(userId: string): Row[] {
  return database().prepare("SELECT * FROM live_albums WHERE user_id = ? ORDER BY created_at").all(userId) as Row[];
}

export function liveAlbumCount(userId: string): number {
  return (database().prepare("SELECT COUNT(*) AS n FROM live_albums WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function isLiveAlbum(albumId: string): boolean {
  return database().prepare("SELECT 1 FROM live_albums WHERE album_id = ?").get(albumId) !== undefined;
}

// Live albums that aren't paused, oldest first.
export function activeLiveAlbumIds(): string[] {
  const rows = database().prepare("SELECT id FROM live_albums WHERE paused_reason IS NULL ORDER BY created_at").all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function insertLiveAlbum(id: string, userId: string, album: Album, rules: Rules): void {
  const now = new Date().toISOString();
  database().prepare(
    "INSERT INTO live_albums (id, user_id, album_id, album_name, match, since, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, album.id, album.albumName, rules.match, rules.since, now, now);
}

// New rules; also clears a pause.
export function updateLiveAlbumRules(id: string, rules: Rules): void {
  database().prepare("UPDATE live_albums SET match = ?, since = ?, updated_at = ?, paused_reason = NULL WHERE id = ?").run(
    rules.match, rules.since, new Date().toISOString(), id,
  );
}

// Its people and seen photos go with it (foreign keys).
export function deleteLiveAlbumRow(id: string): void {
  database().prepare("DELETE FROM live_albums WHERE id = ?").run(id);
}

export function setPaused(id: string, reason: string): void {
  database().prepare("UPDATE live_albums SET paused_reason = ? WHERE id = ?").run(reason, id);
}

export function recordRun(id: string, added: number, albumName: string): void {
  database().prepare("UPDATE live_albums SET last_run_at = ?, last_added = ?, album_name = ? WHERE id = ?").run(
    new Date().toISOString(), added, albumName, id,
  );
}

// --- the people in its rules ---

// In the order they were chosen.
export function peopleOf(id: string): People {
  const rows = database().prepare("SELECT person_id, role FROM live_album_people WHERE live_album_id = ? ORDER BY rowid").all(id) as Array<{
    person_id: string; role: string;
  }>;
  return {
    include: rows.filter((r) => r.role === "include").map((r) => r.person_id),
    exclude: rows.filter((r) => r.role === "exclude").map((r) => r.person_id),
  };
}

export function savePeople(id: string, rules: Rules): void {
  const db = database();
  db.prepare("DELETE FROM live_album_people WHERE live_album_id = ?").run(id);
  const add = db.prepare("INSERT INTO live_album_people (live_album_id, person_id, role) VALUES (?, ?, ?)");
  for (const person of rules.include) add.run(id, person, "include");
  for (const person of rules.exclude) add.run(id, person, "exclude");
}

// --- the photos it has considered ---

export function seenAssetIds(id: string): Set<string> {
  const rows = database().prepare("SELECT asset_id FROM live_album_seen WHERE live_album_id = ?").all(id) as Array<{ asset_id: string }>;
  return new Set(rows.map((r) => r.asset_id));
}

export function addedCount(id: string): number {
  return (database().prepare("SELECT COUNT(*) AS n FROM live_album_seen WHERE live_album_id = ? AND outcome = 'added'").get(id) as { n: number }).n;
}

// Call inside atomically(): a batch is remembered whole or not at all.
export function rememberSeen(id: string, seen: Seen[]): void {
  const remember = database().prepare(
    "INSERT OR IGNORE INTO live_album_seen (live_album_id, asset_id, outcome, error, seen_at) VALUES (?, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const s of seen) remember.run(id, s.assetId, s.outcome, s.error, now);
}

// --- each user's key ---

export function userKey(userId: string): StoredKey | undefined {
  const row = database().prepare("SELECT key_id, sealed FROM user_keys WHERE user_id = ?").get(userId) as { key_id: string; sealed: string } | undefined;
  return row ? { keyId: row.key_id, sealed: row.sealed } : undefined;
}

export function saveUserKey(userId: string, key: StoredKey): void {
  database().prepare(
    "INSERT INTO user_keys (user_id, key_id, sealed, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (user_id) DO UPDATE SET key_id = excluded.key_id, sealed = excluded.sealed, created_at = excluded.created_at",
  ).run(userId, key.keyId, key.sealed, new Date().toISOString());
}

export function deleteUserKey(userId: string): void {
  database().prepare("DELETE FROM user_keys WHERE user_id = ?").run(userId);
}
