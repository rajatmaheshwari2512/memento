// The database's whole shape, as numbered steps: the one place to read the schema.
// Never change a step that has shipped; add a new one at the end (it gets the next number).

import type { Migration } from "../types/db.types.ts";

// The version a finished baseline leaves the database at; each step after it adds one.
export const BASELINE_VERSION = 12;

export const MIGRATIONS: readonly Migration[] = [
  {
    name: `${BASELINE_VERSION}: baseline`,
    run(db) {
      db.exec(`
        CREATE TABLE flags (
          key        TEXT PRIMARY KEY,   -- "group.name", e.g. gemini.enabled
          value      TEXT NOT NULL,      -- JSON
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL       -- Immich user ID of the admin
        );

        CREATE TABLE user_keys (
          user_id    TEXT PRIMARY KEY,
          key_id     TEXT NOT NULL,      -- the key's ID in Immich, to delete it later
          sealed     TEXT NOT NULL,      -- the key itself, encrypted (crypto-box.ts)
          created_at TEXT NOT NULL
        );

        -- AI edit log, used for the limits.
        CREATE TABLE edits (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,            -- Immich user
          asset_id     TEXT NOT NULL,            -- Immich photo that was edited
          day          TEXT NOT NULL,            -- YYYY-MM-DD in LIMITS_TIMEZONE, as counted at the time
          created_at   TEXT NOT NULL,
          model        TEXT NOT NULL,
          status       TEXT NOT NULL CHECK (status IN ('reserved', 'done', 'failed')),
          prompt_chars INTEGER NOT NULL,
          cost_usd     REAL NOT NULL DEFAULT 0,  -- estimate; Google bills the real amount
          duration_ms  INTEGER
        );
        CREATE INDEX edits_user_day ON edits (user_id, day);
        CREATE INDEX edits_day ON edits (day);

        -- Live albums: the rules and the latest check.
        CREATE TABLE live_albums (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL,            -- Immich user who set it up
          album_id      TEXT NOT NULL UNIQUE,     -- Immich album; it has one owner, so it's live at most once
          album_name    TEXT NOT NULL,            -- Immich's name for it, refreshed on every check
          match         TEXT NOT NULL CHECK (match IN ('any', 'all')),
          since         TEXT CHECK (since IS NULL OR since GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          last_run_at   TEXT,
          last_added    INTEGER NOT NULL DEFAULT 0,  -- photos added by the latest check
          paused_reason TEXT                         -- set when it can't run; cleared when saved again
        );
        CREATE INDEX live_albums_user ON live_albums (user_id);

        -- One row per person in a live album's rules. The key stops anyone being both
        -- included and excluded.
        CREATE TABLE live_album_people (
          live_album_id TEXT NOT NULL REFERENCES live_albums (id) ON DELETE CASCADE,
          person_id     TEXT NOT NULL,              -- Immich person
          role          TEXT NOT NULL CHECK (role IN ('include', 'exclude')),
          PRIMARY KEY (live_album_id, person_id)
        );
        CREATE INDEX live_album_people_person ON live_album_people (person_id);

        -- Every photo a live album has considered, so it's never tried again.
        CREATE TABLE live_album_seen (
          live_album_id TEXT NOT NULL REFERENCES live_albums (id) ON DELETE CASCADE,
          asset_id      TEXT NOT NULL,              -- Immich photo
          outcome       TEXT NOT NULL CHECK (outcome IN ('added', 'duplicate', 'refused')),
          error         TEXT,                       -- Immich's reason, when refused
          seen_at       TEXT NOT NULL,
          PRIMARY KEY (live_album_id, asset_id)
        );

        -- Captions (caption-store.ts). "id" is an explicit INTEGER PRIMARY KEY so it stays
        -- the same in the backup copy (VACUUM INTO renumbers other row IDs), because the
        -- search index refers to captions by it.
        CREATE TABLE captions (
          id         INTEGER PRIMARY KEY,
          asset_id   TEXT NOT NULL UNIQUE,   -- Immich photo
          owner_id   TEXT NOT NULL,          -- its owner in Immich, so search only returns your own
          caption    TEXT NOT NULL,
          model      TEXT NOT NULL,          -- which model wrote it, so a better one can redo them
          created_at TEXT NOT NULL
        );
        CREATE INDEX captions_owner ON captions (owner_id);

        CREATE TABLE caption_tags (
          caption_id INTEGER NOT NULL REFERENCES captions (id) ON DELETE CASCADE,
          tag        TEXT NOT NULL,          -- from TAGS in captions.ts (checked there; the list can grow)
          PRIMARY KEY (caption_id, tag)
        );
        CREATE INDEX caption_tags_tag ON caption_tags (tag);

        -- The full-text index for Ask Photos: only the words of each caption and its tags,
        -- filed under the caption's id.
        CREATE VIRTUAL TABLE captions_fts USING fts5 (
          caption, tags, content = '', contentless_delete = 1, tokenize = 'porter unicode61'
        );
        CREATE TRIGGER captions_after_delete AFTER DELETE ON captions BEGIN
          DELETE FROM captions_fts WHERE rowid = old.id;
        END;

        -- Night captions (caption-night.ts): photos the model couldn't caption.
        CREATE TABLE caption_failures (
          asset_id   TEXT PRIMARY KEY,                   -- Immich photo
          nights     INTEGER NOT NULL CHECK (nights > 0), -- nights it failed on
          last_error TEXT NOT NULL,                      -- the kind of failure, never the model's reply
          last_at    TEXT NOT NULL
        );

        -- Memento admin: an AI-edit daily limit set for one person.
        CREATE TABLE user_limits (
          user_id     TEXT PRIMARY KEY,  -- Immich user
          daily_edits INTEGER NOT NULL CHECK (daily_edits >= 0), -- its range: flags.ts
          updated_at  TEXT NOT NULL,
          updated_by  TEXT NOT NULL      -- the admin who set it
        );

        -- Themed memories (memories.service.ts): who turned them on, every memory made, and which photos each used.
        CREATE TABLE memory_users (
          user_id         TEXT PRIMARY KEY,                -- Immich user
          key_id          TEXT,                            -- their Immich API key for this, to delete it later
          sealed          TEXT,                            -- that key, encrypted (crypto-box.ts)
          permissions     TEXT,                            -- the permission list it was made with (JSON), to spot an outdated key
          creations       INTEGER NOT NULL DEFAULT 1 CHECK (creations IN (0, 1)), -- their own choice: collages and videos
          paused_reason   TEXT,                            -- set when their key stopped working
          last_run_day    TEXT,                            -- the local day of their last nightly run, YYYY-MM-DD
          last_attempt_at TEXT,                            -- the last try, so a failing one waits before the next
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          collages_album_id   TEXT,                        -- the person's creation albums, found again by id
          recaps_album_id     TEXT,
          animations_album_id TEXT,
          cinematic_album_id  TEXT,
          CHECK ((key_id IS NULL) = (sealed IS NULL))
        );

        CREATE TABLE themed_memories (
          id         INTEGER PRIMARY KEY,
          user_id    TEXT NOT NULL,                        -- Immich user
          theme      TEXT NOT NULL CHECK (theme IN ('trip', 'month', 'big_day', 'spotlight')),
          theme_key  TEXT NOT NULL,                        -- e.g. trip:2026-10-12, month:2026-10, so each is made once
          memory_id  TEXT UNIQUE,                          -- Immich memory, once created
          status     TEXT NOT NULL CHECK (status IN ('pending', 'created', 'failed', 'skipped')), -- skipped: too few good photos
          label      TEXT,                                 -- shown instead of "N years ago"; can hold a name: never logged. NULL when skipped
          person_id  TEXT,                                 -- Spotlight: whose (Immich person)
          first_day  TEXT,                                 -- the local days its photos cover (trips, big days, months)
          last_day   TEXT,
          score      REAL,                                 -- how good its photos are (the weekly creations pick)
          memory_at  TEXT,                                 -- the day of its first photo; NULL when skipped
          show_at    TEXT,
          hide_at    TEXT,
          made_on    TEXT NOT NULL,                        -- local day it was made or skipped (the nightly limit, cooldowns)
          created_at TEXT NOT NULL,
          UNIQUE (user_id, theme_key)
        );
        CREATE INDEX themed_memories_user_made ON themed_memories (user_id, made_on);

        CREATE TABLE themed_memory_assets (
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE,
          asset_id         TEXT NOT NULL,                  -- Immich photo or video
          PRIMARY KEY (themed_memory_id, asset_id)
        );

        -- Creations (creations.service.ts): Sunday's collage and recap, shown together in a memory of their own.
        CREATE TABLE creation_cards (
          id               INTEGER PRIMARY KEY,
          user_id          TEXT NOT NULL,                  -- Immich user
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE, -- made from
          week             TEXT NOT NULL,                  -- the local day (a Sunday) it was picked
          status           TEXT NOT NULL CHECK (status IN ('waiting', 'created', 'empty', 'late', 'failed')),
          memory_id        TEXT UNIQUE,                    -- Immich memory, once created
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          attempts         INTEGER NOT NULL DEFAULT 0,     -- server errors so far
          next_at          TEXT,                           -- not tried again before (UTC)
          extra            INTEGER NOT NULL DEFAULT 0 CHECK (extra IN (0, 1)), -- 1: made by hand, only its creations
          UNIQUE (user_id, week, extra)
        );

        -- One row per collage, recap, animation or cinematic photo a themed memory could get.
        CREATE TABLE creation_jobs (
          id               INTEGER PRIMARY KEY,
          user_id          TEXT NOT NULL,                  -- Immich user
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE,
          kind             TEXT NOT NULL CHECK (kind IN ('collage', 'recap', 'animation', 'cinematic')),
          inputs           TEXT NOT NULL,                  -- JSON: the photos and videos, in order, and the date and place to carry
          state            TEXT NOT NULL CHECK (state IN ('proposed', 'skipped', 'queued', 'running', 'done', 'dropped')),
          rank             REAL NOT NULL,                  -- how good a proposal is: the week's best is made
          attempts         INTEGER NOT NULL DEFAULT 0,
          queued_on        TEXT,                           -- the local day the weekly pick chose it
          next_at          TEXT NOT NULL,                  -- not tried before this (backoff)
          asset_id         TEXT UNIQUE,                    -- the creation in Immich, once uploaded
          last_error       TEXT,                           -- what went wrong, never what's in the photos
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          card_id          INTEGER REFERENCES creation_cards (id) ON DELETE SET NULL,
          work_id          TEXT,                           -- its folder in the work folder, kept until it's uploaded
          rendered_at      TEXT,                           -- the container finished it: only the upload is left
          UNIQUE (themed_memory_id, kind)
        );
        CREATE INDEX creation_jobs_state ON creation_jobs (state, next_at);
        CREATE INDEX creation_jobs_user ON creation_jobs (user_id, state);

        -- Each photo measured once: sharpness and exposure of its thumbnail (creations/src/quality.ts).
        -- sharpness NULL: it couldn't be read, and isn't tried again.
        CREATE TABLE asset_quality (
          asset_id    TEXT PRIMARY KEY,                    -- Immich photo or video
          sharpness   REAL,
          brightness  REAL,
          p2          INTEGER,
          p98         INTEGER,
          measured_at TEXT NOT NULL
        );

        -- Reduce noise for videos (reduce-noise.service.ts): the record of each video cleaned, and what the apps ask while it's going.
        CREATE TABLE noise_jobs (
          id          TEXT PRIMARY KEY,               -- a UUID: the apps ask by it, and it names the job's work folder
          user_id     TEXT NOT NULL,                  -- Immich user
          asset_id    TEXT NOT NULL,                  -- the original video
          state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
          step        TEXT CHECK (step IN ('preparing', 'cleaning', 'saving')), -- while running
          copy_id     TEXT,                           -- the cleaned copy in Immich, once saved
          error       TEXT,                           -- why it failed, as the person was told; never what's in the video
          video_ms    INTEGER,                        -- the original's length and size, as Immich gave them
          video_bytes INTEGER,
          created_at  TEXT NOT NULL,
          started_at  TEXT,
          finished_at TEXT
        );
        CREATE INDEX noise_jobs_user ON noise_jobs (user_id, created_at);
      `);
    },
  },
  {
    name: "13: backup quality",
    run(db) {
      db.exec(`
        -- Each person's backup quality (backup.service.ts). No row: original.
        CREATE TABLE backup_settings (
          user_id    TEXT PRIMARY KEY,   -- Immich user
          quality    TEXT NOT NULL CHECK (quality IN ('original', 'saverHigh', 'saver')),
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    name: "14: drop unused columns",
    run(db) {
      db.exec(`
        ALTER TABLE noise_jobs DROP COLUMN step;

        CREATE TABLE creation_cards_new (
          id               INTEGER PRIMARY KEY,
          user_id          TEXT NOT NULL,                  -- Immich user
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE, -- made from
          week             TEXT NOT NULL,                  -- the local day (a Sunday) it was picked
          status           TEXT NOT NULL CHECK (status IN ('waiting', 'created', 'empty', 'late', 'failed')),
          memory_id        TEXT UNIQUE,                    -- Immich memory, once created
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          attempts         INTEGER NOT NULL DEFAULT 0,     -- server errors so far
          next_at          TEXT,                           -- not tried again before (UTC)
          UNIQUE (user_id, week)
        );
        INSERT INTO creation_cards_new (id, user_id, themed_memory_id, week, status, memory_id, created_at, updated_at, attempts, next_at)
          SELECT id, user_id, themed_memory_id, week, status, memory_id, created_at, updated_at, attempts, next_at FROM creation_cards;
        DROP TABLE creation_cards;
        ALTER TABLE creation_cards_new RENAME TO creation_cards;
      `);
    },
  },
];
