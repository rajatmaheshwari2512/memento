// Feature flags, by running the real service against a fake Immich and a fake Gemini. Run: npm test

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { call as callService, freePort, listen, readBody, Service, type CallOptions } from "./helpers.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(60).fill(0), 0xff, 0xd9]);
const ADMIN = { id: "11111111-1111-4111-8111-111111111111", name: "Admin", isAdmin: true };
const USER = { id: "22222222-2222-4222-8222-222222222222", name: "User", isAdmin: false };
const PHOTO = "33333333-3333-4333-8333-333333333333";
const ADMIN_COOKIE = "immich_access_token=admintoken0123456789";
const USER_COOKIE = "immich_access_token=usertoken01234567890";
const ADMIN_API_KEY = "adminapikey0123456789";

const immichCalls: string[] = [];
const geminiSizes: string[] = [];
let immich: Server;
let gemini: Server;
let service: Service;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-flags-"));

function whoFor(req: IncomingMessage): typeof ADMIN | null {
  const cookie = req.headers.cookie ?? "";
  if (cookie === ADMIN_COOKIE || req.headers["x-api-key"] === ADMIN_API_KEY) return ADMIN;
  if (cookie === USER_COOKIE) return USER;
  return null;
}

const call = (method: string, path: string, opts: CallOptions = {}) => callService(service.base, method, path, opts);

const edit = (json: Record<string, unknown> = {}) => call("POST", "/edits", { cookie: ADMIN_COOKIE, json: { assetId: PHOTO, prompt: "make it warmer", ...json } });
const setFlags = (json: unknown, cookie = ADMIN_COOKIE) => call("PUT", "/flags", { cookie, json });


before(async () => {
  immich = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    immichCalls.push(`${req.method} ${path}`);
    const who = whoFor(req);
    if (!who) return void res.writeHead(401).end("{}");
    if (path === "/api/users/me") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(who));
    if (path === `/api/assets/${PHOTO}`) {
      return void res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: PHOTO, type: "IMAGE", ownerId: ADMIN.id, isTrashed: false, originalFileName: "photo.jpg",
          originalMimeType: "image/jpeg", fileCreatedAt: "2026-01-01T00:00:00.000Z", stack: null,
          exifInfo: { exifImageWidth: 4080, exifImageHeight: 3072, fileSizeInByte: JPEG.length },
        }),
      );
    }
    if (path === `/api/assets/${PHOTO}/original`) return void res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
    res.writeHead(404).end("{}");
  });
  gemini = createServer(async (req, res) => {
    const request = JSON.parse(await readBody(req)) as { response_format: { image_size: string } };
    geminiSizes.push(request.response_format.image_size);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ status: "completed", steps: [{ content: [{ type: "image", mime_type: "image/jpeg", data: JPEG.toString("base64") }] }] }),
    );
  });
  const immichPort = await listen(immich);
  const geminiPort = await listen(gemini);
  service = new Service(await freePort(), {
    IMMICH_URL: `http://127.0.0.1:${immichPort}`,
    GEMINI_URL: `http://127.0.0.1:${geminiPort}/v1beta/interactions`,
    GEMINI_API_KEY: "test-key-not-real",
    DATA_DIR: dataDir,
    DAILY_LIMIT_PER_USER: "3",
    MONTHLY_LIMIT_TOTAL: "5",
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

test("reading flags needs a login, and shows the env limits as defaults", async () => {
  assert.equal((await call("GET", "/flags")).status, 401);
  const { status, body } = await call("GET", "/flags", { cookie: USER_COOKIE });
  assert.equal(status, 200);
  assert.deepEqual(body.flags, {
    gemini: { enabled: true, tools: true, allow4k: true, dailyLimitPerUser: 3, monthlyLimitTotal: 5 },
    themedMemories: { enabled: true },
    creations: { enabled: true },
    liveAlbums: { enabled: true },
    askPhotos: { enabled: true, trainedReader: true, places: true },
    captions: { enabled: true },
    adjust: { enabled: true },
    reduceNoise: { enabled: true },
    storageSaver: { enabled: false },
  });
  assert.deepEqual(body.defaults, body.flags);
});

test("only an admin, logged in (not with an API key), can change flags", async () => {
  assert.equal((await setFlags({ gemini: { enabled: false } }, USER_COOKIE)).status, 403);
  assert.equal((await call("PUT", "/flags", { apiKey: ADMIN_API_KEY, json: { gemini: { enabled: false } } })).status, 403);
  assert.equal((await call("PUT", "/flags", { cookie: ADMIN_COOKIE, contentType: "text/plain", json: { gemini: { enabled: false } } })).status, 415);
  assert.equal((await call("GET", "/flags", { cookie: USER_COOKIE })).body.flags.gemini.enabled, true);
});

test("bad settings are refused and change nothing", async () => {
  assert.equal((await setFlags({ gemini: { unknown: true } })).status, 400);
  assert.equal((await setFlags({ nope: { enabled: true } })).status, 400);
  assert.equal((await setFlags({ gemini: { enabled: "yes" } })).status, 400);
  assert.equal((await setFlags({ gemini: { dailyLimitPerUser: -1 } })).status, 400);
  assert.equal((await setFlags({ gemini: { dailyLimitPerUser: 2.5 } })).status, 400);
  assert.equal((await setFlags({ gemini: { enabled: false, monthlyLimitTotal: 99999 } })).status, 400);
  assert.equal((await call("GET", "/flags", { cookie: ADMIN_COOKIE })).body.flags.gemini.enabled, true);
});

test("Gemini off: edits are refused before Immich or Google are asked anything", async () => {
  const off = await setFlags({ gemini: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.flags.gemini.enabled, false);
  immichCalls.length = 0;
  geminiSizes.length = 0;
  const res = await edit();
  assert.equal(res.status, 403);
  assert.match(res.body.error, /switched off/);
  assert.deepEqual(immichCalls.filter((c) => !c.endsWith("/api/users/me")), []);
  assert.deepEqual(geminiSizes, []);
});

test("4K allowed: a phone photo is edited at 4K; switched off: 2K, also for Edit more", async () => {
  await setFlags({ gemini: { enabled: true, allow4k: true } });
  geminiSizes.length = 0;
  const first = await edit();
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.size, "4K");

  await setFlags({ gemini: { allow4k: false } });
  const more = await edit({ fromEditId: first.body.editId, prompt: "a bit more" });
  assert.equal(more.status, 201, JSON.stringify(more.body));
  assert.equal(more.body.size, "2K");
  const fresh = await edit();
  assert.equal(fresh.body.size, "2K");
  assert.deepEqual(geminiSizes, ["4K", "2K", "2K"]);
});

test("the daily limit comes from the flags", async () => {
  await setFlags({ gemini: { dailyLimitPerUser: 4 } });
  assert.equal((await call("GET", "/limits", { cookie: ADMIN_COOKIE })).body.today.limit, 4);
  assert.equal((await edit()).status, 201);
  const refused = await edit();
  assert.equal(refused.status, 429);
  assert.match(refused.body.error, /limit of 4/);
});

test("setting a value back to its default forgets the override", async () => {
  await setFlags({ gemini: { dailyLimitPerUser: 3 } });
  const db = new DatabaseSync(join(dataDir, "data.db"));
  const keys = (db.prepare("SELECT key FROM flags ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
  db.close();
  assert.deepEqual(keys, ["gemini.allow4k"]);
});

test("flags survive a restart", async () => {
  await setFlags({ gemini: { enabled: false } });
  await service.stop();
  await service.start();
  const { body } = await call("GET", "/flags", { cookie: USER_COOKIE });
  assert.equal(body.flags.gemini.enabled, false);
  assert.equal(body.flags.gemini.allow4k, false);
});

test("Memento admin: everyone's AI edits, only for an admin who's logged in", async () => {
  assert.equal((await call("GET", "/admin/usage", { cookie: USER_COOKIE })).status, 403);
  assert.equal((await call("GET", "/admin/usage", { apiKey: ADMIN_API_KEY })).status, 403);
  const db = new DatabaseSync(join(dataDir, "data.db"));
  const day = new Date().toISOString().slice(0, 10);
  const earlier = `${day.slice(0, 8)}01`;
  const lastMonth = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 2, 15)).toISOString().slice(0, 10);
  const add = db.prepare(
    "INSERT INTO edits (id, user_id, asset_id, day, created_at, model, status, prompt_chars, cost_usd) VALUES (?, ?, ?, ?, ?, 'm', ?, 1, ?)",
  );
  add.run("failed-today", USER.id, PHOTO, day, new Date().toISOString(), "failed", 0);
  add.run("user-earlier", USER.id, PHOTO, earlier, new Date().toISOString(), "done", 0.05);
  add.run("user-last-month", USER.id, PHOTO, lastMonth, new Date().toISOString(), "done", 0.05);
  db.close();

  const { status, body } = await call("GET", "/admin/usage", { cookie: ADMIN_COOKIE });
  assert.equal(status, 200);
  const admin = body.users.find((u: { userId: string }) => u.userId === ADMIN.id);
  const user = body.users.find((u: { userId: string }) => u.userId === USER.id);
  assert.deepEqual(admin, { userId: ADMIN.id, today: 4, thisMonth: 4, costUsd: 0.26, dailyLimit: 3, ownDailyLimit: null });
  assert.deepEqual([user.thisMonth, user.costUsd], [1, 0.05]);
  assert.equal(user.today, earlier === day ? 1 : 0);
  assert.deepEqual(body.month, { used: 5, limit: 5, costUsd: 0.31 });
  assert.equal(body.defaultDailyLimit, 3);
});

test("a daily limit set for one person applies to them; null goes back to everyone's default", async () => {
  await setFlags({ gemini: { enabled: true, monthlyLimitTotal: 7 } });
  const limits = (json: unknown, cookie = ADMIN_COOKIE, id = ADMIN.id) => call("PUT", `/admin/users/${id}/limits`, { cookie, json });
  assert.equal((await limits({ dailyEdits: 10 }, USER_COOKIE)).status, 403);
  assert.equal((await call("PUT", `/admin/users/${ADMIN.id}/limits`, { apiKey: ADMIN_API_KEY, json: { dailyEdits: 10 } })).status, 403);
  for (const bad of [-1, 2.5, "10", 1001, undefined]) assert.equal((await limits({ dailyEdits: bad })).status, 400, String(bad));
  assert.equal((await limits({ dailyEdits: 10 }, ADMIN_COOKIE, "not-a-person")).status, 400);

  assert.equal((await edit()).status, 429);
  const set = await limits({ dailyEdits: 10 });
  assert.equal(set.status, 200);
  assert.equal(set.body.users.find((u: { userId: string }) => u.userId === ADMIN.id).ownDailyLimit, 10);
  assert.equal((await call("GET", "/limits", { cookie: ADMIN_COOKIE })).body.today.limit, 10);
  assert.equal((await edit()).status, 201);
  const stopped = await limits({ dailyEdits: 0 }, ADMIN_COOKIE, "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(
    stopped.body.users.find((u: { userId: string }) => u.userId === "44444444-4444-4444-8444-444444444444"),
    { userId: "44444444-4444-4444-8444-444444444444", today: 0, thisMonth: 0, costUsd: 0, dailyLimit: 0, ownDailyLimit: 0 },
  );
  assert.equal((await edit()).status, 201);
  const monthly = await edit();
  assert.equal(monthly.status, 429);
  assert.match(monthly.body.error, /monthly limit/);

  assert.equal((await limits({ dailyEdits: null })).status, 200);
  assert.equal((await call("GET", "/limits", { cookie: ADMIN_COOKIE })).body.today.limit, 3);
});

test("GET /admin/settings describes every setting, for the app's Memento admin (admins only)", async () => {
  assert.equal((await call("GET", "/admin/settings", { cookie: USER_COOKIE })).status, 403);
  assert.equal((await call("GET", "/flags", { cookie: USER_COOKIE })).body.settings, undefined);
  const { body } = await call("GET", "/admin/settings", { cookie: ADMIN_COOKIE });
  assert.deepEqual(
    body.settings.map((s: { key: string }) => s.key),
    [
      "gemini.enabled", "gemini.tools", "gemini.allow4k", "gemini.dailyLimitPerUser", "gemini.monthlyLimitTotal", "liveAlbums.enabled",
      "askPhotos.enabled", "askPhotos.trainedReader", "askPhotos.places", "themedMemories.enabled", "creations.enabled",
      "captions.enabled", "adjust.enabled", "reduceNoise.enabled", "storageSaver.enabled",
    ],
  );
  for (const setting of body.settings as Array<{ key: string; section: string; title: string; subtitle: string }>) {
    const [group, name] = setting.key.split(".") as [string, string];
    assert.notEqual(body.flags[group][name], undefined, setting.key);
    assert.ok(setting.section && setting.title && setting.subtitle, setting.key);
  }
  const daily = body.settings[3];
  assert.deepEqual([daily.kind, daily.min, daily.max], ["int", 0, 1000]);
});

test("Adjust has its own switch in the Editing section, on by default, and an admin can turn it off", async () => {
  const { body } = await call("GET", "/admin/settings", { cookie: ADMIN_COOKIE });
  const adjust = body.settings.find((s: { key: string }) => s.key === "adjust.enabled");
  assert.deepEqual([adjust.kind, adjust.section], ["boolean", "Editing"]);
  assert.equal(body.defaults.adjust.enabled, true);

  assert.equal((await setFlags({ adjust: { enabled: "no" } })).status, 400);
  assert.equal((await setFlags({ adjust: { enabled: false } }, USER_COOKIE)).status, 403);
  const off = await setFlags({ adjust: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.flags.adjust.enabled, false);
  assert.equal((await call("GET", "/flags", { cookie: USER_COOKIE })).body.flags.adjust.enabled, false);
  assert.equal((await setFlags({ adjust: { enabled: true } })).body.flags.adjust.enabled, true);
});
