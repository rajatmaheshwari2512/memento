// Where captions are kept, in the service's database (data.db); the tables are defined in migrations.ts:
//   captions      one row per photo: its owner, the caption, which model wrote it
//   caption_tags  the photo's tags, one row each
//   captions_fts  SQLite's full-text index (FTS5) over each caption's words and tags, for
//                 Ask Photos. It's an index, not a copy: saveCaption keeps it in step.

import { atomically, database } from "../../db/database.ts";
import type { CaptionMatch, CaptionRecord, Tag } from "../../types/captions.types.ts";

// Adds a caption, or replaces the photo's earlier one, with its tags and index entry.
export function saveCaption(record: CaptionRecord): void {
  atomically(() => {
    const { id } = database().prepare(`
      INSERT INTO captions (asset_id, owner_id, caption, model, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (asset_id) DO UPDATE SET
        owner_id = excluded.owner_id, caption = excluded.caption, model = excluded.model, created_at = excluded.created_at
      RETURNING id
    `).get(record.assetId, record.ownerId, record.caption, record.model, new Date().toISOString()) as { id: number };
    database().prepare("DELETE FROM caption_failures WHERE asset_id = ?").run(record.assetId);
    database().prepare("DELETE FROM caption_tags WHERE caption_id = ?").run(id);
    const tag = database().prepare("INSERT INTO caption_tags (caption_id, tag) VALUES (?, ?)");
    for (const t of record.tags) tag.run(id, t);
    database().prepare("DELETE FROM captions_fts WHERE rowid = ?").run(id);
    database().prepare("INSERT INTO captions_fts (rowid, caption, tags) VALUES (?, ?, ?)").run(id, record.caption, record.tags.join(" "));
  });
}

// Every photo that has a caption (the night run skips them).
export function captionedAssetIds(): Set<string> {
  const rows = database().prepare("SELECT asset_id FROM captions").all() as { asset_id: string }[];
  return new Set(rows.map((r) => r.asset_id));
}

// Photos the night run couldn't caption, and on how many nights.
export function captionFailures(): Map<string, number> {
  const rows = database().prepare("SELECT asset_id, nights FROM caption_failures").all() as Array<{ asset_id: string; nights: number }>;
  return new Map(rows.map((r) => [r.asset_id, r.nights]));
}

// One more night this photo couldn't be captioned. `error` is only the kind of failure.
export function recordCaptionFailure(assetId: string, error: string): void {
  database().prepare(`
    INSERT INTO caption_failures (asset_id, nights, last_error, last_at) VALUES (?, 1, ?, ?)
    ON CONFLICT (asset_id) DO UPDATE SET nights = nights + 1, last_error = excluded.last_error, last_at = excluded.last_at
  `).run(assetId, error, new Date().toISOString());
}

// Deletes these photos' captions and failure records.
export function deleteCaptions(assetIds: string[]): void {
  atomically(() => {
    const caption = database().prepare("DELETE FROM captions WHERE asset_id = ?");
    const failure = database().prepare("DELETE FROM caption_failures WHERE asset_id = ?");
    for (const id of assetIds) {
      caption.run(id);
      failure.run(id);
    }
  });
}

// The full-text query for `query`: every word must match; null when there are no words.
function matchQuery(query: string): string | null {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length === 0 ? null : words.slice(0, 20).map((w) => `"${w}"`).join(" ");
}

// The owner's photos whose caption or tags contain every word of `query`, best first.
export function searchCaptions(ownerId: string, query: string, limit = 200): CaptionMatch[] {
  const match = matchQuery(query);
  if (match === null) return [];
  const rows = database().prepare(`
    SELECT c.asset_id, c.caption, (SELECT json_group_array(tag) FROM caption_tags t WHERE t.caption_id = c.id) AS tags
    FROM captions_fts JOIN captions c ON c.id = captions_fts.rowid
    WHERE captions_fts MATCH ? AND c.owner_id = ?
    ORDER BY captions_fts.rank
    LIMIT ?
  `).all(match, ownerId, limit) as { asset_id: string; caption: string; tags: string }[];
  return rows.map((r) => ({ assetId: r.asset_id, caption: r.caption, tags: JSON.parse(r.tags) as Tag[] }));
}

// The same, only the photo IDs (Ask Photos asks Immich for the rest).
export function searchCaptionIds(ownerId: string, query: string, limit = 200): string[] {
  const match = matchQuery(query);
  if (match === null) return [];
  const rows = database().prepare(`
    SELECT c.asset_id FROM captions_fts JOIN captions c ON c.id = captions_fts.rowid
    WHERE captions_fts MATCH ? AND c.owner_id = ?
    ORDER BY captions_fts.rank
    LIMIT ?
  `).all(match, ownerId, limit) as { asset_id: string }[];
  return rows.map((r) => r.asset_id);
}
