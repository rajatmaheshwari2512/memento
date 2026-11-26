// The database's versions (migrations.ts, database.ts): an old database is brought up to date with its data intact.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { freePort, Service } from "./helpers.ts";

const dataDir = mkdtempSync(join(tmpdir(), "memento-db-"));
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "test";
const { MIGRATIONS } = await import("../src/db/migrations.ts");

const LIVE = "aaaaaaaa-0000-4000-8000-000000000001";
const P = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
const A = (n: number) => `cccccccc-0000-4000-8000-00000000000${n}`;

{
  const old = new DatabaseSync(join(dataDir, "data.db"));
  MIGRATIONS[0]!.run(old);
  old.exec(`
    INSERT INTO edits VALUES ('e1', 'u1', '${A(1)}', '2026-11-18', '2026-11', '2026-11-18T10:00:00Z', 'm', 'done', 10, 0.05, 900);
    INSERT INTO edits VALUES ('e2', 'u1', '${A(2)}', '2026-11-19', '2026-11', '2026-11-19T10:00:00Z', 'm', 'failed', 12, 0, 300);
    INSERT INTO flags VALUES ('liveAlbums.enabled', 'false', '2026-11-19T00:00:00Z', 'admin');
    INSERT INTO live_albums VALUES ('${LIVE}', 'u1', 'album-1', 'Family', '["${P(1)}","${P(2)}"]', 'all', '["${P(3)}"]',
      '2024-01-01', '2026-11-19T09:00:00Z', '2026-11-19T09:00:00Z', '2026-11-19T11:00:00Z', 1, 3, NULL);
    INSERT INTO live_album_seen VALUES ('${LIVE}', '${A(1)}', 'added'), ('${LIVE}', '${A(2)}', 'added'),
      ('${LIVE}', '${A(3)}', 'added'), ('${LIVE}', '${A(4)}', 'duplicate'), ('${LIVE}', '${A(5)}', 'no_permission');
    INSERT INTO user_keys VALUES ('u1', 'key-1', 'sealed', '2026-11-19T09:00:00Z');
  `);
  old.close();
}

const { database, closeDatabase, migrate } = await import("../src/db/database.ts");
const db = database();
const all = (sql: string, ...args: string[]) => db.prepare(sql).all(...args) as any[];

test("brings an old database up to the latest version", () => {
  assert.equal((db.prepare("PRAGMA user_version").get() as any).user_version, MIGRATIONS.length);
});

test("keeps the edit log, without the month column", () => {
  assert.deepEqual(all("SELECT id, day, status, cost_usd FROM edits ORDER BY id").map((r) => ({ ...r })), [
    { id: "e1", day: "2026-11-18", status: "done", cost_usd: 0.05 },
    { id: "e2", day: "2026-11-19", status: "failed", cost_usd: 0 },
  ]);
  assert.ok(!all("PRAGMA table_info(edits)").some((c) => c.name === "month"));
});

test("moves a live album's people into their own table, in order", () => {
  assert.deepEqual(all("SELECT person_id, role FROM live_album_people ORDER BY rowid").map((r) => ({ ...r })), [
    { person_id: P(1), role: "include" },
    { person_id: P(2), role: "include" },
    { person_id: P(3), role: "exclude" },
  ]);
  const row = { ...all("SELECT * FROM live_albums")[0] };
  assert.equal(row.match, "all");
  assert.equal(row.since, "2024-01-01");
  assert.ok(!("include_ids" in row) && !("total_added" in row));
});

test("keeps every photo considered, splitting Immich's errors out", () => {
  assert.deepEqual(all("SELECT asset_id, outcome, error, seen_at FROM live_album_seen ORDER BY asset_id").map((r) => ({ ...r })), [
    { asset_id: A(1), outcome: "added", error: null, seen_at: "2026-11-19T11:00:00Z" },
    { asset_id: A(2), outcome: "added", error: null, seen_at: "2026-11-19T11:00:00Z" },
    { asset_id: A(3), outcome: "added", error: null, seen_at: "2026-11-19T11:00:00Z" },
    { asset_id: A(4), outcome: "duplicate", error: null, seen_at: "2026-11-19T11:00:00Z" },
    { asset_id: A(5), outcome: "refused", error: "no_permission", seen_at: "2026-11-19T11:00:00Z" },
  ]);
});

test("keeps flags and keys as they were", () => {
  assert.equal(all("SELECT value FROM flags")[0].value, "false");
  assert.equal(all("SELECT key_id FROM user_keys")[0].key_id, "key-1");
});

test("refuses values outside the allowed ones", () => {
  assert.throws(() => db.prepare("UPDATE edits SET status = 'maybe' WHERE id = 'e1'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE live_albums SET match = 'some'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE live_albums SET since = 'last year'").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO live_album_people VALUES (?, ?, 'maybe')").run(LIVE, P(4)), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO live_album_people VALUES (?, ?, 'exclude')").run(LIVE, P(1)), /UNIQUE|PRIMARY/);
});

test("links are enforced: nothing can point at a live album that doesn't exist", () => {
  assert.throws(() => db.prepare("INSERT INTO live_album_people VALUES ('nope', ?, 'include')").run(P(4)), /FOREIGN KEY/);
});

test("deleting a live album deletes its people and seen photos with it", () => {
  db.prepare("DELETE FROM live_albums WHERE id = ?").run(LIVE);
  assert.equal(all("SELECT count(*) AS n FROM live_album_people")[0].n, 0);
  assert.equal(all("SELECT count(*) AS n FROM live_album_seen")[0].n, 0);
});

test("animations (step 9): the creations queue is rebuilt with every job as it was, and takes the new kind", () => {
  const live = new DatabaseSync(":memory:");
  migrate(live, MIGRATIONS.slice(0, 8));
  live.exec(`
    INSERT INTO memory_users (user_id, creations, created_at, updated_at, collages_album_id, recaps_album_id) VALUES ('u1', 1, 't', 't', 'album-c', 'album-r');
    INSERT INTO themed_memories (id, user_id, theme, theme_key, memory_id, status, label, made_on, created_at) VALUES
      (1, 'u1', 'trip', 'trip:2026-10-20', 'm1', 'created', 'Goa trip', '2026-11-01', 't'),
      (2, 'u1', 'big_day', 'day:2026-11-07', 'm2', 'created', 'A day', '2026-11-08', 't');
    INSERT INTO creation_cards (id, user_id, themed_memory_id, week, status, created_at, updated_at) VALUES (7, 'u1', 1, '2026-11-01', 'created', 't', 't');
    INSERT INTO creation_jobs (id, user_id, themed_memory_id, kind, inputs, state, rank, attempts, queued_on, next_at, asset_id, last_error,
                               created_at, updated_at, card_id, work_id, rendered_at) VALUES
      (1, 'u1', 1, 'collage', '{"a":1}', 'done', 3.5, 1, '2026-11-01', 'n', 'asset-1', NULL, 'c', 'u', 7, NULL, 'r'),
      (2, 'u1', 1, 'recap', '{"b":2}', 'running', 3.5, 2, '2026-11-01', 'n', NULL, 'oom', 'c', 'u', 7, 'work-2', NULL),
      (3, 'u1', 2, 'collage', '{}', 'proposed', 2, 0, NULL, 'n', NULL, NULL, 'c', 'u', NULL, NULL, NULL),
      (4, 'u1', 2, 'recap', '{}', 'skipped', 2, 0, NULL, 'n', NULL, NULL, 'c', 'u', NULL, NULL, NULL);
  `);
  const jobs = () => live.prepare("SELECT * FROM creation_jobs ORDER BY id").all().map((r) => ({ ...r }));
  const before = jobs();
  migrate(live, MIGRATIONS);
  assert.deepEqual(jobs(), before);
  live.exec("INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at) VALUES ('u1', 1, 'animation', '{}', 'queued', 3.5, 'n', 'c', 'u')");
  assert.throws(() => live.exec("INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at) VALUES ('u1', 2, 'gif', '{}', 'queued', 1, 'n', 'c', 'u')"), /CHECK/);
  assert.throws(() => live.exec("INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at) VALUES ('u1', 1, 'animation', '{}', 'queued', 1, 'n', 'c', 'u')"), /UNIQUE/);
  const indexes = live.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'creation_jobs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(indexes, ["creation_jobs_state", "creation_jobs_user"]);
  assert.deepEqual({ ...live.prepare("SELECT collages_album_id, recaps_album_id, animations_album_id FROM memory_users").get() }, { collages_album_id: "album-c", recaps_album_id: "album-r", animations_album_id: null });
  live.exec("PRAGMA foreign_keys = ON; DELETE FROM creation_cards WHERE id = 7");
  assert.deepEqual(live.prepare("SELECT card_id FROM creation_jobs WHERE id IN (1, 2)").all().map((r) => r.card_id), [null, null], "still linked to its card");
  live.exec("DELETE FROM themed_memories WHERE id = 2");
  assert.deepEqual(live.prepare("SELECT id FROM creation_jobs ORDER BY id").all().map((r) => r.id), [1, 2, 5], "and to its memory");
});

test("extra cards (step 11): the cards are rebuilt as they were; a second card in a week only if made by hand", () => {
  const live = new DatabaseSync(":memory:");
  migrate(live, MIGRATIONS.slice(0, 10));
  live.exec(`
    INSERT INTO memory_users (user_id, creations, created_at, updated_at) VALUES ('u1', 1, 't', 't');
    INSERT INTO themed_memories (id, user_id, theme, theme_key, memory_id, status, label, made_on, created_at) VALUES
      (1, 'u1', 'trip', 'trip:2026-10-20', 'm1', 'created', 'Goa trip', '2026-11-22', 't');
    INSERT INTO creation_cards (id, user_id, themed_memory_id, week, status, memory_id, created_at, updated_at, attempts, next_at)
      VALUES (7, 'u1', 1, '2026-11-22', 'created', 'mem-7', 'c', 'u', 1, 'n');
    INSERT INTO creation_jobs (id, user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at, card_id)
      VALUES (1, 'u1', 1, 'collage', '{}', 'done', 3.5, 'n', 'c', 'u', 7);
  `);
  const cards = () => live.prepare("SELECT * FROM creation_cards ORDER BY id").all().map((r) => ({ ...r }));
  const before = cards();
  migrate(live, MIGRATIONS);
  assert.deepEqual(cards(), before.map((c) => ({ ...c, extra: 0 })));
  const insert = (extra: number) => live.exec(`INSERT INTO creation_cards (user_id, themed_memory_id, week, status, extra, created_at, updated_at) VALUES ('u1', 1, '2026-11-22', 'waiting', ${extra}, 'c', 'u')`);
  assert.throws(() => insert(0), /UNIQUE/, "one card of the week's own");
  insert(1);
  assert.throws(() => insert(1), /UNIQUE/, "and one made by hand");
  live.exec("PRAGMA foreign_keys = ON; DELETE FROM creation_cards WHERE id = 7");
  assert.equal((live.prepare("SELECT card_id FROM creation_jobs WHERE id = 1").get() as any).card_id, null, "still linked to its card");
});

test("cinematic photos (step 10): the creations queue is rebuilt with every job as it was, and takes the new kind", () => {
  const live = new DatabaseSync(":memory:");
  migrate(live, MIGRATIONS.slice(0, 9));
  live.exec(`
    INSERT INTO memory_users (user_id, creations, created_at, updated_at, collages_album_id, recaps_album_id, animations_album_id)
      VALUES ('u1', 1, 't', 't', 'album-c', 'album-r', 'album-a');
    INSERT INTO themed_memories (id, user_id, theme, theme_key, memory_id, status, label, made_on, created_at) VALUES
      (1, 'u1', 'trip', 'trip:2026-10-20', 'm1', 'created', 'Goa trip', '2026-11-01', 't'),
      (2, 'u1', 'big_day', 'day:2026-11-07', 'm2', 'created', 'A day', '2026-11-08', 't');
    INSERT INTO creation_cards (id, user_id, themed_memory_id, week, status, created_at, updated_at) VALUES (7, 'u1', 1, '2026-11-01', 'created', 't', 't');
    INSERT INTO creation_jobs (id, user_id, themed_memory_id, kind, inputs, state, rank, attempts, queued_on, next_at, asset_id, last_error,
                               created_at, updated_at, card_id, work_id, rendered_at) VALUES
      (1, 'u1', 1, 'collage', '{"a":1}', 'done', 3.5, 1, '2026-11-01', 'n', 'asset-1', NULL, 'c', 'u', 7, NULL, 'r'),
      (2, 'u1', 1, 'animation', '{"b":2}', 'running', 3.5, 2, '2026-11-01', 'n', NULL, 'oom', 'c', 'u', 7, 'work-2', NULL),
      (3, 'u1', 2, 'recap', '{}', 'proposed', 2, 0, NULL, 'n', NULL, NULL, 'c', 'u', NULL, NULL, NULL);
  `);
  const jobs = () => live.prepare("SELECT * FROM creation_jobs ORDER BY id").all().map((r) => ({ ...r }));
  const before = jobs();
  migrate(live, MIGRATIONS);
  assert.deepEqual(jobs(), before);
  live.exec("INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at) VALUES ('u1', 1, 'cinematic', '{}', 'queued', 3.5, 'n', 'c', 'u')");
  assert.throws(() => live.exec("INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at) VALUES ('u1', 2, 'gif', '{}', 'queued', 1, 'n', 'c', 'u')"), /CHECK/);
  assert.throws(() => live.exec("INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at) VALUES ('u1', 1, 'cinematic', '{}', 'queued', 1, 'n', 'c', 'u')"), /UNIQUE/);
  const indexes = live.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'creation_jobs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(indexes, ["creation_jobs_state", "creation_jobs_user"]);
  assert.deepEqual({ ...live.prepare("SELECT animations_album_id, cinematic_album_id FROM memory_users").get() }, { animations_album_id: "album-a", cinematic_album_id: null });
  live.exec("PRAGMA foreign_keys = ON; DELETE FROM creation_cards WHERE id = 7");
  assert.deepEqual(live.prepare("SELECT card_id FROM creation_jobs WHERE id IN (1, 2)").all().map((r) => r.card_id), [null, null], "still linked to its card");
  live.exec("DELETE FROM themed_memories WHERE id = 2");
  assert.deepEqual(live.prepare("SELECT id FROM creation_jobs ORDER BY id").all().map((r) => r.id), [1, 2, 4], "and to its memory");
});

test("a database from a newer version is refused, and a failed step changes nothing", () => {
  const other = new DatabaseSync(":memory:");
  other.exec("PRAGMA user_version = 99");
  assert.throws(() => migrate(other, MIGRATIONS), /newer version/);
  const fresh = new DatabaseSync(":memory:");
  assert.throws(() => migrate(fresh, [{ name: "bad", run: (d) => d.exec("CREATE TABLE t (x); INSERT INTO nowhere VALUES (1);") }]), /bad/);
  assert.equal((fresh.prepare("PRAGMA user_version").get() as any).user_version, 0);
  assert.equal(fresh.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").get()!.n, 0);
  closeDatabase();
});

test("the service starts on a brand-new data folder (it makes the folder and the database)", async () => {
  const fresh = join(dataDir, "new", "data");
  const service = new Service(await freePort(), { DATA_DIR: fresh, IMMICH_URL: "http://127.0.0.1:9", GEMINI_API_KEY: "test" });
  await service.start();
  try {
    assert.equal((await fetch(`${service.base}/health`)).status, 200);
    assert.ok(existsSync(join(fresh, "data.db")));
  } finally {
    await service.stop();
  }
});
