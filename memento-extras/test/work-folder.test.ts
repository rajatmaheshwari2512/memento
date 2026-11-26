// What the extras service takes from the folder it shares with the creations container. Run: npm test

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { json, listen, readBody } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "work-folder-test-"));
const work = join(root, "work");
const data = join(root, "data");
mkdirSync(work);
mkdirSync(data);

let answer: () => unknown = () => ({});
let cutShort = false;
let fake: Server;

let lib: typeof import("../src/utils/work-folder.ts");
let client: typeof import("../src/clients/creations.client.ts");
let render: typeof import("../src/services/creation-render.service.ts");

before(async () => {
  fake = createServer((req, res) => void readBody(req).then(() => {
    if (!cutShort) return json(res, 200, answer());
    res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
    res.write('{"results": [');
    setTimeout(() => res.socket?.destroy(), 20);
  }));
  const port = await listen(fake);
  Object.assign(process.env, { GEMINI_API_KEY: "unused", DATA_DIR: data, CREATIONS_WORK_DIR: work, CREATIONS_URL: `http://127.0.0.1:${port}` });
  lib = await import("../src/utils/work-folder.ts");
  client = await import("../src/clients/creations.client.ts");
  render = await import("../src/services/creation-render.service.ts");
});

after(() => {
  fake.close();
  chmodSync(join(work), 0o755);
  rmSync(root, { recursive: true, force: true });
});

const ID = "33333333-3333-4333-8333-333333333333";

test("a finished file is copied out; a link, a pipe, an empty or oversized file is not", async () => {
  const dir = await lib.freshJobFolder(ID);
  writeFileSync(join(dir, "collage.jpg"), "a collage");
  const copy = await lib.takeOutput(ID, "collage.jpg", 1000);
  assert.ok(copy && copy.startsWith(join(data, "outgoing")));
  assert.equal(readFileSync(copy, "utf8"), "a collage");
  rmSync(copy);

  writeFileSync(join(data, "secret.db"), "keys");
  symlinkSync(join(data, "secret.db"), join(dir, "recap.mp4"));
  assert.equal(await lib.takeOutput(ID, "recap.mp4", 1000), null, "a link to the database");
  rmSync(join(dir, "recap.mp4"));

  execFileSync("mkfifo", [join(dir, "recap.mp4")]);
  const started = Date.now();
  assert.equal(await lib.takeOutput(ID, "recap.mp4", 1000), null, "a pipe");
  assert.ok(Date.now() - started < 1000, "waited on the pipe");
  rmSync(join(dir, "recap.mp4"));

  writeFileSync(join(dir, "recap.mp4"), "");
  assert.equal(await lib.takeOutput(ID, "recap.mp4", 1000), null, "empty");
  writeFileSync(join(dir, "recap.mp4"), "x".repeat(2000));
  assert.equal(await lib.takeOutput(ID, "recap.mp4", 1000), null, "too big");
});

test("a job's folder replaced by a link: nothing taken out of it, nothing downloaded into it", async () => {
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "collage.jpg"), "not the container's file");
  rmSync(lib.jobFolder(ID), { recursive: true, force: true });
  symlinkSync(elsewhere, lib.jobFolder(ID));
  assert.equal(await lib.takeOutput(ID, "collage.jpg", 1000), null);
  await assert.rejects(lib.inFolder(lib.jobFolder(ID), "0.jpg"), /isn't a plain folder/);
  rmSync(lib.jobFolder(ID));
  assert.equal(await lib.inFolder(await lib.freshJobFolder(ID), "0.jpg"), join(lib.jobFolder(ID), "0.jpg"));
});

test("only the size measured when it was opened is copied, however much the file grows meanwhile", async () => {
  const dir = await lib.freshJobFolder(ID);
  const file = join(dir, "recap.mp4");
  writeFileSync(file, "x".repeat(100_000));
  const growing = (async () => {
    for (let i = 0; i < 50; i++) await appendFile(file, "y".repeat(100_000));
  })();
  const copy = await lib.takeOutput(ID, "recap.mp4", 10_000_000);
  await growing;
  assert.ok(copy);
  assert.ok(statSync(copy).size < statSync(file).size, "copied what was added after it was opened");
  rmSync(copy);
});

test("at start, leftovers go one by one: one that can't be removed is reported, never stops the rest", async () => {
  await lib.freshJobFolder(ID);
  const stuck = join(work, "stuck");
  mkdirSync(join(stuck, "inner"), { recursive: true });
  writeFileSync(join(stuck, "inner", "f"), "x");
  chmodSync(join(stuck, "inner"), 0o000);
  mkdirSync(join(work, "leftover"));
  mkdirSync(join(data, "outgoing"), { recursive: true });
  writeFileSync(join(data, "outgoing", "half.mp4"), "half an upload");
  const reported: string[] = [];
  const removed = await lib.clearWorkFolder(new Set([ID]), (name) => reported.push(name));
  chmodSync(join(stuck, "inner"), 0o755);
  assert.deepEqual(reported, ["stuck"]);
  assert.deepEqual(readdirSync(work).sort(), [ID, "stuck"].sort(), "the job still to finish is kept");
  assert.equal(removed, 2);
  assert.ok(!existsSync(join(data, "outgoing", "half.mp4")));
});

test("a photo's 50 biggest faces, rounded, are all the container is sent", () => {
  const faces = Array.from({ length: 80 }, (_, i) => [0.1, 0.1, 0.1 + (i + 1) * 0.0101234567, 0.2] as [number, number, number, number]);
  const kept = render.mainFaces(faces);
  assert.equal(kept.length, 50);
  assert.deepEqual(kept[0], [0.1, 0.1, 0.9099, 0.2], "the biggest first, 4 decimals");
  assert.ok(kept.every((f) => f[2] >= 0.1 + 31 * 0.0101));
});

test("the container's answers are checked: one result per photo, numbers that are numbers", async () => {
  answer = () => ({ results: [{ sharpness: 300, brightness: 120, p2: 20, p98: 230 }, { sharpness: "huge", brightness: 1, p2: 1, p98: 1 }, null] });
  assert.deepEqual(await client.measureQuality(ID, ["0.webp", "1.webp", "2.webp"], 5000), [
    { sharpness: 300, brightness: 120, p2: 20, p98: 230 }, null, null,
  ]);
  await assert.rejects(client.measureQuality(ID, ["0.webp", "1.webp"], 5000), /didn't fit/);
  answer = () => ({ results: "x".repeat(70_000) });
  await assert.rejects(client.measureQuality(ID, ["0.webp"], 5000), /didn't fit/, "an answer over 64 KB is ignored");
  answer = () => ({ state: "done" });
  assert.equal(await client.renderState(ID), "done");
  answer = () => ({ state: "exploded" });
  assert.equal(await client.renderState(ID), "unknown");
});

test("a reply cut short is no answer: tried again later, not counted as the job failing", async () => {
  cutShort = true;
  try {
    await assert.rejects(client.renderState(ID), client.CreationsUnreachable);
    await assert.rejects(client.measureQuality(ID, ["0.webp"], 5000), client.CreationsUnreachable);
  } finally {
    cutShort = false;
  }
});
