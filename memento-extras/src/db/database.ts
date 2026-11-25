// The service's one SQLite file (<DATA_DIR>/data.db), opened on first use and shared by the
// repositories (services/repositories/): limits, feature flags, live albums and captions.
// Its tables are all defined in migrations.ts.

import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { Migration } from "../types/db.types.ts";

let db: DatabaseSync | undefined;

export function database(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(join(config.dataDir, "data.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    // Wait up to 5 s instead of failing when another process is writing, e.g. a caption
    // import (import-captions.ts) run alongside the service.
    db.exec("PRAGMA busy_timeout = 5000;");
    migrate(db, MIGRATIONS);
    // SQLite ignores foreign keys unless asked, on every connection.
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return db;
}

// Brings the database up to date (migrations.ts): runs each step not yet run, in order,
// each in its own transaction. Foreign keys are off while it runs, because rebuilding a
// table briefly breaks the links; they're checked before each step is committed.
export function migrate(database: DatabaseSync, migrations: readonly Migration[]): void {
  database.exec("PRAGMA foreign_keys = OFF;");
  const version = () => (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version() > migrations.length) {
    throw new Error(`The database is from a newer version of this service (version ${version()}); refusing to use it.`);
  }
  for (let v = version(); v < migrations.length; v++) {
    const step = migrations[v]!;
    database.exec("BEGIN IMMEDIATE");
    try {
      step.run(database);
      const broken = database.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(`broken links: ${JSON.stringify(broken.slice(0, 5))}`);
      database.exec(`PRAGMA user_version = ${v + 1}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Database update "${step.name}" failed: ${(error as Error).message}`);
    }
  }
}

// Runs fn so that all its writes happen or none do. Works inside another call too (it uses
// a SAVEPOINT, which nests), e.g. one caption saved inside a whole import.
export function atomically<T>(fn: () => T): T {
  const d = database();
  d.exec("SAVEPOINT atomically");
  try {
    const result = fn();
    d.exec("RELEASE atomically");
    return result;
  } catch (error) {
    d.exec("ROLLBACK TO atomically");
    d.exec("RELEASE atomically");
    throw error;
  }
}

// Like atomically, but takes the write lock first (BEGIN IMMEDIATE), so a check followed by
// a write ("is there room under the limit? then reserve") can't be raced by another process.
// Not for use inside another transaction.
export function immediately<T>(fn: () => T): T {
  const d = database();
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (error) {
    d.exec("ROLLBACK");
    throw error;
  }
}

// A consistent copy of the database for the nightly Deep Archive backup, which uploads
// <DATA_DIR>/backup/ (host/group_vars/all/main.yml, backup_jobs). VACUUM INTO writes a
// complete, compact file while the service keeps running. It's written next to the
// folder and then renamed into it, so the backup never sees half a file.
export function snapshotDatabase(): void {
  const dir = join(config.dataDir, "backup");
  const tmp = join(config.dataDir, "snapshot.tmp");
  mkdirSync(dir, { recursive: true });
  rmSync(tmp, { force: true });
  database().prepare("VACUUM INTO ?").run(tmp);
  renameSync(tmp, join(dir, "memento-extras.db"));
  chmodSync(join(dir, "memento-extras.db"), 0o600); // like everything else in the data folder
}

export function closeDatabase(): void {
  db?.close();
  db = undefined;
}
