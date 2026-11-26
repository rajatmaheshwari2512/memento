// Night captions (caption-night.ts) run as the timer runs it, against a fake caption model. Run: npm test

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { fakeLlama, listen } from "./helpers.ts";

const run = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-night-"));
const env = { ...process.env, DATA_DIR: dataDir, GEMINI_API_KEY: "unused", MEMENTO_SECRET: "A".repeat(44) };
const OWNER = randomUUID();

type Photo = { id: string; path: string; uploadedAt: string };
const photo = (name: string, uploadedAt: string, write = true): Photo => {
  const path = join(dataDir, `${name}.jpg`);
  if (write) writeFileSync(path, name);
  return { id: randomUUID(), path, uploadedAt };
};
const done = photo("done", "2026-11-01 10:00:00.5+00");
const older = photo("older", "2026-11-10 10:00:00.5+00");
const newer = photo("newer", "2026-11-19 10:00:00.5+00");
const missing = photo("missing", "2026-11-05 10:00:00.5+00", false);
const photos = join(dataDir, "photos.tsv");
writeFileSync(photos, [done, older, newer, missing].map((p) => [p.id, OWNER, "IMAGE", p.path, p.uploadedAt].join("\t")).join("\n") + "\n");

const unreadable = new Set<string>();
let healthy = true;
const seen: string[] = [];
let llama: Server;
let llamaUrl: string;

before(async () => {
  process.env.DATA_DIR = dataDir;
  process.env.GEMINI_API_KEY = "unused";
  process.env.MEMENTO_SECRET = "A".repeat(44);
  const { saveCaption } = await import("../src/services/repositories/captions.repository.ts");
  const { closeDatabase } = await import("../src/db/database.ts");
  saveCaption({ assetId: done.id, ownerId: OWNER, model: "earlier", caption: "Already captioned.", tags: [] });
  closeDatabase();

  llama = fakeLlama({
    modelId: "Qwen3.5-2B-GGUF:Q4_K_M",
    healthy: () => healthy,
    reply: (name) => {
      if (!healthy) return null;
      seen.push(name);
      return { content: unreadable.has(name) ? "SECRET words, not JSON" : JSON.stringify({ caption: `A photo called ${name}.`, tags: ["Home"] }) };
    },
  });
  llamaUrl = `http://127.0.0.1:${await listen(llama)}`;
});

after(() => {
  llama.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const cwd = join(import.meta.dirname, "..");
const night = (...extra: string[]) =>
  run(process.execPath, ["--disable-warning=ExperimentalWarning", "src/scripts/caption-night.ts", "--photos", photos, ...extra], { env, cwd });
const later = () => new Date(Date.now() + 3_600_000).toISOString();
async function tonight(until = later()): Promise<{ stdout: string; summary: Record<string, unknown>; code: number }> {
  seen.length = 0;
  const result = await night("--llama", llamaUrl, "--until", until).then(
    (r) => ({ stdout: r.stdout, code: 0 }),
    (e: { stdout: string; code: number }) => ({ stdout: e.stdout, code: e.code }),
  );
  return { ...result, summary: JSON.parse(result.stdout.trim().split("\n").at(-1)!) };
}
const count = async () => (await night("--count")).stdout.trim();

async function captions(): Promise<Map<string, { caption: string; model: string }>> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
  const rows = db.prepare("SELECT asset_id, caption, model FROM captions").all() as { asset_id: string; caption: string; model: string }[];
  db.close();
  return new Map(rows.map((r) => [r.asset_id, r]));
}

async function setSwitch(enabled: boolean): Promise<void> {
  const { setFlags } = await import("../src/services/flags.service.ts");
  const { parseFlagChanges } = await import("../src/schemas/flags.schema.ts");
  const { closeDatabase } = await import("../src/db/database.ts");
  setFlags(parseFlagChanges({ captions: { enabled } }), "admin");
  closeDatabase();
}

test("counts the photos waiting; 'off' when switched off, and then nothing runs", async () => {
  assert.equal(await count(), "3");
  await setSwitch(false);
  assert.equal(await count(), "off");
  const off = await tonight();
  assert.equal(off.summary.stopped, "switched off");
  assert.deepEqual(seen, []);
  await setSwitch(true);
});

test("morning: nothing starts after --until", async () => {
  const late = await tonight(new Date(Date.now() - 60_000).toISOString());
  assert.equal(late.summary.stopped, "morning");
  assert.deepEqual(seen, []);
});

test("a model that stops answering ends the night, and no photo is blamed for it", async () => {
  healthy = false;
  const down = await tonight();
  healthy = true;
  assert.equal(down.summary.stopped, "the model stopped answering");
  assert.equal(down.code, 1);
  assert.equal(await count(), "3");
});

test("a photo the model can't read is skipped, goes last, and is left alone after 3 nights; captions never reach the log", async () => {
  unreadable.add("newer");
  const first = await tonight();
  assert.deepEqual(seen, ["newer", "older"]);
  assert.deepEqual([first.summary.captioned, first.summary.failed, first.summary.stopped], [1, 2, "all done"]);
  assert.doesNotMatch(first.stdout, /SECRET/);
  assert.match(first.stdout, /"error":"unusable reply"/);
  assert.match(first.stdout, /"error":"ENOENT"/);

  unreadable.clear();
  await tonight();
  assert.deepEqual(seen, ["newer"]);
  const saved = await captions();
  assert.equal(saved.get(newer.id)?.caption, "A photo called newer.");
  assert.equal(saved.get(newer.id)?.model, "Qwen3.5-2B-GGUF:Q4_K_M");
  assert.equal(saved.get(done.id)?.caption, "Already captioned.");

  assert.equal(await count(), "1");
  await tonight();
  assert.equal(await count(), "0");
});

test("clean-up: only photos gone from Immich for good lose their caption; a broken list removes nothing", async () => {
  const existing = join(dataDir, "existing.txt");
  const cleanUp = async (...extra: string[]) => {
    const { stdout } = await night("--clean-up", "--existing", existing, ...extra);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
  };
  const kept = [done, newer, missing].map((p) => p.id);

  writeFileSync(existing, "");
  const empty = await cleanUp();
  assert.deepEqual([empty.removed, empty.skipped], [false, "the photo list is empty"]);
  writeFileSync(existing, kept.join("\n") + "\n");
  const tooMany = await cleanUp("--max-removals", "0");
  assert.deepEqual([tooMany.gone, tooMany.removed], [1, false]);
  assert.ok((await captions()).has(older.id));

  const cleaned = await cleanUp();
  assert.deepEqual([cleaned.gone, cleaned.removed], [1, true]);
  const saved = await captions();
  assert.ok(!saved.has(older.id));
  assert.ok(saved.has(done.id) && saved.has(newer.id));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
  const fts = db.prepare("SELECT count(*) AS n FROM captions_fts WHERE captions_fts MATCH 'older'").get() as { n: number };
  const failure = db.prepare("SELECT nights FROM caption_failures WHERE asset_id = ?").get(missing.id) as { nights: number } | undefined;
  db.close();
  assert.equal(fts.n, 0);
  assert.equal(failure?.nights, 3);
});

test("Memento's own collages and recap videos are never captioned", async () => {
  const collage = photo("collage", "2026-11-20 10:00:00.5+00");
  writeFileSync(photos, [done, newer, collage].map((p) => [p.id, OWNER, "IMAGE", p.path, p.uploadedAt].join("\t")).join("\n") + "\n");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "data.db"));
  const now = new Date().toISOString();
  const memory = db.prepare(
    "INSERT INTO themed_memories (user_id, theme, theme_key, status, made_on, created_at) VALUES (?, 'trip', 'trip:x', 'created', '2026-11-01', ?) RETURNING id",
  ).get(OWNER, now) as { id: number };
  db.prepare(
    "INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at, asset_id) VALUES (?, ?, 'collage', '{}', 'done', 0, ?, ?, ?, ?)",
  ).run(OWNER, memory.id, now, now, now, collage.id);
  db.close();
  assert.equal(await count(), "0");
  await tonight();
  assert.ok(!seen.includes("collage") && !(await captions()).has(collage.id));
});
