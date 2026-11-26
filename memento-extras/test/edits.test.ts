// AI edits after they're made: the result, saving it, discarding it, and the routing of every request.
// Runs the real service against a fake Immich and a fake Gemini. Run: npm test

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { call as callService, freePort, json, listen, readBody, Service, type CallOptions } from "./helpers.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(60).fill(7), 0xff, 0xd9]);
const OWNER = { id: "11111111-1111-4111-8111-111111111111", name: "Owner", isAdmin: false };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "Other", isAdmin: false };
const PHOTO = "33333333-3333-4333-8333-333333333333";
const UPLOADED = "44444444-4444-4444-8444-444444444444";
const OWNER_COOKIE = "immich_access_token=ownertoken0123456789";
const OTHER_COOKIE = "immich_access_token=othertoken0123456789";

const uploads: string[] = [];
const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
const stacks: string[][] = [];
let immich: Server;
let gemini: Server;
let service: Service;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-edits-"));

before(async () => {
  immich = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const who = req.headers.cookie === OWNER_COOKIE ? OWNER : req.headers.cookie === OTHER_COOKIE ? OTHER : null;
    if (!who) return json(res, 401, {});
    if (path === "/api/users/me") return json(res, 200, who);
    if (req.method === "GET" && path === `/api/assets/${PHOTO}`) {
      return json(res, 200, {
        id: PHOTO, type: "IMAGE", ownerId: OWNER.id, isTrashed: false, originalFileName: "beach day.jpg",
        originalMimeType: "image/jpeg", fileCreatedAt: "2024-05-01T10:00:00.000Z", stack: { primaryAssetId: PHOTO },
        localDateTime: "2024-05-01T15:30:00.000Z",
        exifInfo: { exifImageWidth: 1600, exifImageHeight: 1200, fileSizeInByte: JPEG.length, dateTimeOriginal: "2024-05-01T10:00:00+00:00", latitude: 15.5, longitude: 73.8 },
      });
    }
    if (path === `/api/assets/${PHOTO}/original`) return void res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
    if (req.method === "POST" && path === "/api/assets") {
      const body = await readBody(req);
      uploads.push(/filename="([^"]+)"/.exec(body)?.[1] ?? "");
      return json(res, 201, { id: UPLOADED, status: "created" });
    }
    if (req.method === "PUT" && path === `/api/assets/${UPLOADED}`) {
      updates.push({ id: UPLOADED, body: JSON.parse(await readBody(req)) });
      return json(res, 200, {});
    }
    if (req.method === "POST" && path === "/api/stacks") {
      stacks.push((JSON.parse(await readBody(req)) as { assetIds: string[] }).assetIds);
      return json(res, 201, {});
    }
    json(res, 404, {});
  });
  gemini = createServer(async (req, res) => {
    await readBody(req);
    json(res, 200, { status: "completed", steps: [{ content: [{ type: "image", mime_type: "image/jpeg", data: JPEG.toString("base64") }] }] });
  });
  service = new Service(await freePort(), {
    IMMICH_URL: `http://127.0.0.1:${await listen(immich)}`,
    GEMINI_URL: `http://127.0.0.1:${await listen(gemini)}/v1beta/interactions`,
    GEMINI_API_KEY: "test-key-not-real",
    DATA_DIR: dataDir,
    LIMITS_TIMEZONE: "UTC",
  });
  await service.start();
});

after(async () => {
  await service.stop();
  immich.close();
  gemini.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (method: string, path: string, opts: CallOptions = {}) => callService(service.base, method, path, opts);
const makeEdit = async () => {
  const made = await call("POST", "/edits", { cookie: OWNER_COOKIE, json: { assetId: PHOTO, prompt: "warmer" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.editId as string;
};

test("the result: only for whoever made the edit", async () => {
  const id = await makeEdit();
  const image = await fetch(`${service.base}/edits/${id}/image`, { headers: { cookie: OWNER_COOKIE } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.match(image.headers.get("content-disposition") ?? "", new RegExp(`ai-edit-${id.slice(0, 8)}\\.jpg`));
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
  assert.equal((await call("GET", `/edits/${id}/image`, { cookie: OTHER_COOKIE })).status, 404);
  assert.equal((await call("GET", "/edits/not-an-id/image", { cookie: OWNER_COOKIE })).status, 404);
  assert.equal((await call("GET", `/edits/${id}/image`)).status, 401);
});

test("saving: uploads once, copies the date and place, stacks on top; a retry doesn't upload again", async () => {
  const id = await makeEdit();
  assert.equal((await call("POST", `/edits/${id}/save`, { cookie: OWNER_COOKIE, json: {}, contentType: "text/plain" })).status, 415);
  assert.equal((await call("POST", `/edits/${id}/save`, { cookie: OTHER_COOKIE, json: {} })).status, 404);
  uploads.length = 0;
  updates.length = 0;
  stacks.length = 0;

  const saved = await call("POST", `/edits/${id}/save`, { cookie: OWNER_COOKIE, json: {} });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { assetId: UPLOADED });
  assert.deepEqual(uploads, [`beach day-ai-edit-${id.slice(0, 8)}.jpg`]);
  assert.deepEqual(updates, [{ id: UPLOADED, body: { dateTimeOriginal: "2024-05-01T15:30:00.000+05:30", latitude: 15.5, longitude: 73.8 } }]);
  assert.deepEqual(stacks, [[UPLOADED, PHOTO]]);

  const again = await call("POST", `/edits/${id}/save`, { cookie: OWNER_COOKIE, json: {} });
  assert.deepEqual(again.body, { assetId: UPLOADED });
  assert.equal(uploads.length, 1);
});

test("discarding: only by whoever made it; afterwards it's gone", async () => {
  const id = await makeEdit();
  assert.equal((await call("DELETE", `/edits/${id}`, { cookie: OTHER_COOKIE, json: {} })).status, 404);
  assert.equal((await call("DELETE", `/edits/${id}`, { cookie: OWNER_COOKIE, json: {} })).status, 204);
  assert.equal((await call("GET", `/edits/${id}/image`, { cookie: OWNER_COOKIE })).status, 404);
  assert.equal((await call("DELETE", `/edits/${id}`, { cookie: OWNER_COOKIE, json: {} })).status, 404);
});

test("routes: unknown paths, wrong methods and extra parts are not found; every reply has the safe headers", async () => {
  for (const [method, path] of [
    ["GET", "/nope"],
    ["GET", "/edits"],
    ["PUT", "/limits"],
    ["GET", `/edits/${PHOTO}/image/more`],
    ["GET", `/edits/${PHOTO}/`],
    ["GET", `/live-albums/${PHOTO}`],
    ["PATCH", "/live-albums"],
  ] as const) {
    const answer = await call(method, path, { cookie: OWNER_COOKIE });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.deepEqual(answer.body, { error: "Not found." });
  }
  const limits = await fetch(`${service.base}/limits?ignored=1`, { headers: { cookie: OWNER_COOKIE } });
  assert.equal(limits.status, 200);
  assert.equal(limits.headers.get("x-content-type-options"), "nosniff");
  assert.equal(limits.headers.get("cache-control"), "no-store");
  const missing = await fetch(`${service.base}/nope`);
  assert.equal(missing.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
});
