// The service's one SQLite file (<DATA_DIR>/data.db), opened on first use and shared by the repositories.

import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import { BASELINE_VERSION, MIGRATIONS } from "./migrations.ts";
import type { Migration } from "../types/db.types.ts";

let db: DatabaseSync | undefined;

export function database(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(join(config.dataDir, "data.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    migrate(db, MIGRATIONS);
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return db;
}

// Brings the database up to date (migrations.ts): runs each step not yet run, in order. An empty database starts at the baseline.
export function migrate(database: DatabaseSync, migrations: readonly Migration[]): void {
  database.exec("PRAGMA foreign_keys = OFF;");
  const version = () => (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const latest = BASELINE_VERSION - 1 + migrations.length;
  if (version() > latest) {
    throw new Error(`The database is from a newer version of this service (version ${version()}); refusing to use it.`);
  }
  if (version() > 0 && version() < BASELINE_VERSION) {
    throw new Error(`The database is too old to update (version ${version()}, the oldest this service can update is ${BASELINE_VERSION}). Start a fresh database (in dev: ./memento dev reset).`);
  }
  for (let v = Math.max(version(), BASELINE_VERSION - 1); v < latest; v++) {
    const step = migrations[v - (BASELINE_VERSION - 1)]!;
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

// Runs fn so that all its writes happen or none do. Works inside another call too.
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

// Like atomically, but takes the write lock first. Not for use inside another transaction.
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

// A consistent copy of the database for the nightly backup, written to <DATA_DIR>/backup/.
export function snapshotDatabase(): void {
  const dir = join(config.dataDir, "backup");
  const tmp = join(config.dataDir, "snapshot.tmp");
  mkdirSync(dir, { recursive: true });
  rmSync(tmp, { force: true });
  database().prepare("VACUUM INTO ?").run(tmp);
  renameSync(tmp, join(dir, "memento-extras.db"));
  chmodSync(join(dir, "memento-extras.db"), 0o600);
}

export function closeDatabase(): void {
  db?.close();
  db = undefined;
}
