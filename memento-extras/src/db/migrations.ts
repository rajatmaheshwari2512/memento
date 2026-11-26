// The database's whole shape, as numbered steps: the one place to read the schema.
// Never change a step that has shipped; add a new one at the end.
// Changes SQLite can't do in place rebuild the table: create the new one, copy the rows across, drop the old one, rename the new one.

import type { Migration } from "../types/db.types.ts";

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "1: the tables as first shipped",
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS edits (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          asset_id     TEXT NOT NULL,
          day          TEXT NOT NULL,
          month        TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          model        TEXT NOT NULL,
          status       TEXT NOT NULL,
          prompt_chars INTEGER NOT NULL,
          cost_usd     REAL NOT NULL DEFAULT 0,
          duration_ms  INTEGER
        );
        CREATE INDEX IF NOT EXISTS edits_user_day ON edits (user_id, day);
        CREATE INDEX IF NOT EXISTS edits_month ON edits (month);

        CREATE TABLE IF NOT EXISTS flags (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS live_albums (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL,
          album_id      TEXT NOT NULL,
          album_name    TEXT NOT NULL,
          include_ids   TEXT NOT NULL,
          match         TEXT NOT NULL,
          exclude_ids   TEXT NOT NULL,
          since         TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          last_run_at   TEXT,
          last_added    INTEGER NOT NULL DEFAULT 0,
          total_added   INTEGER NOT NULL DEFAULT 0,
          paused_reason TEXT,
          UNIQUE (user_id, album_id)
        );
        CREATE TABLE IF NOT EXISTS live_album_seen (
          live_album_id TEXT NOT NULL,
          asset_id      TEXT NOT NULL,
          outcome       TEXT NOT NULL,
          PRIMARY KEY (live_album_id, asset_id)
        );
        CREATE TABLE IF NOT EXISTS user_keys (
          user_id    TEXT PRIMARY KEY,
          key_id     TEXT NOT NULL,
          sealed     TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    name: "2: people and photos of live albums in their own tables, checks, foreign keys, captions",
    run(db) {
      db.exec(`
        -- AI edit log, used for the limits. "month" was just the first 7 characters of
        -- "day", so it goes. Status can only be one of three values.
        CREATE TABLE edits_v2 (
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
        INSERT INTO edits_v2
          SELECT id, user_id, asset_id, day, created_at, model, status, prompt_chars, cost_usd, duration_ms FROM edits;
        DROP TABLE edits;
        ALTER TABLE edits_v2 RENAME TO edits;
        CREATE INDEX edits_user_day ON edits (user_id, day);
        CREATE INDEX edits_day ON edits (day);

        -- Live albums: the rules and the latest check. The people and the photos considered
        -- are in their own tables below; "total added" is counted from the photos.
        CREATE TABLE live_albums_v2 (
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
        INSERT INTO live_albums_v2
          SELECT id, user_id, album_id, album_name, match, since, created_at, updated_at, last_run_at, last_added, paused_reason
          FROM live_albums;

        -- One row per person in a live album's rules. The key stops anyone being both
        -- included and excluded.
        CREATE TABLE live_album_people (
          live_album_id TEXT NOT NULL REFERENCES live_albums (id) ON DELETE CASCADE,
          person_id     TEXT NOT NULL,              -- Immich person
          role          TEXT NOT NULL CHECK (role IN ('include', 'exclude')),
          PRIMARY KEY (live_album_id, person_id)
        );
        INSERT OR IGNORE INTO live_album_people
          SELECT l.id, j.value, 'include' FROM live_albums l, json_each(l.include_ids) j;
        INSERT OR IGNORE INTO live_album_people
          SELECT l.id, j.value, 'exclude' FROM live_albums l, json_each(l.exclude_ids) j;

        -- Every photo a live album has considered, so it's never tried again (a photo you
        -- remove from the album stays removed).
        CREATE TABLE live_album_seen_v2 (
          live_album_id TEXT NOT NULL REFERENCES live_albums (id) ON DELETE CASCADE,
          asset_id      TEXT NOT NULL,              -- Immich photo
          outcome       TEXT NOT NULL CHECK (outcome IN ('added', 'duplicate', 'refused')),
          error         TEXT,                       -- Immich's reason, when refused
          seen_at       TEXT NOT NULL,
          PRIMARY KEY (live_album_id, asset_id)
        );
        -- Rows from before had no time; their album's latest check is the best guess.
        INSERT INTO live_album_seen_v2
          SELECT s.live_album_id, s.asset_id,
            CASE WHEN s.outcome IN ('added', 'duplicate') THEN s.outcome ELSE 'refused' END,
            CASE WHEN s.outcome IN ('added', 'duplicate') THEN NULL ELSE s.outcome END,
            COALESCE(l.last_run_at, l.created_at)
          FROM live_album_seen s JOIN live_albums l ON l.id = s.live_album_id;

        DROP TABLE live_album_seen;
        DROP TABLE live_albums;
        ALTER TABLE live_albums_v2 RENAME TO live_albums;
        ALTER TABLE live_album_seen_v2 RENAME TO live_album_seen;
        CREATE INDEX live_albums_user ON live_albums (user_id);
        CREATE INDEX live_album_people_person ON live_album_people (person_id);

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

        -- The full-text index for Ask Photos: an index, not a copy of the data. It holds only
        -- the words of each caption and its tags, filed under the caption's id.
        -- porter: "cakes" also finds "cake". unicode61: words in any script.
        CREATE VIRTUAL TABLE captions_fts USING fts5 (
          caption, tags, content = '', contentless_delete = 1, tokenize = 'porter unicode61'
        );
        CREATE TRIGGER captions_after_delete AFTER DELETE ON captions BEGIN
          DELETE FROM captions_fts WHERE rowid = old.id;
        END;
      `);
    },
  },
  {
    // Night captions (caption-night.ts): photos the model couldn't caption.
    name: "3: photos that failed to caption",
    run(db) {
      db.exec(`
        CREATE TABLE caption_failures (
          asset_id   TEXT PRIMARY KEY,                   -- Immich photo
          nights     INTEGER NOT NULL CHECK (nights > 0), -- nights it failed on
          last_error TEXT NOT NULL,                      -- the kind of failure, never the model's reply
          last_at    TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Memento admin: an AI-edit daily limit set for one person.
    name: "4: per-person AI edit limits",
    run(db) {
      db.exec(`
        CREATE TABLE user_limits (
          user_id     TEXT PRIMARY KEY,  -- Immich user
          daily_edits INTEGER NOT NULL CHECK (daily_edits >= 0), -- its range: flags.ts
          updated_at  TEXT NOT NULL,
          updated_by  TEXT NOT NULL      -- the admin who set it
        );
      `);
    },
  },
  {
    // Themed memories (memories.service.ts): who turned them on, every memory made and its label, and which photos each used.
    name: "5: themed memories",
    run(db) {
      db.exec(`
        -- One row per person who turned themed memories on. Turning them off removes the key
        -- (key_id, sealed and permissions go back to NULL) but keeps their choices and history.
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
          CHECK ((key_id IS NULL) = (sealed IS NULL))
        );

        -- Every themed memory, from just before it's created in Immich. "pending" with no
        -- memory_id means the service stopped mid-way: it's never tried again (the key makes
        -- sure), so at worst one memory lacks its label. Rows stay after Immich removes the
        -- memory (unsaved ones go after 30 days): they're what stops a theme repeating.
        CREATE TABLE themed_memories (
          id         INTEGER PRIMARY KEY,
          user_id    TEXT NOT NULL,                        -- Immich user
          theme      TEXT NOT NULL CHECK (theme IN ('trip', 'month', 'big_day', 'spotlight')),
          theme_key  TEXT NOT NULL,                        -- e.g. trip:2026-10-12, month:2026-10, so each is made once
          memory_id  TEXT UNIQUE,                          -- Immich memory, once created
          status     TEXT NOT NULL CHECK (status IN ('pending', 'created', 'failed')),
          label      TEXT NOT NULL,                        -- shown instead of "N years ago"; can hold a name: never logged
          person_id  TEXT,                                 -- Spotlight: whose (Immich person)
          memory_at  TEXT NOT NULL,                        -- the day of its first photo
          show_at    TEXT NOT NULL,
          hide_at    TEXT NOT NULL,
          made_on    TEXT NOT NULL,                        -- local day it was made (the nightly limit)
          created_at TEXT NOT NULL,
          UNIQUE (user_id, theme_key)
        );
        CREATE INDEX themed_memories_user_made ON themed_memories (user_id, made_on);

        -- The photos in each, so the same ones aren't used again for a while.
        CREATE TABLE themed_memory_assets (
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE,
          asset_id         TEXT NOT NULL,                  -- Immich photo or video
          PRIMARY KEY (themed_memory_id, asset_id)
        );
      `);
    },
  },
  {
    // Creations (creations.service.ts): the queue of jobs (also the record of every one made), photos' measured quality, each person's albums.
    name: "6: creations queue, photo quality, Collages and Recaps albums",
    run(db) {
      db.exec(`
        -- One row per collage or video a themed memory could get. It starts 'proposed'; once a
        -- week the best proposal of each kind is queued and the rest 'skipped' (WEEKLY in
        -- creations.constants.ts). Queued ones are made one at a time by one worker; a row left
        -- 'running' by a crash is queued again at start. Once uploaded, asset_id marks the
        -- Immich asset as Memento's own, so it's never used as a source photo.
        CREATE TABLE creation_jobs (
          id               INTEGER PRIMARY KEY,
          user_id          TEXT NOT NULL,                  -- Immich user
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE,
          kind             TEXT NOT NULL CHECK (kind IN ('collage', 'recap')),
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

        -- The person's "Collages" and "Recaps" albums, found again by id (renaming one is fine;
        -- a deleted one is made anew on next use).
        ALTER TABLE memory_users ADD COLUMN collages_album_id TEXT;
        ALTER TABLE memory_users ADD COLUMN recaps_album_id TEXT;
      `);
    },
  },
  {
    // Skipped themes, trips' days, Sunday's own memory card, and each job's folder kept until its upload has worked.
    name: "7: skipped themes, the days a memory covers, weekly cards, job folders",
    run(db) {
      db.exec(`
        CREATE TABLE themed_memories_v2 (
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
        INSERT INTO themed_memories_v2 (id, user_id, theme, theme_key, memory_id, status, label, person_id, memory_at, show_at, hide_at, made_on, created_at)
          SELECT id, user_id, theme, theme_key, memory_id, status, label, person_id, memory_at, show_at, hide_at, made_on, created_at FROM themed_memories;
        DROP TABLE themed_memories;
        ALTER TABLE themed_memories_v2 RENAME TO themed_memories;
        CREATE INDEX themed_memories_user_made ON themed_memories (user_id, made_on);

        -- Sunday's collage and recap, shown together in a memory of their own (Sunday to Tuesday),
        -- labelled like the memory they were made from.
        CREATE TABLE creation_cards (
          id               INTEGER PRIMARY KEY,
          user_id          TEXT NOT NULL,                  -- Immich user
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE, -- made from
          week             TEXT NOT NULL,                  -- the local day (a Sunday) it was picked
          status           TEXT NOT NULL CHECK (status IN ('waiting', 'created', 'empty', 'late', 'failed')),
          memory_id        TEXT UNIQUE,                    -- Immich memory, once created
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          UNIQUE (user_id, week)
        );
        ALTER TABLE creation_jobs ADD COLUMN card_id INTEGER REFERENCES creation_cards (id) ON DELETE SET NULL;
        ALTER TABLE creation_jobs ADD COLUMN work_id TEXT;      -- its folder in the work folder, kept until it's uploaded
        ALTER TABLE creation_jobs ADD COLUMN rendered_at TEXT;  -- the container finished it: only the upload is left
      `);
    },
  },
  {
    // A card Immich answers with a server error is tried again after 30, then 60 minutes, then given up.
    name: "8: card retries",
    run(db) {
      db.exec(`
        ALTER TABLE creation_cards ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0; -- server errors so far
        ALTER TABLE creation_cards ADD COLUMN next_at TEXT;                         -- not tried again before (UTC)
      `);
    },
  },
  {
    // Animations: a third kind of creation, and the person's "Animations" album.
    name: "9: animations",
    run(db) {
      db.exec(`
        CREATE TABLE creation_jobs_v2 (
          id               INTEGER PRIMARY KEY,
          user_id          TEXT NOT NULL,                  -- Immich user
          themed_memory_id INTEGER NOT NULL REFERENCES themed_memories (id) ON DELETE CASCADE,
          kind             TEXT NOT NULL CHECK (kind IN ('collage', 'recap', 'animation')),
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
        INSERT INTO creation_jobs_v2 (id, user_id, themed_memory_id, kind, inputs, state, rank, attempts, queued_on, next_at, asset_id,
                                      last_error, created_at, updated_at, card_id, work_id, rendered_at)
          SELECT id, user_id, themed_memory_id, kind, inputs, state, rank, attempts, queued_on, next_at, asset_id,
                 last_error, created_at, updated_at, card_id, work_id, rendered_at FROM creation_jobs;
        DROP TABLE creation_jobs;
        ALTER TABLE creation_jobs_v2 RENAME TO creation_jobs;
        CREATE INDEX creation_jobs_state ON creation_jobs (state, next_at);
        CREATE INDEX creation_jobs_user ON creation_jobs (user_id, state);

        ALTER TABLE memory_users ADD COLUMN animations_album_id TEXT;
      `);
    },
  },
  {
    // Cinematic photos: a fourth kind of creation, and the person's "Cinematic" album. An older version refuses the database afterwards: going back means the snapshot taken before the deploy (docs/runbooks.md).
    name: "10: cinematic photos",
    run(db) {
      db.exec(`
        CREATE TABLE creation_jobs_v3 (
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
        INSERT INTO creation_jobs_v3 (id, user_id, themed_memory_id, kind, inputs, state, rank, attempts, queued_on, next_at, asset_id,
                                      last_error, created_at, updated_at, card_id, work_id, rendered_at)
          SELECT id, user_id, themed_memory_id, kind, inputs, state, rank, attempts, queued_on, next_at, asset_id,
                 last_error, created_at, updated_at, card_id, work_id, rendered_at FROM creation_jobs;
        DROP TABLE creation_jobs;
        ALTER TABLE creation_jobs_v3 RENAME TO creation_jobs;
        CREATE INDEX creation_jobs_state ON creation_jobs (state, next_at);
        CREATE INDEX creation_jobs_user ON creation_jobs (user_id, state);

        ALTER TABLE memory_users ADD COLUMN cinematic_album_id TEXT;
      `);
    },
  },
  {
    // A card made by hand (scripts/creations-now.ts) besides the week's own.
    name: "11: extra cards",
    run(db) {
      db.exec(`
        CREATE TABLE creation_cards_v2 (
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
        INSERT INTO creation_cards_v2 (id, user_id, themed_memory_id, week, status, memory_id, created_at, updated_at, attempts, next_at)
          SELECT id, user_id, themed_memory_id, week, status, memory_id, created_at, updated_at, attempts, next_at FROM creation_cards;
        DROP TABLE creation_cards;
        ALTER TABLE creation_cards_v2 RENAME TO creation_cards;
      `);
    },
  },
  {
    // Reduce noise for videos (reduce-noise.service.ts): the record of each video cleaned, and what the apps ask while it's going.
    name: "12: reduce noise for videos",
    run(db) {
      db.exec(`
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
];
