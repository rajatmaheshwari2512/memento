// Backup quality, by running the real service against a fake Immich. Run: npm test

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { call as callService, freePort, listen, Service, type CallOptions } from "./helpers.ts";

const ADMIN = { id: "11111111-1111-4111-8111-111111111111", name: "Admin", isAdmin: true };
const USER = { id: "22222222-2222-4222-8222-222222222222", name: "User", isAdmin: false };
const ADMIN_COOKIE = "immich_access_token=admintoken0123456789";
const USER_COOKIE = "immich_access_token=usertoken01234567890";

let immich: Server;
let service: Service;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-backup-"));

function whoFor(req: IncomingMessage): typeof ADMIN | null {
  const cookie = req.headers.cookie ?? "";
  if (cookie === ADMIN_COOKIE) return ADMIN;
  if (cookie === USER_COOKIE) return USER;
  return null;
}

const call = (method: string, path: string, opts: CallOptions = {}) => callService(service.base, method, path, opts);
const quality = (cookie: string) => call("GET", "/backup/settings", { cookie });
const choose = (cookie: string, json: unknown) => call("PUT", "/backup/settings", { cookie, json });
const setStorageSaver = (enabled: boolean) => call("PUT", "/flags", { cookie: ADMIN_COOKIE, json: { storageSaver: { enabled } } });

before(async () => {
  immich = createServer((req, res) => {
    const who = whoFor(req);
    if (!who) return void res.writeHead(401).end("{}");
    if (req.url === "/api/users/me") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(who));
    res.writeHead(404).end("{}");
  });
  service = new Service(await freePort(), {
    IMMICH_URL: `http://127.0.0.1:${await listen(immich)}`,
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

test("Storage saver is off by default, in the Backup section; everyone starts at original; reading needs a login", async () => {
  assert.equal((await call("GET", "/flags", { cookie: USER_COOKIE })).body.flags.storageSaver.enabled, false);
  const { body } = await call("GET", "/admin/settings", { cookie: ADMIN_COOKIE });
  const setting = body.settings.find((s: { key: string }) => s.key === "storageSaver.enabled");
  assert.deepEqual([setting.kind, setting.section, setting.title], ["boolean", "Backup", "Enable Storage saver"]);
  assert.equal((await call("GET", "/backup/settings")).status, 401);
  assert.deepEqual(await quality(USER_COOKIE), { status: 200, body: { quality: "original" } });
});

test("switched off: original can be chosen, a Storage saver level is refused", async () => {
  const refused = await choose(USER_COOKIE, { quality: "saver" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /switched off/);
  assert.equal((await choose(USER_COOKIE, { quality: "saverHigh" })).status, 403);
  assert.deepEqual(await choose(USER_COOKIE, { quality: "original" }), { status: 200, body: { quality: "original" } });
  assert.deepEqual((await quality(USER_COOKIE)).body, { quality: "original" });
});

test("switched on: each level is kept and read back, and logged", async () => {
  assert.equal((await setStorageSaver(true)).status, 200);
  assert.deepEqual(await choose(USER_COOKIE, { quality: "saver" }), { status: 200, body: { quality: "saver" } });
  assert.deepEqual((await quality(USER_COOKIE)).body, { quality: "saver" });
  assert.deepEqual((await choose(USER_COOKIE, { quality: "saverHigh" })).body, { quality: "saverHigh" });
  assert.deepEqual((await quality(USER_COOKIE)).body, { quality: "saverHigh" });
  assert.match(service.logs, new RegExp(`"event":"backup_quality_changed","user":"${USER.id}","quality":"saverHigh"}`));
});

test("bad requests are refused and change nothing", async () => {
  for (const json of [{ quality: "low" }, { quality: 1 }, { quality: null }, {}, { quality: "saver", userId: ADMIN.id }, { other: true }]) {
    assert.equal((await choose(USER_COOKIE, json)).status, 400, JSON.stringify(json));
  }
  assert.equal((await call("PUT", "/backup/settings", { cookie: USER_COOKIE, contentType: "text/plain", json: { quality: "saver" } })).status, 415);
  assert.deepEqual((await quality(USER_COOKIE)).body, { quality: "saverHigh" });
});

test("each person changes only their own", async () => {
  assert.deepEqual((await quality(ADMIN_COOKIE)).body, { quality: "original" });
  assert.deepEqual((await choose(ADMIN_COOKIE, { quality: "saver" })).body, { quality: "saver" });
  assert.deepEqual((await quality(USER_COOKIE)).body, { quality: "saverHigh" });
  assert.deepEqual((await choose(USER_COOKIE, { quality: "original" })).body, { quality: "original" });
  assert.deepEqual((await quality(ADMIN_COOKIE)).body, { quality: "saver" });
});

test("switched off again: choices are kept and still read back", async () => {
  assert.equal((await setStorageSaver(false)).status, 200);
  assert.deepEqual((await quality(ADMIN_COOKIE)).body, { quality: "saver" });
  assert.equal((await choose(ADMIN_COOKIE, { quality: "saverHigh" })).status, 403);
  assert.deepEqual((await quality(ADMIN_COOKIE)).body, { quality: "saver" });
});
