// Adjust's save: the apps send the adjusted photo, and it's saved as a copy with the
// original's date and place, stacked on top (the same save path as AI edits).
// Runs the real service against a fake Immich. Run: npm test

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { call as callService, freePort, json, listen, Service } from "./helpers.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(200).fill(9), 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(40).fill(1)]);
const OWNER = { id: "11111111-1111-4111-8111-111111111111", name: "Owner", isAdmin: true };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "Other", isAdmin: false };
const PHOTO = "33333333-3333-4333-8333-333333333333";
const VIDEO = "55555555-5555-4555-8555-555555555555";
const TRASHED = "66666666-6666-4666-8666-666666666666";
const LOCKED = "77777777-7777-4777-8777-777777777777";
const COPY = "44444444-4444-4444-8444-444444444444";
const OWNER_COOKIE = "immich_access_token=ownertoken0123456789";
const OTHER_COOKIE = "immich_access_token=othertoken0123456789";

const immichCalls: string[] = [];
let holdUploads: Promise<void> | null = null; // while set, the fake Immich waits before answering uploads
const uploads: Array<{ filename: string; bytes: Buffer; type: string }> = [];
const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
const stacks: string[][] = [];
// The copy as Immich has it: answered as a "duplicate" (the same bytes saved before), in the
// trash, and whether Immich refuses to restore it.
const copy = { duplicate: false, trashed: false, refuseRestore: false };
let immich: Server;
let service: Service;
let immichUrl: string;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-adjust-"));

const asset = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: "IMAGE", ownerId: OWNER.id, isTrashed: false, originalFileName: "beach day.jpg",
  originalMimeType: "image/jpeg", fileCreatedAt: "2024-05-01T10:00:00.000Z", stack: null,
  // Taken at 02:00 in India: the UTC moment is the evening before.
  localDateTime: "2024-05-02T02:00:00.000Z",
  exifInfo: { exifImageWidth: 8160, exifImageHeight: 6120, dateTimeOriginal: "2024-05-01T20:30:00+00:00", latitude: 15.5, longitude: 73.8 },
  ...extra,
});

before(async () => {
  immich = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    immichCalls.push(`${req.method} ${path}`);
    const who = req.headers.cookie === OWNER_COOKIE ? OWNER : req.headers.cookie === OTHER_COOKIE ? OTHER : null;
    if (!who) return json(res, 401, {});
    if (path === "/api/users/me") return json(res, 200, who);
    if (req.method === "GET" && path === `/api/assets/${PHOTO}`) return json(res, 200, asset(PHOTO));
    if (req.method === "GET" && path === `/api/assets/${VIDEO}`) return json(res, 200, asset(VIDEO, { type: "VIDEO" }));
    if (req.method === "GET" && path === `/api/assets/${TRASHED}`) return json(res, 200, asset(TRASHED, { isTrashed: true }));
    if (req.method === "GET" && path === `/api/assets/${LOCKED}`) return json(res, 200, asset(LOCKED, { visibility: "locked" }));
    if (req.method === "POST" && path === "/api/assets") {
      await holdUploads;
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(await readAll(req)) }).formData();
      const file = form.get("assetData") as File;
      uploads.push({ filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), type: file.type });
      return copy.duplicate ? json(res, 200, { id: COPY, status: "duplicate" }) : json(res, 201, { id: COPY, status: "created" });
    }
    if (req.method === "GET" && path === `/api/assets/${COPY}`) return json(res, 200, asset(COPY, { isTrashed: copy.trashed }));
    if (req.method === "POST" && path === "/api/trash/restore/assets") {
      if (copy.refuseRestore) return json(res, 500, { message: "no" });
      const { ids } = JSON.parse((await readAll(req)).toString()) as { ids: string[] };
      if (ids.includes(COPY)) copy.trashed = false;
      return json(res, 200, { count: ids.length });
    }
    if (req.method === "PUT" && path === `/api/assets/${COPY}`) {
      updates.push({ id: COPY, body: JSON.parse((await readAll(req)).toString()) });
      return json(res, 200, {});
    }
    if (req.method === "POST" && path === "/api/stacks") {
      stacks.push((JSON.parse((await readAll(req)).toString()) as { assetIds: string[] }).assetIds);
      return json(res, 201, {});
    }
    json(res, 404, {});
  });
  immichUrl = `http://127.0.0.1:${await listen(immich)}`;
  service = new Service(await freePort(), {
    IMMICH_URL: immichUrl,
    GEMINI_API_KEY: "test-key-not-real",
    DATA_DIR: dataDir,
  });
  await service.start();
});

after(async () => {
  await service.stop();
  immich.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function readAll(req: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function save(id: string, body: Buffer, type = "image/jpeg", cookie: string | null = OWNER_COOKIE, base = service.base) {
  const headers: Record<string, string> = { "content-type": type };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}/adjust/${id}/save`, { method: "POST", headers, body: new Uint8Array(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const reset = () => {
  for (const list of [immichCalls, uploads, updates, stacks]) list.length = 0;
  Object.assign(copy, { duplicate: false, trashed: false, refuseRestore: false });
};

test("saving: uploads the photo as sent, copies the original's date and place, stacks it on top", async () => {
  reset();
  const saved = await save(PHOTO, JPEG);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { assetId: COPY });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.filename, "beach day-edited.jpg");
  assert.equal(uploads[0]!.type, "image/jpeg");
  assert.deepEqual(uploads[0]!.bytes, JPEG);
  // The original's local time and offset, so the copy is in its time zone and on its day.
  assert.deepEqual(updates, [{ id: COPY, body: { dateTimeOriginal: "2024-05-02T02:00:00.000+05:30", latitude: 15.5, longitude: 73.8 } }]);
  assert.deepEqual(stacks, [[COPY, PHOTO]]);
});

test("a PNG original's copy can be a PNG", async () => {
  reset();
  const saved = await save(PHOTO, PNG, "image/png");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(uploads[0]!.filename, "beach day-edited.png");
  assert.equal(uploads[0]!.type, "image/png");
});

test("refused: other types (the cross-site guard), bytes that aren't the type said, no login, others' photos, videos, the trash, the locked folder", async () => {
  reset();
  for (const type of ["application/json", "text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "image/webp", ""]) {
    assert.equal((await save(PHOTO, JPEG, type)).status, 415, type);
  }
  assert.equal((await save(PHOTO, PNG, "image/jpeg")).status, 415);
  assert.equal((await save(PHOTO, Buffer.from("<svg></svg>"), "image/png")).status, 415);
  assert.equal((await save(PHOTO, JPEG, "image/jpeg", null)).status, 401);
  assert.equal((await save(PHOTO, JPEG, "image/jpeg", OTHER_COOKIE)).status, 403);
  assert.equal((await save(VIDEO, JPEG)).status, 400);
  assert.equal((await save(TRASHED, JPEG)).status, 400);
  assert.equal((await save(LOCKED, JPEG)).status, 400);
  assert.equal((await save("not-a-photo-id", JPEG)).status, 404);
  assert.equal(uploads.length, 0);
});

test("too large: refused from the declared size, before the photo is read", async () => {
  reset();
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${service.base}/adjust/${PHOTO}/save`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "content-length": String(300 * 1024 * 1024), cookie: OWNER_COOKIE },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", reject);
    req.write(JPEG); // the rest never comes
  });
  assert.equal(status, 413);
  assert.deepEqual(immichCalls, []);
});

test("switched off: refused before the photo is read; on again, it saves", async () => {
  assert.equal((await callService(service.base, "PUT", "/flags", { cookie: OWNER_COOKIE, json: { adjust: { enabled: false } } })).status, 200);
  reset();
  const off = await save(PHOTO, JPEG);
  assert.equal(off.status, 403);
  assert.match(off.body.error, /Adjust is switched off/);
  assert.deepEqual(immichCalls.filter((c) => c !== "GET /api/users/me"), []);
  assert.equal((await callService(service.base, "PUT", "/flags", { cookie: OWNER_COOKIE, json: { adjust: { enabled: true } } })).status, 200);
  assert.equal((await save(PHOTO, JPEG)).status, 200);
});

test("twenty saves at once; the next waits its turn and then saves; no upload files are left behind", async () => {
  reset();
  let release!: () => void;
  holdUploads = new Promise((resolve) => (release = resolve));
  const unique = (n: number) => Buffer.concat([JPEG, Buffer.from([n])]);
  const saves = Array.from({ length: 21 }, (_, n) => save(PHOTO, unique(n)));
  const uploading = () => immichCalls.filter((c) => c === "POST /api/assets").length;
  while (uploading() < 20) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(uploading(), 20); // the 21st is waiting, not refused
  release();
  holdUploads = null;
  assert.ok((await Promise.all(saves)).every((r) => r.status === 200));
  assert.equal(uploading(), 21);
  assert.deepEqual(readdirSync(join(dataDir, "adjust-uploads")), []);
});

test("refused, before the photo is read, when the disk is nearly full", async () => {
  const lowDir = mkdtempSync(join(tmpdir(), "memento-extras-adjust-disk-"));
  const low = new Service(await freePort(), {
    IMMICH_URL: immichUrl,
    GEMINI_API_KEY: "test-key-not-real",
    DATA_DIR: lowDir,
    ADJUST_MIN_FREE_BYTES: String(10 ** 18), // more than any disk has free
  });
  await low.start();
  try {
    reset();
    const refused = await save(PHOTO, JPEG, "image/jpeg", OWNER_COOKIE, low.base);
    assert.equal(refused.status, 507);
    assert.match(refused.body.error, /low on disk space/);
    assert.equal(uploads.length, 0);
  } finally {
    await low.stop();
    rmSync(lowDir, { recursive: true, force: true });
  }
});

test("the same Adjust saved again: Immich's earlier copy; if it was deleted, it's restored from the trash and stacked; if Immich won't, refused saying so", async () => {
  reset();
  copy.duplicate = true;
  const again = await save(PHOTO, JPEG);
  assert.deepEqual([again.status, again.body], [200, { assetId: COPY }]);
  assert.ok(!immichCalls.includes("POST /api/trash/restore/assets"), "not in the trash: nothing restored");
  reset();
  Object.assign(copy, { duplicate: true, trashed: true });
  const restored = await save(PHOTO, JPEG);
  assert.deepEqual([restored.status, restored.body], [200, { assetId: COPY }]);
  assert.equal(copy.trashed, false, "taken out of the trash");
  assert.deepEqual(stacks, [[COPY, PHOTO]]);
  reset();
  Object.assign(copy, { duplicate: true, trashed: true, refuseRestore: true });
  const refused = await save(PHOTO, JPEG);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /in the trash, and it couldn't be restored/);
  assert.deepEqual(stacks, []);
});
