// Tests live albums by running the real service against a fake Immich, so nothing real is
// touched. Run: npm test
//
// The fake Immich has two users (A, an admin, and B), their people, albums and photos,
// and checks what the real one checks: logins, each API key's permissions, who owns what,
// and the strict search filter (unknown keys are refused). Search results come 1,000 at a
// time with a cursor; adding to an album reports per-photo results like Immich does.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { call as callService, COOKIE, freePort, json, listen, readBody, Service, type CallOptions } from "./helpers.ts";

type Person = string;
type FakeAsset = { id: string; ownerId: string; people: Person[]; takenAt: string; visibility: string };
type FakeAlbum = { id: string; albumName: string; ownerId: string; assets: Set<string> };
type FakeKey = { id: string; secret: string; userId: string; permissions: string[]; revoked: boolean };

const A = { id: randomUUID(), name: "A", isAdmin: true };
const B = { id: randomUUID(), name: "B", isAdmin: false };
const [P1, P2, P3, P4, P5] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const P9 = randomUUID(); // B's person

const people = new Map<Person, string>([[P1, A.id], [P2, A.id], [P3, A.id], [P4, A.id], [P5, A.id], [P9, B.id]]);
const assets = new Map<string, FakeAsset>();
const albums = new Map<string, FakeAlbum>();
const keys = new Map<string, FakeKey>(); // by secret
const forbidden = new Set<string>(); // photos Immich refuses to add (no_permission)
const addAttempts = new Map<string, number>();
const fullAccessKey = "fullaccesskeyfora0123456789"; // a normal API key of A's, for the "not with an API key" test

function asset(owner: string, peopleIn: Person[], takenAt: string, visibility = "timeline"): string {
  const id = randomUUID();
  assets.set(id, { id, ownerId: owner, people: peopleIn, takenAt: `${takenAt}T12:00:00.000Z`, visibility });
  return id;
}
const a1 = asset(A.id, [P1], "2023-05-01");
const a2 = asset(A.id, [P2], "2024-03-01");
const a3 = asset(A.id, [P1, P2], "2024-06-01");
const a4 = asset(A.id, [P1, P2, P3], "2024-07-01");
asset(A.id, [P1], "2025-01-01", "hidden"); // a motion photo's video part: never added
const a6 = asset(A.id, [P1, P2], "2023-01-01");
asset(A.id, [P3], "2024-01-02");
asset(B.id, [P9], "2024-01-01");
const bulk = Array.from({ length: 2500 }, (_, i) => asset(A.id, [P4], `2020-01-${String((i % 28) + 1).padStart(2, "0")}`));
const refused = asset(A.id, [P5], "2024-02-02");
forbidden.add(refused);
const couple = randomUUID();
albums.set(couple, { id: couple, albumName: "Couple", ownerId: A.id, assets: new Set() });
const bAlbum = randomUUID();
albums.set(bAlbum, { id: bAlbum, albumName: "B's album", ownerId: B.id, assets: new Set() });

async function body(req: IncomingMessage): Promise<any> {
  const text = await readBody(req);
  return text ? JSON.parse(text) : {};
}


// Who's calling, and with what: a session (cookie) has every permission, a key only its own.
function caller(req: IncomingMessage): { userId: string; key?: FakeKey } | null | "revoked" {
  const cookie = req.headers.cookie;
  if (cookie === COOKIE.A) return { userId: A.id };
  if (cookie === COOKIE.B) return { userId: B.id };
  const apiKey = req.headers["x-api-key"];
  if (apiKey === fullAccessKey) return { userId: A.id, key: { id: "full", secret: fullAccessKey, userId: A.id, permissions: ["all"], revoked: false } };
  const key = typeof apiKey === "string" ? keys.get(apiKey) : undefined;
  if (key) return key.revoked ? "revoked" : { userId: key.userId, key };
  return null;
}

const FILTER_KEYS = new Set(["personIds", "albumIds", "visibility", "takenAt"]);
function matches(a: FakeAsset, f: any): boolean {
  const p = f.personIds ?? {};
  if (p.any && !p.any.some((x: string) => a.people.includes(x))) return false;
  if (p.all && !p.all.every((x: string) => a.people.includes(x))) return false;
  if (p.none && p.none.some((x: string) => a.people.includes(x))) return false;
  if (f.albumIds?.none && f.albumIds.none.some((id: string) => albums.get(id)?.assets.has(a.id))) return false;
  if (f.visibility?.in && !f.visibility.in.includes(a.visibility)) return false;
  if (f.takenAt?.gte && a.takenAt < f.takenAt.gte) return false;
  return true;
}

// Like Immich v3: no ownerId; the owner is the album user with role "owner".
const albumJson = (album: FakeAlbum) => ({
  id: album.id, albumName: album.albumName, albumUsers: [{ role: "owner", user: { id: album.ownerId } }],
});

async function fakeImmich(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const who = caller(req);
  if (who === "revoked" || who === null) return json(res, 401, { message: "Invalid API key" });
  const allowed = (permission: string) => !who.key || who.key.permissions.includes("all") || who.key.permissions.includes(permission);
  const sessionOnly = () => !who.key || who.key.permissions.includes("all");

  if (req.method === "GET" && path === "/api/users/me") return json(res, 200, who.userId === A.id ? A : B);

  if (req.method === "POST" && path === "/api/api-keys") {
    if (!sessionOnly()) return json(res, 403, {});
    const b = await body(req);
    const key: FakeKey = { id: randomUUID(), secret: randomBytes(24).toString("hex"), userId: who.userId, permissions: b.permissions, revoked: false };
    keys.set(key.secret, key);
    return json(res, 201, { id: key.id, name: b.name, permissions: b.permissions, secret: key.secret });
  }
  const keyMatch = /^\/api\/api-keys\/([^/]+)$/.exec(path);
  if (req.method === "DELETE" && keyMatch) {
    for (const [secret, k] of keys) if (k.id === keyMatch[1] && k.userId === who.userId) keys.delete(secret);
    return json(res, 204);
  }

  const personMatch = /^\/api\/people\/([^/]+)$/.exec(path);
  if (req.method === "GET" && personMatch) {
    return people.get(personMatch[1]!) === who.userId ? json(res, 200, { id: personMatch[1] }) : json(res, 400, {});
  }

  if (req.method === "POST" && path === "/api/albums") {
    if (!sessionOnly()) return json(res, 403, {});
    const b = await body(req);
    const album: FakeAlbum = { id: randomUUID(), albumName: b.albumName, ownerId: who.userId, assets: new Set() };
    albums.set(album.id, album);
    return json(res, 201, albumJson(album));
  }
  const albumMatch = /^\/api\/albums\/([^/]+)(\/assets)?$/.exec(path);
  if (albumMatch) {
    const album = albums.get(albumMatch[1]!);
    if (!album || album.ownerId !== who.userId) return json(res, 400, { message: "Not found or no access" });
    if (req.method === "GET" && !albumMatch[2]) {
      if (!allowed("album.read")) return json(res, 403, {});
      return json(res, 200, albumJson(album));
    }
    if (req.method === "PUT" && albumMatch[2]) {
      if (!allowed("albumAsset.create")) return json(res, 403, {});
      const { ids } = await body(req);
      return json(res, 200, (ids as string[]).map((id) => {
        addAttempts.set(id, (addAttempts.get(id) ?? 0) + 1);
        if (forbidden.has(id)) return { id, success: false, error: "no_permission" };
        if (album.assets.has(id)) return { id, success: false, error: "duplicate" };
        album.assets.add(id);
        return { id, success: true };
      }));
    }
  }

  if (req.method === "POST" && path === "/api/search/metadata") {
    if (!allowed("asset.read")) return json(res, 403, {});
    const b = await body(req);
    const filter = b.filter ?? {};
    const unknown = Object.keys(filter).filter((k) => !FILTER_KEYS.has(k));
    if (unknown.length > 0) return json(res, 400, { message: `Unrecognized key: ${unknown.join(", ")}` });
    const size = Math.min(b.size ?? 250, 1000);
    const all = [...assets.values()].filter((a) => a.ownerId === who.userId && matches(a, filter)).sort((x, y) => x.id.localeCompare(y.id));
    const start = b.cursor ? Number(b.cursor) : 0;
    const page = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : null;
    return json(res, 200, { assets: { count: page.length, total: all.length, items: page.map((a) => ({ id: a.id })), facets: [], nextPage: null, nextCursor: next } });
  }
  json(res, 404, {});
}

let immich: Server;
let service: Service;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-live-"));
const secret = randomBytes(32).toString("base64");

before(async () => {
  immich = createServer((req, res) => void fakeImmich(req, res));
  const immichPort = await listen(immich);
  service = new Service(await freePort(), {
    IMMICH_URL: `http://127.0.0.1:${immichPort}`, GEMINI_API_KEY: "unused", GEMINI_URL: "http://127.0.0.1:9/unused",
    DATA_DIR: dataDir, MEMENTO_SECRET: secret, LIVE_ALBUMS_INTERVAL_SECONDS: "3600", SNAPSHOT_FIRST_SECONDS: "1",
  });
  await service.start();
});

after(async () => {
  await service.stop();
  immich.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (method: string, path: string, opts: CallOptions = {}) => callService(service.base, method, path, opts);

// Saving starts a fill in the background; wait for a run that finished after `since`.
async function settled(id: string, since = ""): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const list = (await call("GET", "/live-albums", { cookie: COOKIE.A })).body as any[];
    const found = list.find((l) => l.id === id);
    if (found && ((found.lastRunAt && found.lastRunAt > since) || found.pausedReason)) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("live album never ran");
}

const keysOf = (userId: string) => [...keys.values()].filter((k) => k.userId === userId);
let family = "";
let coupleLive = "";

test("a new live album: creates the album and a limited key, then fills with matching photos", async () => {
  const res = await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumName: "Family", include: [P1, P2], match: "any" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  family = res.body.id;
  const album = albums.get(res.body.albumId)!;
  assert.equal(album.albumName, "Family");
  assert.equal(album.ownerId, A.id);
  assert.deepEqual(keysOf(A.id).map((k) => k.permissions), [["asset.read", "album.read", "albumAsset.create"]]);
  const done = await settled(family);
  assert.equal(done.pausedReason, null);
  // Any of P1/P2, timeline only: not the hidden one, not B's.
  assert.deepEqual([...album.assets].sort(), [a1, a2, a3, a4, a6].sort());
  assert.equal(done.totalAdded, 5);
});

test("all of them in the same photo, minus someone, since a date, on an existing album", async () => {
  const res = await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumId: couple, include: [P1, P2], match: "all", exclude: [P3], since: "2024-01-01" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  coupleLive = res.body.id;
  await settled(coupleLive);
  assert.deepEqual([...albums.get(couple)!.assets], [a3]); // a4 has P3; a6 is from 2023
  assert.equal(keysOf(A.id).length, 1, "the same key is reused");
});

test("a photo removed from the album stays removed; new photos are added", async () => {
  const album = albums.get((await call("GET", "/live-albums", { cookie: COOKIE.A })).body.find((l: any) => l.id === family).albumId)!;
  album.assets.delete(a1); // the user removes it
  const a8 = asset(A.id, [P1], "2025-06-01");
  const res = await call("POST", `/live-albums/${family}/check`, { cookie: COOKIE.A, json: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.added, 1);
  assert.ok(album.assets.has(a8));
  assert.ok(!album.assets.has(a1), "removed photo came back");
});

test("Memento's own creations (a collage, an animation) are never added, though they show the same people", async () => {
  const collage = asset(A.id, [P1], "2025-07-01");
  const loop = asset(A.id, [P1], "2025-07-02");
  const db = new DatabaseSync(join(dataDir, "data.db"));
  const now = new Date().toISOString();
  const memory = db.prepare(
    "INSERT INTO themed_memories (user_id, theme, theme_key, status, made_on, created_at) VALUES (?, 'trip', 'trip:x', 'created', '2026-11-01', ?) RETURNING id",
  ).get(A.id, now) as { id: number };
  db.prepare(
    "INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at, asset_id) VALUES (?, ?, 'collage', '{}', 'done', 0, ?, ?, ?, ?)",
  ).run(A.id, memory.id, now, now, now, collage);
  db.prepare(
    "INSERT INTO creation_jobs (user_id, themed_memory_id, kind, inputs, state, rank, next_at, created_at, updated_at, asset_id) VALUES (?, ?, 'animation', '{}', 'done', 0, ?, ?, ?, ?)",
  ).run(A.id, memory.id, now, now, now, loop);
  db.close();
  const res = await call("POST", `/live-albums/${family}/check`, { cookie: COOKIE.A, json: {} });
  assert.equal(res.body.added, 0);
  assert.ok(!albums.get(res.body.liveAlbum.albumId)!.assets.has(collage) && !albums.get(res.body.liveAlbum.albumId)!.assets.has(loop));
});

test("over 1,000 matches: all are added (search pages and add batches)", async () => {
  const res = await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumName: "P4", include: [P4] } });
  assert.equal(res.status, 201);
  const done = await settled(res.body.id);
  assert.equal(done.totalAdded, 2500);
  assert.equal(albums.get(res.body.albumId)!.assets.size, bulk.length);
});

test("a photo Immich refuses isn't tried again", async () => {
  const res = await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumName: "P5", include: [P5] } });
  await settled(res.body.id);
  await call("POST", `/live-albums/${res.body.id}/check`, { cookie: COOKIE.A, json: {} });
  assert.equal(addAttempts.get(refused), 1);
  assert.ok(!albums.get(res.body.albumId)!.assets.has(refused));
});

test("other users can't see or change your live albums", async () => {
  assert.deepEqual((await call("GET", "/live-albums", { cookie: COOKIE.B })).body, []);
  assert.equal((await call("PUT", `/live-albums/${family}`, { cookie: COOKIE.B, json: { include: [P9] } })).status, 404);
  // A badly formed change is refused before the album is looked up, whoever's it is: says
  // nothing about the album.
  const bad = await call("PUT", `/live-albums/${family}`, { cookie: COOKIE.B, json: { include: [] } });
  assert.deepEqual([bad.status, bad.body.error], [400, "Choose at least one person."]);
  assert.equal((await call("DELETE", `/live-albums/${family}`, { cookie: COOKIE.B, json: {} })).status, 404);
  assert.equal((await call("POST", `/live-albums/${family}/check`, { cookie: COOKIE.B, json: {} })).status, 404);
});

test("only your own albums and your own people", async () => {
  assert.equal((await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumId: bAlbum, include: [P1] } })).status, 404);
  assert.equal((await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumName: "X", include: [P9] } })).status, 400);
  assert.equal((await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumId: couple, include: [P1] } })).status, 409);
  assert.equal((await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumName: "X", include: [P1], exclude: [P1] } })).status, 400);
  assert.equal((await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumName: "X", include: [] } })).status, 400);
});

test("changes need a logged-in app or browser, not an API key", async () => {
  const res = await call("POST", "/live-albums", { apiKey: fullAccessKey, json: { albumName: "X", include: [P1] } });
  assert.equal(res.status, 403);
});

test("switched off: changes and checks are refused, and the background check skips", async () => {
  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { liveAlbums: { enabled: false } } })).status, 200);
  assert.equal((await call("POST", `/live-albums/${family}/check`, { cookie: COOKIE.A, json: {} })).status, 403);
  assert.equal((await call("POST", "/live-albums", { cookie: COOKIE.A, json: { albumName: "X", include: [P1] } })).status, 403);
  assert.equal((await call("GET", "/live-albums", { cookie: COOKIE.A })).status, 200, "listing still works");
  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { liveAlbums: { enabled: true } } })).status, 200);
});

test("a key Immich rejects pauses the live album; saving it again makes a new key and resumes", async () => {
  for (const k of keysOf(A.id)) k.revoked = true;
  const check = await call("POST", `/live-albums/${family}/check`, { cookie: COOKIE.A, json: {} });
  assert.equal(check.body.skipped, "key rejected");
  assert.match(check.body.liveAlbum.pausedReason, /stopped working/);
  const a9 = asset(A.id, [P2], "2025-07-01");
  const before = new Date().toISOString();
  const saved = await call("PUT", `/live-albums/${family}`, { cookie: COOKIE.A, json: { include: [P1, P2], match: "any" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.pausedReason, null);
  assert.equal(keysOf(A.id).filter((k) => !k.revoked).length, 1, "a fresh key");
  const done = await settled(family, before);
  assert.ok(albums.get(done.albumId)!.assets.has(a9));
});

test("the stored key is encrypted, bound to its user, and a tampered one pauses", async () => {
  const db = new DatabaseSync(join(dataDir, "data.db"));
  const row = db.prepare("SELECT sealed FROM user_keys WHERE user_id = ?").get(A.id) as { sealed: string };
  for (const k of keysOf(A.id)) assert.ok(!Buffer.from(row.sealed, "base64").toString("latin1").includes(k.secret), "key stored in the clear");
  const bytes = Buffer.from(row.sealed, "base64");
  bytes[bytes.length - 1]! ^= 0xff; // flip a bit in the ciphertext
  db.prepare("UPDATE user_keys SET sealed = ? WHERE user_id = ?").run(bytes.toString("base64"), A.id);
  db.close();
  const check = await call("POST", `/live-albums/${coupleLive}/check`, { cookie: COOKIE.A, json: {} });
  assert.equal(check.body.skipped, "key unreadable");

  // Bound to the user: A's sealed key opened as B's fails.
  Object.assign(process.env, { MEMENTO_SECRET: secret, GEMINI_API_KEY: "unused", DATA_DIR: dataDir });
  const box = await import("../src/utils/crypto-box.ts");
  const sealed = box.seal("live-albums api-keys", A.id, "secret-key");
  assert.equal(box.open("live-albums api-keys", A.id, sealed), "secret-key");
  assert.throws(() => box.open("live-albums api-keys", B.id, sealed));
});

test("a complete copy of the database is written for the nightly backup", async () => {
  const copy = join(dataDir, "backup", "memento-extras.db");
  for (let i = 0; i < 100 && !existsSync(copy); i++) await new Promise((r) => setTimeout(r, 50));
  const db = new DatabaseSync(copy, { readOnly: true });
  assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  db.close();
  for (const table of ["edits", "flags", "live_album_seen", "live_albums", "user_keys"]) assert.ok(tables.includes(table), `missing ${table}`);
  assert.ok(!existsSync(join(dataDir, "snapshot.tmp")), "temporary copy left behind");
});

test("removing the last live album deletes its key in Immich; the albums and photos stay", async () => {
  const list = (await call("GET", "/live-albums", { cookie: COOKIE.A })).body as any[];
  const familyAlbum = list.find((l) => l.id === family).albumId;
  for (const l of list) assert.equal((await call("DELETE", `/live-albums/${l.id}`, { cookie: COOKIE.A, json: {} })).status, 204);
  assert.deepEqual((await call("GET", "/live-albums", { cookie: COOKIE.A })).body, []);
  assert.equal(keysOf(A.id).filter((k) => !k.revoked).length, 0);
  assert.ok(albums.get(familyAlbum)!.assets.size > 0);
});
