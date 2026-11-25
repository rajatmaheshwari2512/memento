// AI edits without holding images in memory: Gemini's reply read as it arrives, in any shape it
// comes in; the cap on how big it may get; each edit's files removed whatever happens (and any a
// crash left, at start); edits refused when the disk is nearly full; the result sent from disk.
// Runs the real service against a fake Immich and a fake Gemini, so nothing real is called and
// no edit costs money. Run: npm test

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { call as callService, freePort, json, listen, readBody, Service } from "./helpers.ts";

const jpeg = (bytes: number) => {
  const out = randomBytes(bytes);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  return out;
};
const ORIGINAL = jpeg(300_000);
const PREVIEW = jpeg(100_000);
const RAW = Buffer.concat([Buffer.from("II*\0"), randomBytes(200_000)]); // a TIFF-based RAW: not for Gemini
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), randomBytes(200_000)]);
const BIG = jpeg(15 * 1024 * 1024); // over MAX_ORIGINAL_BYTES (14 MB)
const RESULT_A = jpeg(200_000);
const RESULT_B = jpeg(150_000);
const OWNER = { id: "11111111-1111-4111-8111-111111111111", name: "Owner", isAdmin: false };
const PHOTO = "33333333-3333-4333-8333-333333333333";
// Originals Gemini doesn't get: Immich's preview goes instead. RAW_PHOTO's isn't an image Gemini
// reads; BIG_PHOTO is over 14 MB by Immich's details, SAYS_SMALL is too but Immich's details say
// it's small (its size is declared when sent), and SENT_UNDECLARED the same, sent without a
// declared size (found only as it arrives). HEIC_PHOTO's original goes, by its declared type.
const RAW_PHOTO = "44444444-4444-4444-8444-444444444444";
const BIG_PHOTO = "55555555-5555-4555-8555-555555555555";
const SAYS_SMALL = "66666666-6666-4666-8666-666666666666";
const SENT_UNDECLARED = "77777777-7777-4777-8777-777777777777";
const HEIC_PHOTO = "88888888-8888-4888-8888-888888888888";
const ORIGINALS: Record<string, { bytes: Buffer; type: string; fileSize: number; undeclared?: boolean }> = {
  [PHOTO]: { bytes: ORIGINAL, type: "image/jpeg", fileSize: ORIGINAL.length },
  [RAW_PHOTO]: { bytes: RAW, type: "image/x-adobe-dng", fileSize: RAW.length },
  [BIG_PHOTO]: { bytes: BIG, type: "image/jpeg", fileSize: BIG.length },
  [SAYS_SMALL]: { bytes: BIG, type: "image/jpeg", fileSize: 1000 },
  [SENT_UNDECLARED]: { bytes: BIG, type: "image/jpeg", fileSize: 1000, undeclared: true },
  [HEIC_PHOTO]: { bytes: HEIC, type: "image/heic", fileSize: HEIC.length },
};
const immichCalls: string[] = [];
const COOKIE = "immich_access_token=ownertoken0123456789";
const b64 = (bytes: Buffer) => bytes.toString("base64");

const sentImages: Buffer[][] = []; // what each request to Gemini carried
const sentTypes: string[][] = [];
let immich: Server;
let gemini: Server;
let service: Service;
let lowDisk: Service;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-stream-"));
const lowDiskDir = mkdtempSync(join(tmpdir(), "memento-extras-lowdisk-"));

// Writes `body` in small pieces, letting each go before the next.
async function trickle(res: ServerResponse, body: string, piece = 1000): Promise<void> {
  res.writeHead(200, { "content-type": "application/json" });
  for (let at = 0; at < body.length; at += piece) {
    res.write(body.slice(at, at + piece));
    await new Promise((resolve) => setImmediate(resolve));
  }
  res.end();
}

// Gemini's answer, by a word in the instruction.
async function answer(text: string, res: ServerResponse): Promise<void> {
  const image = (bytes: Buffer) => ({ type: "image", mime_type: "image/jpeg", data: b64(bytes) });
  if (text.includes("ODDORDER")) {
    return void res.writeHead(200).end(
      `{ "steps" : [ { "content" : [ { "data" : "${b64(RESULT_A)}", "type" : "image" } ], "type" : "model_output" } ],\n "status" : "completed" }`,
    );
  }
  if (text.includes("TWOIMAGES")) {
    return json(res, 200, { status: "completed", steps: [{ content: [image(RESULT_A)] }, { content: [{ type: "text", text: "and" }, image(RESULT_B)] }] });
  }
  if (text.includes("SLOWLY")) return trickle(res, JSON.stringify({ status: "completed", steps: [{ content: [image(RESULT_B)] }] }), 777);
  if (text.includes("WRAPPED")) {
    const data = b64(RESULT_A).replace(/.{76}/g, "$&\n");
    return void res.writeHead(200).end(JSON.stringify({ status: "completed", steps: [{ content: [{ type: "image", data }] }] }).replaceAll("/", "\\/"));
  }
  if (text.includes("NOTDONE")) return json(res, 200, { status: "in_progress", steps: [{ content: [image(RESULT_A)] }] });
  if (text.includes("NOTJSON")) return void res.writeHead(200).end(`{"status":"completed","steps":[{"content":[{"type":"image","data":"${b64(RESULT_A)}"`);
  if (text.includes("HUGE")) {
    // Over the cap (100 MB), in a field the service skips: refused, whatever comes after.
    res.writeHead(200, { "content-type": "application/json" });
    res.on("error", () => {});
    res.write(`{"status":"completed","steps":[{"type":"thought","signature":"`);
    const megabyte = Buffer.alloc(1024 * 1024, 65);
    for (let i = 0; i < 102 && !res.destroyed; i++) {
      if (!res.write(megabyte)) await new Promise((resolve) => res.once("drain", resolve).once("close", resolve));
    }
    return void res.end(`"},{"content":[${JSON.stringify(image(RESULT_A))}]}]}`);
  }
  if (text.includes("BIGERROR")) return void res.writeHead(500).end(JSON.stringify({ error: { status: "INTERNAL", message: "x".repeat(100_000) } }));
  if (text.includes("BUSY")) return json(res, 429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "the secret heron" } });
  return json(res, 200, { status: "completed", steps: [{ content: [image(RESULT_A)] }] });
}

before(async () => {
  immich = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.headers.cookie !== COOKIE) return json(res, 401, {});
    if (path === "/api/users/me") return json(res, 200, OWNER);
    immichCalls.push(path);
    const [, , , id, what] = path.split("/");
    const original = ORIGINALS[id ?? ""];
    if (!original) return json(res, 404, {});
    if (what === undefined) {
      return json(res, 200, {
        id, type: "IMAGE", ownerId: OWNER.id, isTrashed: false, originalFileName: "beach.jpg", originalMimeType: original.type,
        fileCreatedAt: "2024-05-01T10:00:00.000Z", width: 4080, height: 3072,
        exifInfo: { exifImageWidth: 4080, exifImageHeight: 3072, fileSizeInByte: original.fileSize },
      });
    }
    if (what === "thumbnail") return void res.writeHead(200, { "content-type": "image/jpeg" }).end(PREVIEW);
    if (what !== "original") return json(res, 404, {});
    if (!original.undeclared) return void res.writeHead(200, { "content-type": original.type, "content-length": original.bytes.length }).end(original.bytes);
    res.writeHead(200, { "content-type": original.type, "transfer-encoding": "chunked" });
    res.on("error", () => {});
    for (let at = 0; at < original.bytes.length && !res.destroyed; at += 1024 * 1024) {
      if (!res.write(original.bytes.subarray(at, at + 1024 * 1024))) await new Promise((resolve) => res.once("drain", resolve).once("close", resolve));
    }
    res.end();
  });
  gemini = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { input: Array<{ type: string; text?: string; data?: string; mime_type?: string }> };
    sentImages.push(body.input.filter((i) => i.type === "image").map((i) => Buffer.from(i.data!, "base64")));
    sentTypes.push(body.input.filter((i) => i.type === "image").map((i) => i.mime_type!));
    await answer(body.input.find((i) => i.type === "text")?.text ?? "", res);
  });
  const env = {
    IMMICH_URL: `http://127.0.0.1:${await listen(immich)}`,
    GEMINI_URL: `http://127.0.0.1:${await listen(gemini)}/v1beta/interactions`,
    GEMINI_API_KEY: "test-key-not-real",
    DAILY_LIMIT_PER_USER: "1000",
    MONTHLY_LIMIT_TOTAL: "1000",
    LIMITS_TIMEZONE: "UTC",
  };
  service = new Service(await freePort(), { ...env, DATA_DIR: dataDir });
  // Files a crash left behind: gone at start.
  mkdirSync(join(lowDiskDir, "edit-files", "left-by-a-crash"), { recursive: true });
  writeFileSync(join(lowDiskDir, "edit-files", "left-by-a-crash", "result-0"), "x");
  lowDisk = new Service(await freePort(), { ...env, DATA_DIR: lowDiskDir, ADJUST_MIN_FREE_BYTES: String(10 ** 15) });
  await Promise.all([service.start(), lowDisk.start()]);
});

after(async () => {
  await Promise.all([service.stop(), lowDisk.stop()]);
  immich.close();
  gemini.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(lowDiskDir, { recursive: true, force: true });
});

const edit = (prompt: string, extra: Record<string, unknown> = {}, on = service) =>
  callService(on.base, "POST", "/edits", { cookie: COOKIE, json: { assetId: PHOTO, prompt, ...extra } });
const usedToday = async () => (await callService(service.base, "GET", "/limits", { cookie: COOKIE })).body.today.used as number;
const editFiles = () => readdirSync(join(dataDir, "edit-files"));
const result = async (id: string) => {
  const res = await fetch(`${service.base}/edits/${id}/image`, { headers: { cookie: COOKIE } });
  return { length: res.headers.get("content-length"), bytes: Buffer.from(await res.arrayBuffer()) };
};

test("Gemini's reply in any shape: keys in another order, two images (the last is the result), sent slowly, its base64 wrapped and escaped", async () => {
  for (const [prompt, expected] of [["ODDORDER", RESULT_A], ["TWOIMAGES", RESULT_B], ["SLOWLY", RESULT_B], ["WRAPPED", RESULT_A]] as const) {
    const made = await edit(prompt);
    assert.equal(made.status, 201, `${prompt}: ${JSON.stringify(made.body)}`);
    assert.deepEqual(await result(made.body.editId), { length: String(expected.length), bytes: expected }, prompt);
  }
  assert.deepEqual(editFiles(), [], "each edit's files are removed when it ends");
});

test("Edit more starts from the stored result, sent to Gemini from disk", async () => {
  const first = await edit("TWOIMAGES");
  sentImages.length = 0;
  const more = await edit("warmer", { fromEditId: first.body.editId });
  assert.equal(more.status, 201);
  assert.deepEqual(sentImages, [[RESULT_B]]);
  assert.deepEqual(await result(more.body.editId), { length: String(RESULT_A.length), bytes: RESULT_A });
});

test("no image, or not completed: refused as before; a reply that isn't JSON fails; none is counted, and the files go", async () => {
  const before = await usedToday();
  const notDone = await edit("NOTDONE");
  assert.equal(notDone.status, 422);
  assert.equal(notDone.body.error, "Gemini didn't return an image. Try rewording the instruction.");
  assert.equal((await edit("NOTJSON")).status, 500);
  assert.equal(await usedToday(), before);
  assert.deepEqual(editFiles(), []);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(service.logs, /"event":"gemini_no_image","status":"in_progress","reason":"no_image"/);
});

test("a reply over the cap is cut off: 502, not counted, its files gone; Google's error answers give only their code, even a big one", async () => {
  const before = await usedToday();
  const huge = await edit("HUGE");
  assert.equal(huge.status, 502);
  assert.match(huge.body.error, /too large/);
  assert.equal(await usedToday(), before);
  assert.deepEqual(editFiles(), []);
  const big = await edit("BIGERROR");
  assert.equal(big.status, 502);
  assert.equal(big.body.error, "Google returned an error (500).");
  assert.equal((await edit("BUSY")).status, 503);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(service.logs, /"event":"gemini_reply_too_large"/);
  assert.match(service.logs, /"event":"gemini_error","status":500,"code":null/);
  assert.match(service.logs, /"event":"gemini_error","status":429,"code":"RESOURCE_EXHAUSTED"/);
  assert.doesNotMatch(service.logs, /secret heron/);
});

test("the original when Gemini can take it, else Immich's preview: a RAW, or an original over 14 MB (by Immich's details, its declared size, or as it arrives)", async () => {
  for (const [assetId, bytes, type, from] of [
    [PHOTO, ORIGINAL, "image/jpeg", "original"],
    [RAW_PHOTO, PREVIEW, "image/jpeg", "preview"],
    [BIG_PHOTO, PREVIEW, "image/jpeg", "preview"],
    [SAYS_SMALL, PREVIEW, "image/jpeg", "preview"],
    [SENT_UNDECLARED, PREVIEW, "image/jpeg", "preview"],
    [HEIC_PHOTO, HEIC, "image/heic", "original"],
  ] as const) {
    sentImages.length = 0;
    sentTypes.length = 0;
    immichCalls.length = 0;
    const made = await edit("warmer", { assetId });
    assert.equal(made.status, 201, `${assetId}: ${JSON.stringify(made.body)}`);
    assert.deepEqual(sentImages, [[bytes]], assetId);
    assert.deepEqual(sentTypes, [[type]], assetId);
    assert.equal(immichCalls.some((c) => c.endsWith("/original")), assetId !== BIG_PHOTO, `${assetId}: the original asked for only when it may fit`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(service.logs, new RegExp(`"event":"edit","edit":"${made.body.editId}".*"from":"${from}"`));
  }
  assert.deepEqual(editFiles(), [], "the original's part-download is removed too");
});

test("disk nearly full: edits are refused (507) before anything is read, downloaded or counted; files a crash left are gone at start", async () => {
  sentImages.length = 0;
  assert.equal(existsSync(join(lowDiskDir, "edit-files", "left-by-a-crash")), false, "left by a crash: removed at start");
  const refused = await edit("warmer", {}, lowDisk);
  assert.equal(refused.status, 507);
  assert.match(refused.body.error, /low on disk space, so AI edits can't be made/);
  const area = await callService(lowDisk.base, "POST", "/edits/area", {
    cookie: COOKIE, json: { assetId: PHOTO, prompt: "remove", mark: b64(RESULT_A), photo: b64(ORIGINAL) },
  });
  assert.equal(area.status, 507);
  assert.deepEqual(sentImages, []);
  assert.equal((await callService(lowDisk.base, "GET", "/limits", { cookie: COOKIE })).body.today.used, 0);
});
