// The database's versions (migrations.ts, database.ts): a fresh database gets the baseline; older or newer ones are refused.

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
process.env.MEMENTO_SECRET ??= "A".repeat(44);
const { BASELINE_VERSION, MIGRATIONS } = await import("../src/db/migrations.ts");
const { migrate } = await import("../src/db/database.ts");

const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as any).user_version;
const schema = (db: DatabaseSync) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all().map((r) => ({ ...r }));

test("a fresh database is migrated to version 13", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS);
  assert.equal(BASELINE_VERSION, 12);
  assert.equal(version(db), 13);
  assert.ok(schema(db).some((o) => o.name === "captions_fts"));
  assert.ok(schema(db).some((o) => o.name === "backup_settings"));
});

test("a database already at version 13 is left exactly as it is", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS);
  db.exec("INSERT INTO flags VALUES ('a.b', 'true', 't', 'admin')");
  const before = schema(db);
  migrate(db, MIGRATIONS);
  assert.equal(version(db), 13);
  assert.deepEqual(schema(db), before);
  assert.equal((db.prepare("SELECT count(*) AS n FROM flags").get() as any).n, 1);
});

test("13: a version-12 database with data is updated, and every row stays", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS.slice(0, 1));
  assert.equal(version(db), 12);
  db.exec(`
    INSERT INTO flags VALUES ('gemini.enabled', 'false', 't', 'admin');
    INSERT INTO user_keys VALUES ('u1', 'k1', 'sealed', 't');
    INSERT INTO edits (id, user_id, asset_id, day, created_at, model, status, prompt_chars) VALUES ('e1', 'u1', 'a1', '2026-11-01', 't', 'm', 'done', 10);
    INSERT INTO live_albums (id, user_id, album_id, album_name, match, created_at, updated_at) VALUES ('l1', 'u1', 'al1', 'Family', 'all', 't', 't');
    INSERT INTO live_album_people VALUES ('l1', 'p1', 'include');
    INSERT INTO memory_users (user_id, created_at, updated_at) VALUES ('u1', 't', 't');
  `);
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
  const tables = ["flags", "user_keys", "edits", "live_albums", "live_album_people", "memory_users"];
  const before = Object.fromEntries(tables.map((t) => [t, rows(t)]));
  migrate(db, MIGRATIONS);
  assert.equal(version(db), 13);
  assert.deepEqual(Object.fromEntries(tables.map((t) => [t, rows(t)])), before);
  db.exec("INSERT INTO backup_settings VALUES ('u1', 'saver', 't')");
  assert.throws(() => db.exec("INSERT INTO backup_settings VALUES ('u2', 'low', 't')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO backup_settings VALUES ('u1', 'original', 't')"), /UNIQUE|PRIMARY/);
});

test("a database at versions 1 to 11 is refused, and left alone", () => {
  for (let v = 1; v <= 11; v++) {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE edits (id TEXT); PRAGMA user_version = ${v}`);
    assert.throws(() => migrate(db, MIGRATIONS), /too old.*fresh database/s, `version ${v}`);
    assert.equal(version(db), v);
    assert.deepEqual(schema(db).map((o) => o.name), ["edits"]);
  }
});

test("a database from a newer version is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 99");
  assert.throws(() => migrate(db, MIGRATIONS), /newer version/);
  assert.equal(version(db), 99);
});

test("steps after the baseline are numbered from 13 and applied in order, once", () => {
  assert.equal(MIGRATIONS[1]!.name, "13: backup quality");
  const steps = [
    ...MIGRATIONS,
    { name: "14: a", run: (d: DatabaseSync) => d.exec("CREATE TABLE a (x)") },
    { name: "15: b", run: (d: DatabaseSync) => d.exec("CREATE TABLE b (x)") },
  ];
  const old = new DatabaseSync(":memory:");
  migrate(old, MIGRATIONS);
  migrate(old, steps);
  assert.equal(version(old), 15);
  migrate(old, steps);
  assert.equal(version(old), 15);
  const fresh = new DatabaseSync(":memory:");
  migrate(fresh, steps);
  assert.equal(version(fresh), 15);
  assert.deepEqual(schema(fresh), schema(old));
});

test("a failed step changes nothing", () => {
  const fresh = new DatabaseSync(":memory:");
  assert.throws(() => migrate(fresh, [{ name: "bad", run: (d) => d.exec("CREATE TABLE t (x); INSERT INTO nowhere VALUES (1);") }]), /bad/);
  assert.equal(version(fresh), 0);
  assert.equal((fresh.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").get() as any).n, 0);
});

test("the rules are enforced: allowed values only, no links to nothing, deleting a live album deletes its people and photos", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("INSERT INTO live_albums (id, user_id, album_id, album_name, match, created_at, updated_at) VALUES ('l1', 'u1', 'a1', 'Family', 'all', 't', 't')");
  db.exec("INSERT INTO live_album_people VALUES ('l1', 'p1', 'include')");
  db.exec("INSERT INTO live_album_seen VALUES ('l1', 'x1', 'added', NULL, 't')");
  assert.throws(() => db.exec("UPDATE live_albums SET match = 'some'"), /CHECK/);
  assert.throws(() => db.exec("UPDATE live_albums SET since = 'last year'"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO live_album_people VALUES ('l1', 'p2', 'maybe')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO live_album_people VALUES ('l1', 'p1', 'exclude')"), /UNIQUE|PRIMARY/);
  assert.throws(() => db.exec("INSERT INTO live_album_people VALUES ('nope', 'p2', 'include')"), /FOREIGN KEY/);
  db.exec("DELETE FROM live_albums WHERE id = 'l1'");
  assert.equal((db.prepare("SELECT count(*) AS n FROM live_album_people").get() as any).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM live_album_seen").get() as any).n, 0);
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
