// Live albums (services/live-albums.service.ts, repositories/live-albums.repository.ts).

// A live album as stored in the live_albums table.
export type Row = {
  id: string; user_id: string; album_id: string; album_name: string; match: string; since: string | null;
  created_at: string; updated_at: string; last_run_at: string | null; last_added: number; paused_reason: string | null;
};

export type LiveAlbum = {
  id: string; albumId: string; albumName: string; match: "any" | "all"; include: string[]; exclude: string[];
  since: string | null; createdAt: string; lastRunAt: string | null; lastAdded: number; totalAdded: number;
  pausedReason: string | null;
};

// What one check of a live album did with each photo it tried to add.
export type Seen = { assetId: string; outcome: "added" | "duplicate" | "refused"; error: string | null };

// A user's encrypted Immich key, and its ID in Immich.
export type StoredKey = { keyId: string; sealed: string };

export type RunResult = { added: number; considered: number; skipped: string | null };

// The people in a live album's rules.
export type People = { include: string[]; exclude: string[] };

export type Rules = People & { match: "any" | "all"; since: string | null };

// A checked POST /live-albums request (schemas/live-albums.schema.ts): an album of the
// user's, or a new one by name, and its rules.
export type NewLiveAlbum = { album: { albumId: string } | { albumName: string }; rules: Rules };

// What "check for new photos now" answers.
export type CheckResult = RunResult & { liveAlbum: LiveAlbum };
