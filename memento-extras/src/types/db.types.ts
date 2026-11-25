// The database's numbered steps (db/migrations.ts).

import type { DatabaseSync } from "node:sqlite";

export type Migration = { name: string; run: (db: DatabaseSync) => void };
