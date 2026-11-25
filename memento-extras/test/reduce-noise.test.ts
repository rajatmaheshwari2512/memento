// Reduce noise for videos: the API, the checks before a job, the line (one at a time, a few
// waiting), the copy saved and stacked like an edited photo, and that it's not a creation. Runs
// the real service against a fake Immich and a fake creations container (the real container's
// cleaning is checked by creations/check-reduce-noise.sh). Run: npm test

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, test } from "node:test";
import { call as callService, freePort, json, listen, Service } from "./helpers.ts";

const OWNER = { id: "11111111-1111-4111-8111-111111111111", name: "Owner", isAdmin: true };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "Other", isAdmin: false };
const OWNER_COOKIE = "immich_access_token=ownertoken0123456789";
const OTHER_COOKIE = "immich_access_token=othertoken0123456789";
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

// The fake library: the owner's videos (and a photo), as Immich v3 describes them.
const VIDEO = id(1);
const QUEUE = [id(11), id(12), id(13), id(14), id(15)];
const SILENT = id(20);
const STACKED = id(21);
const ASSETS: Record<string, Record<string, unknown>> = {
  [VIDEO]: { originalFileName: "Trip to the hills.MOV" },
  ...Object.fromEntries(QUEUE.map((a, i) => [a, { originalFileName: `clip ${i}.mp4` }])),
  [SILENT]: { originalFileName: "quiet.mp4" },
  [STACKED]: { originalFileName: "walk.webm", stack: { primaryAssetId: id(22) } },
  [id(30)]: { type: "IMAGE", originalFileName: "beach.jpg", duration: null },
  [id(31)]: { isTrashed: true },
  [id(32)]: { visibility: "locked" },
  [id(33)]: { visibility: "hidden" }, // a live photo's video half
  [id(34)]: { ownerId: OTHER.id },
  [id(35)]: { duration: 600_001 },
  [id(36)]: { exifInfo: { fileSizeInByte: 2 * 1024 ** 3 + 1 } },
  [id(37)]: { originalFileName: "old camera.avi" },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [id(40 + i), { originalFileName: `more ${i}.mp4` }])),
};
const MORE = Array.from({ length: 12 }, (_, i) => id(40 + i));
const asset = (assetId: string) => ({
  id: assetId, type: "VIDEO", ownerId: OWNER.id, isTrashed: false, originalFileName: "video.mp4", fileCreatedAt: "2024-05-01T10:00:00.000Z",
  localDateTime: "2024-05-01T15:30:00.000Z", visibility: "timeline", stack: null, duration: 83_000,
  exifInfo: { dateTimeOriginal: "2024-05-01T10:00:00+00:00", latitude: 30.1, longitude: 78.2, fileSizeInByte: 52_000_000 },
  ...ASSETS[assetId],
});

const immichCalls: string[] = [];
const uploads: Array<{ id: string; filename: string; type: string; bytes: Buffer; status: string }> = [];
// Every copy uploaded, kept across tests as Immich keeps them: the same bytes again are a
// "duplicate" of the first (even in the trash), as Immich answers.
const copies = new Map<string, { checksum: string; trashed: boolean }>();
let uploadFailures = 0; // the next uploads Immich refuses (500)
let refuseRestore = false; // Immich refuses to restore from the trash
let assetDelayMs = 0; // Immich slow to describe a video (requests at the same moment)
const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
const stacks: string[][] = [];

// The fake creations container: one render at a time (429 otherwise), the copy written as
// "CLEANED " + the original's bytes. `hold` keeps a render running until released; `unsuitable`
// answers so for these videos; `busy` makes it say it's busy (a creation rendering).
const renders: Array<{ id: string; kind: string; video: string; format: string; original: string }> = [];
const states = new Map<string, Record<string, unknown>>();
let rendering = 0;
let mostAtOnce = 0;
let busy = false;
let hold: Promise<void> | null = null;
let release = () => {};
const unsuitable = new Map<string, string>(); // video → the container's reason

let immich: Server;
let creations: Server;
let service: Service;
let env: Record<string, string>;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-noise-"));
const workDir = mkdtempSync(join(tmpdir(), "memento-extras-noise-work-"));

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

before(async () => {
  immich = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    immichCalls.push(`${req.method} ${path}`);
    const who = req.headers.cookie === OWNER_COOKIE ? OWNER : req.headers.cookie === OTHER_COOKIE ? OTHER : null;
    if (!who) return json(res, 401, {});
    if (path === "/api/users/me") return json(res, 200, who);
    const original = /^\/api\/assets\/([0-9a-f-]{36})\/original$/.exec(path);
    if (req.method === "GET" && original && ASSETS[original[1]!]) {
      return res.writeHead(200, { "content-type": "application/octet-stream" }).end(`ORIGINAL ${original[1]}`);
    }
    const one = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === "GET" && one && ASSETS[one[1]!]) {
      if (assetDelayMs) await new Promise((resolve) => setTimeout(resolve, assetDelayMs));
      return json(res, 200, asset(one[1]!));
    }
    if (req.method === "GET" && one && copies.has(one[1]!)) {
      return json(res, 200, { ...asset(one[1]!), originalFileName: "copy.mp4", isTrashed: copies.get(one[1]!)!.trashed });
    }
    if (req.method === "POST" && path === "/api/assets") {
      if (uploadFailures > 0) {
        uploadFailures--;
        return json(res, 500, { message: "storage full" });
      }
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(await readAll(req)) }).formData();
      const file = form.get("assetData") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const checksum = createHash("sha1").update(bytes).digest("hex");
      const known = [...copies].find(([, c]) => c.checksum === checksum)?.[0];
      const copy = known ?? randomUUID();
      if (!known) copies.set(copy, { checksum, trashed: false });
      uploads.push({ id: copy, filename: file.name, type: file.type, bytes, status: known ? "duplicate" : "created" });
      return json(res, known ? 200 : 201, { id: copy, status: known ? "duplicate" : "created" });
    }
    if (req.method === "POST" && path === "/api/trash/restore/assets") {
      if (refuseRestore) return json(res, 500, { message: "no" });
      const { ids } = JSON.parse((await readAll(req)).toString()) as { ids: string[] };
      for (const copy of ids) if (copies.has(copy)) copies.get(copy)!.trashed = false;
      return json(res, 200, { count: ids.length });
    }
    if (req.method === "PUT" && one) {
      updates.push({ id: one[1]!, body: JSON.parse((await readAll(req)).toString()) });
      return json(res, 200, {});
    }
    if (req.method === "POST" && path === "/api/stacks") {
      stacks.push((JSON.parse((await readAll(req)).toString()) as { assetIds: string[] }).assetIds);
      return json(res, 201, {});
    }
    json(res, 404, {});
  });

  creations = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, busy: busy || rendering > 0 });
    if (req.method === "POST" && req.url === "/render") {
      const job = JSON.parse((await readAll(req)).toString()) as { id: string; kind: string; video: string; format: string };
      if (busy || rendering > 0) return json(res, 429, { error: "busy" });
      rendering++;
      mostAtOnce = Math.max(mostAtOnce, rendering);
      const dir = join(workDir, job.id);
      const original = readFileSync(join(dir, job.video)).toString();
      renders.push({ ...job, original });
      states.set(job.id, { state: "running" });
      json(res, 202, { state: "running" });
      try {
        await hold;
        const reason = unsuitable.get(original.slice("ORIGINAL ".length));
        if (reason !== undefined) {
          states.set(job.id, { state: "unsuitable", error: reason });
        } else {
          writeFileSync(join(dir, "reduce-noise.video"), `CLEANED ${original}`);
          states.set(job.id, { state: "done", file: "reduce-noise.video", bytes: 10, ms: 5 });
        }
      } catch {
        states.set(job.id, { state: "failed", error: "its folder went" }); // the service restarted and cleared it
      } finally {
        rendering--;
      }
      return;
    }
    const state = /^\/renders\/([0-9a-f-]{36})$/.exec(req.url ?? "");
    if (req.method === "GET" && state) return states.has(state[1]!) ? json(res, 200, states.get(state[1]!)) : json(res, 404, { error: "unknown job" });
    json(res, 404, {});
  });

  env = {
    IMMICH_URL: `http://127.0.0.1:${await listen(immich)}`,
    CREATIONS_URL: `http://127.0.0.1:${await listen(creations)}`,
    CREATIONS_WORK_DIR: workDir,
    GEMINI_API_KEY: "test-key-not-real",
    DATA_DIR: dataDir,
    RENDER_QUIET_HOURS: "", // none, except in the test of them
    CREATIONS_CHECK_SECONDS: "0",
    MEMORIES_CHECK_SECONDS: "0",
  };
  service = new Service(await freePort(), env);
  await service.start();
});

after(async () => {
  release();
  await service.stop();
  immich.close();
  creations.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const list of [immichCalls, uploads, updates, stacks, renders]) list.length = 0;
  mostAtOnce = 0;
  busy = false;
  hold = null;
  unsuitable.clear();
  uploadFailures = 0;
  refuseRestore = false;
  assetDelayMs = 0;
});

const call = (method: string, path: string, cookie: string | null = OWNER_COOKIE, base = service.base) =>
  callService(base, method, path, { ...(cookie ? { cookie } : {}), ...(method === "POST" ? { json: {} } : {}) });
const start = (assetId: string, cookie: string | null = OWNER_COOKIE, base = service.base) => call("POST", `/videos/${assetId}/reduce-noise`, cookie, base);
const status = (jobId: string, cookie = OWNER_COOKIE) => call("GET", `/videos/jobs/${jobId}`, cookie);

// Asks how the job is going until it's done or failed, as the apps do.
async function finished(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const { body } = await status(jobId);
    if (body.state === "done" || body.state === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the job didn't finish");
}

function holdRenders(): void {
  hold = new Promise((resolve) => {
    release = () => resolve();
  });
}

function database(): DatabaseSync {
  return new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
}

test("cleans a video: its original to the container, the copy uploaded as the same kind of file named after it, dated, placed and stacked on top", async () => {
  const started = await start(VIDEO);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.state, "queued");
  const done = await finished(started.body.jobId);
  assert.equal(done.state, "done", JSON.stringify(done));
  assert.deepEqual(renders.map(({ kind, video, format, original }) => ({ kind, video, format, original })), [
    { kind: "reduce-noise", video: "video.mov", format: "mov", original: `ORIGINAL ${VIDEO}` },
  ]);
  assert.equal(uploads.length, 1);
  assert.equal(done.assetId, uploads[0]!.id);
  assert.equal(uploads[0]!.filename, "Trip to the hills-reduce-noise.MOV", "the original's name and extension");
  assert.equal(uploads[0]!.type, "video/quicktime");
  assert.equal(uploads[0]!.bytes.toString(), `CLEANED ORIGINAL ${VIDEO}`, "what the container made");
  assert.deepEqual(updates, [{ id: uploads[0]!.id, body: { dateTimeOriginal: "2024-05-01T15:30:00.000+05:30", latitude: 30.1, longitude: 78.2 } }]);
  assert.deepEqual(stacks, [[uploads[0]!.id, VIDEO]]);
  assert.ok(immichCalls.includes(`GET /api/assets/${VIDEO}/original`), "the original, never the playback copy");
  // The job's folder is gone, and the copy was uploaded from it, never copied anywhere else.
  assert.deepEqual(readdirSync(workDir), []);
  assert.ok(!existsSync(join(dataDir, "outgoing")));
});

test("not a creation: no tag, album or memory, and only its own record", async () => {
  const done = await finished((await start(QUEUE[0]!)).body.jobId);
  assert.equal(done.state, "done");
  assert.deepEqual(immichCalls.filter((c) => /\/api\/(tags|albums|memories)/.test(c)), []);
  const db = database();
  try {
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM creation_jobs").get() as { n: number }).n, 0);
    const row = db.prepare("SELECT user_id, asset_id, state, copy_id, video_ms, video_bytes FROM noise_jobs WHERE id = ?").get(done.jobId as string);
    assert.deepEqual({ ...row }, { user_id: OWNER.id, asset_id: QUEUE[0], state: "done", copy_id: done.assetId, video_ms: 83_000, video_bytes: 52_000_000 });
  } finally {
    db.close();
  }
});

test("a video already stacked goes on top of its stack; a WebM stays a WebM", async () => {
  const done = await finished((await start(STACKED)).body.jobId);
  assert.equal(done.state, "done");
  assert.equal(uploads[0]!.filename, "walk-reduce-noise.webm");
  assert.equal(uploads[0]!.type, "video/webm");
  assert.equal(renders[0]!.format, "webm");
  assert.deepEqual(stacks, [[uploads[0]!.id, id(22)]]);
});

test("refused before anything starts: no login, others' videos, photos, the trash, the locked folder, a live photo's video, too long, too big, other kinds of file", async () => {
  assert.equal((await start(VIDEO, null)).status, 401);
  assert.equal((await start(VIDEO, OTHER_COOKIE)).status, 403, "someone else's");
  assert.equal((await start(id(34))).status, 403, "a partner's, seen by the owner");
  const refusals: Array<[string, number, RegExp]> = [
    [id(30), 400, /Only videos/], [id(31), 400, /trash/], [id(32), 400, /locked folder/], [id(33), 400, /Only videos/],
    [id(35), 413, /up to 10 minutes/], [id(36), 413, /up to 2 GB/], [id(37), 415, /MP4, MOV, MKV, WebM and 3GP/],
    [id(99), 404, /Video not found/], ["not-a-uuid", 404, /Video not found/],
  ];
  for (const [assetId, code, message] of refusals) {
    const { status: got, body } = await start(assetId);
    assert.equal(got, code, `${assetId}: ${JSON.stringify(body)}`);
    assert.match(body.error, message);
  }
  const plain = await callService(service.base, "POST", `/videos/${VIDEO}/reduce-noise`, { cookie: OWNER_COOKIE, contentType: "text/plain" });
  assert.equal(plain.status, 415, "only JSON: the cross-site guard");
  assert.deepEqual(renders, []);
  assert.deepEqual(uploads, []);
});

test("a job is only its owner's to ask about", async () => {
  const { body } = await start(QUEUE[1]!);
  assert.equal((await status(body.jobId, OTHER_COOKIE)).status, 404);
  assert.equal((await call("GET", "/videos/jobs/not-a-job")).status, 404);
  assert.equal((await call("GET", `/videos/jobs/${randomUUID()}`)).status, 404);
  assert.equal((await finished(body.jobId)).state, "done");
});

test("the switch: off refuses (403) and says where to turn it on; on again works", async () => {
  const set = (enabled: boolean) => callService(service.base, "PUT", "/flags", { cookie: OWNER_COOKIE, json: { reduceNoise: { enabled } } });
  assert.equal((await set(false)).status, 200);
  try {
    const { status: got, body } = await start(VIDEO);
    assert.equal(got, 403);
    assert.match(body.error, /Memento Features/);
    assert.equal((await call("GET", "/flags")).body.flags.reduceNoise.enabled, false);
  } finally {
    assert.equal((await set(true)).status, 200);
  }
  assert.equal((await finished((await start(VIDEO)).body.jobId)).state, "done");
});

test("one at a time, three waiting, then busy (503); asking again for a video in line answers about the same job", async () => {
  holdRenders();
  const jobs: string[] = [];
  for (const assetId of QUEUE.slice(0, 4)) {
    const { status: got, body } = await start(assetId);
    assert.equal(got, 202, JSON.stringify(body));
    jobs.push(body.jobId);
  }
  const full = await start(QUEUE[4]!);
  assert.equal(full.status, 503);
  assert.match(full.body.error, /cleaning other videos/);
  assert.equal(full.body.code, "busy", "for the apps' own words");
  assert.equal((await start(QUEUE[2]!)).body.jobId, jobs[2], "a second tap: the same job");
  // The first is being cleaned once the container has it; the rest wait.
  for (let i = 0; i < 50 && renders.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual((await status(jobs[0]!)).body, { jobId: jobs[0], state: "running" });
  for (const jobId of jobs.slice(1)) assert.deepEqual((await status(jobId)).body, { jobId, state: "queued" });
  release();
  for (const jobId of jobs) assert.equal((await finished(jobId)).state, "done");
  assert.deepEqual(renders.map((r) => r.original), QUEUE.slice(0, 4).map((a) => `ORIGINAL ${a}`), "first come, first served");
  assert.equal(mostAtOnce, 1, "never two at once");
  assert.equal(uploads.length, 4);
});

test("a video with no sound: failed, saying so in words for the person; nothing uploaded", async () => {
  unsuitable.set(SILENT, "it has no sound");
  const done = await finished((await start(SILENT)).body.jobId);
  assert.deepEqual({ state: done.state, error: done.error }, { state: "failed", error: "This video has no sound to clean up." });
  assert.deepEqual(uploads, []);
});

test("the container busy with a creation: the video waits its turn, then is cleaned", async () => {
  busy = true;
  const { body } = await start(QUEUE[3]!);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual((await status(body.jobId)).body, { jobId: body.jobId, state: "queued" });
  busy = false;
  assert.equal((await finished(body.jobId)).state, "done");
});

test("a restart: what was in the line comes back as failed, asking to try again", async () => {
  holdRenders();
  const running = (await start(QUEUE[0]!)).body.jobId;
  const waiting = (await start(QUEUE[1]!)).body.jobId;
  for (let i = 0; i < 50 && renders.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  await service.stop();
  await service.start();
  release();
  for (const jobId of [running, waiting]) {
    const { body } = await status(jobId);
    assert.deepEqual({ state: body.state, error: body.error }, { state: "failed", error: "Memento restarted while cleaning this video. Try again." });
  }
});

test("the night captions' hours: refused at once, saying when to try again", async () => {
  // Quiet hours from an hour ago to an hour from now (UTC, the limits' default time zone).
  const hhmm = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(11, 16);
  const nightData = mkdtempSync(join(tmpdir(), "memento-extras-noise-night-"));
  const night = new Service(await freePort(), { ...env, RENDER_QUIET_HOURS: `${hhmm(-60)}-${hhmm(60)}`, DATA_DIR: nightData });
  await night.start();
  try {
    const { status: got, body } = await start(VIDEO, OWNER_COOKIE, night.base);
    assert.equal(got, 503);
    assert.equal(body.error, `Reduce noise doesn't run at night (${hhmm(-60)}–${hhmm(60)}), while new photos are captioned. Try again after ${hhmm(60)}.`);
    assert.deepEqual(renders, []);
  } finally {
    await night.stop();
    rmSync(nightData, { recursive: true, force: true });
  }
});

// Asks a service (`base`) about a job until it's done or failed.
async function finishedOn(base: string, jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const { body } = await call("GET", `/videos/jobs/${jobId}`, OWNER_COOKIE, base);
    if (body.state === "done" || body.state === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the job didn't finish");
}

const FAILED = "Couldn't reduce the noise in this video. Try again later.";

test("cleaned again after its copy was deleted: Immich's duplicate is taken out of the trash and stacked; if Immich won't, it fails saying so", async () => {
  const video = MORE[0]!;
  const first = await finished((await start(video)).body.jobId);
  assert.equal(first.state, "done");
  const copy = first.assetId as string;
  copies.get(copy)!.trashed = true; // the person deleted the copy
  stacks.length = 0;
  const again = await finished((await start(video)).body.jobId);
  assert.deepEqual({ state: again.state, assetId: again.assetId }, { state: "done", assetId: copy }, "the same copy, as Immich answers");
  assert.equal(uploads.at(-1)!.status, "duplicate");
  assert.equal(copies.get(copy)!.trashed, false, "restored from the trash");
  assert.deepEqual(stacks, [[copy, video]], "and stacked on top again");
  // Deleted again, and Immich won't restore it this time: failed, in plain words.
  copies.get(copy)!.trashed = true;
  refuseRestore = true;
  const refused = await finished((await start(video)).body.jobId);
  assert.equal(refused.state, "failed");
  assert.match(refused.error as string, /in the trash, and it couldn't be restored/);
  assert.equal(copies.get(copy)!.trashed, true);
  assert.deepEqual(readdirSync(workDir), []);
  copies.get(copy)!.trashed = false;
});

test("a reason from the container that isn't one of ours (constructor, __proto__): failed in plain words, and the line goes on", async () => {
  holdRenders();
  unsuitable.set(MORE[1]!, "constructor");
  unsuitable.set(MORE[2]!, "__proto__");
  const jobs = [];
  for (const video of [MORE[1]!, MORE[2]!, MORE[3]!]) jobs.push((await start(video)).body.jobId as string);
  release();
  const [constructor, proto, after] = await Promise.all(jobs.map((jobId) => finished(jobId)));
  assert.deepEqual([constructor!.state, constructor!.error], ["failed", FAILED]);
  assert.deepEqual([proto!.state, proto!.error], ["failed", FAILED]);
  assert.equal(after!.state, "done", "the next one in line was cleaned");
});

test("the database failing mid-job: the job ends failed (even if that can't be written) and the line goes on", async () => {
  const [startFails, nothingWritten, after] = [MORE[4]!, MORE[5]!, MORE[6]!];
  const db = new DatabaseSync(join(dataDir, "data.db"));
  db.exec(`
    CREATE TRIGGER test_start_fails BEFORE UPDATE ON noise_jobs WHEN NEW.state = 'running' AND NEW.asset_id = '${startFails}'
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    CREATE TRIGGER test_end_fails BEFORE UPDATE ON noise_jobs WHEN NEW.state IN ('done', 'failed') AND NEW.asset_id = '${nothingWritten}'
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
  `);
  db.close();
  try {
    holdRenders();
    const jobs = [];
    for (const video of [startFails, nothingWritten, after]) jobs.push((await start(video)).body.jobId as string);
    release();
    const [first, second, third] = await Promise.all(jobs.map((jobId) => finished(jobId)));
    assert.deepEqual([first!.state, first!.error], ["failed", FAILED], "its start couldn't be written");
    assert.deepEqual([second!.state, second!.error], ["failed", FAILED], "neither done nor failed could be written: answered from the line");
    assert.equal(third!.state, "done", "the next one in line was cleaned");
    assert.match(service.logs, /reduce_noise_record_failed/);
    assert.deepEqual(readdirSync(workDir), []);
  } finally {
    const cleanup = new DatabaseSync(join(dataDir, "data.db"));
    cleanup.exec("DROP TRIGGER test_start_fails; DROP TRIGGER test_end_fails;");
    cleanup.close();
  }
});

test("requests at the same moment: one job for one video, and never more than one being cleaned and three waiting", async () => {
  holdRenders();
  assetDelayMs = 200; // each request waits on Immich, so they overlap
  const same = await Promise.all([1, 2, 3].map(() => start(MORE[7]!)));
  assert.deepEqual(same.map((r) => r.status), [202, 202, 202]);
  assert.equal(new Set(same.map((r) => r.body.jobId)).size, 1, "one job, whoever asked first");
  const others = await Promise.all(MORE.slice(8, 12).concat(QUEUE.slice(0, 2)).map((video) => start(video)));
  const accepted = others.filter((r) => r.status === 202);
  assert.equal(accepted.length, 3, "the line holds three besides the one being cleaned");
  assert.ok(others.filter((r) => r.status !== 202).every((r) => r.status === 503 && r.body.code === "busy"));
  release();
  for (const jobId of [same[0]!.body.jobId, ...accepted.map((r) => r.body.jobId)]) assert.equal((await finished(jobId)).state, "done");
  assert.equal(renders.length, 4, "the video asked for three times was cleaned once");
  assert.equal(mostAtOnce, 1);
});

test("Immich refusing the copy's upload: failed with its message; nothing left in the work folder", async () => {
  uploadFailures = 1;
  const done = await finished((await start(QUEUE[2]!)).body.jobId);
  assert.deepEqual({ state: done.state, error: done.error }, { state: "failed", error: "Immich returned an error while trying to upload the cleaned video." });
  assert.deepEqual(readdirSync(workDir), []);
});

test("low on disk: refused (507) before anything starts", async () => {
  const lowData = mkdtempSync(join(tmpdir(), "memento-extras-noise-low-"));
  const low = new Service(await freePort(), { ...env, DATA_DIR: lowData, REDUCE_NOISE_MIN_FREE_BYTES: String(10 ** 18) });
  await low.start();
  try {
    const { status: got, body } = await start(VIDEO, OWNER_COOKIE, low.base);
    assert.equal(got, 507);
    assert.match(body.error, /low on disk space/);
    assert.deepEqual(renders, []);
  } finally {
    await low.stop();
    rmSync(lowData, { recursive: true, force: true });
  }
});

test("waited too long behind a busy container: failed, saying so", async () => {
  const waitData = mkdtempSync(join(tmpdir(), "memento-extras-noise-wait-"));
  const impatient = new Service(await freePort(), { ...env, DATA_DIR: waitData, REDUCE_NOISE_WAIT_SECONDS: "1" });
  await impatient.start();
  busy = true;
  try {
    const { status: got, body } = await start(VIDEO, OWNER_COOKIE, impatient.base);
    assert.equal(got, 202);
    const done = await finishedOn(impatient.base, body.jobId);
    assert.deepEqual({ state: done.state, error: done.error }, { state: "failed", error: "Memento was busy for too long to clean this video. Try again later." });
    assert.deepEqual(renders, []);
  } finally {
    busy = false;
    await impatient.stop();
    rmSync(waitData, { recursive: true, force: true });
  }
});
