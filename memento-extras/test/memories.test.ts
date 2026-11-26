// Themed memories end to end: the real service against a fake Immich. Run: npm test

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { call as callService, COOKIE, freePort, json, listen, readBody, Service, type CallOptions } from "./helpers.ts";

const A = { id: randomUUID(), name: "A", isAdmin: true };
const B = { id: randomUUID(), name: "B", isAdmin: false };
const PARTNER = randomUUID();
const MOM = randomUUID();
const DAD = randomUUID();
const EX = randomUUID();
const PEOPLE = [
  { id: MOM, name: "Mom", isHidden: false, birthDate: null, ownerId: A.id },
  { id: DAD, name: "Dad", isHidden: false, birthDate: null, ownerId: A.id },
  { id: EX, name: "Ex", isHidden: true, birthDate: null, ownerId: A.id },
  { id: randomUUID(), name: "", isHidden: false, birthDate: null, ownerId: A.id },
];

type FakeAsset = {
  trashed?: boolean;
  id: string; ownerId: string; type: "IMAGE" | "VIDEO"; takenAt: string; offsetH: number; favorite: boolean; rating: number | null;
  make: string | null; fileName: string; mime: string; people: string[]; duplicateId: string | null; durationMs: number | null;
  lat: number | null; lon: number | null; city: string | null; state: string | null; visibility: string;
};
const assets = new Map<string, FakeAsset>();
const stacks: Array<{ id: string; primaryAssetId: string; assets: string[] }> = [];

function asset(localTime: string, over: Partial<FakeAsset> = {}): string {
  const id = randomUUID();
  const takenAt = new Date(Date.parse(`${localTime}:00Z`) - 5.5 * 3_600_000).toISOString();
  assets.set(id, {
    id, ownerId: A.id, type: "IMAGE", takenAt, offsetH: 5.5, favorite: false, rating: null, make: "Google", fileName: `PXL_${id.slice(0, 8)}.jpg`,
    mime: "image/jpeg", people: [], duplicateId: null, durationMs: null, lat: null, lon: null, city: null, state: null, visibility: "timeline", ...over,
  });
  return id;
}
const pad = (n: number) => String(n).padStart(2, "0");
const HOME = { lat: 18.5204, lon: 73.8567, city: "Pune", state: "Maharashtra" };
const goa = (city: string) => ({ lat: 15.5, lon: 73.83, city, state: "Goa" });

for (let d = 1; d <= 12; d++) asset(`2026-09-${pad(d)}T18:00`, HOME);
for (let d = 1; d <= 31; d++) {
  if (d >= 20 && d <= 23) continue;
  asset(`2026-10-${pad(d)}T11:00`, { people: d % 3 === 0 ? [MOM] : [] });
  asset(`2026-10-${pad(d)}T17:30`);
}
const earlyOctober = asset("2026-10-01T01:00", { favorite: true, rating: 5, people: [MOM] });
const earlyNovember = asset("2026-11-01T00:30", { favorite: true, rating: 5 });
const blurry = new Set<string>();
const blurredFavourite = asset("2026-10-15T15:00", { favorite: true, rating: 5, people: [MOM] });
blurry.add(blurredFavourite);
for (let d = 2; d <= 26; d++) asset(`2026-11-${pad(d)}T12:00`);
for (let i = 0; i < 35; i++) asset(`2026-11-30T${pad(8 + Math.floor(i / 4))}:${pad((i % 4) * 15)}`, { fileName: `Screenshot_${i}.png`, mime: "image/png", make: null });
const tripIds: string[] = [];
asset("2026-10-21T19:00", { type: "VIDEO", durationMs: 8000, mime: "video/mp4", fileName: "PXL_trip.mp4" });
for (let d = 20; d <= 23; d++) {
  for (let h = 0; h < 8; h++) {
    const where = h % 3 === 0 ? goa(["Panaji", "Calangute", "Margao"][h % 3 === 0 ? (d + h) % 3 : 0]!) : {};
    tripIds.push(asset(`2026-10-${d}T${pad(9 + h)}:00`, where));
  }
}
const burst = [0, 5, 10, 15].map((s, i) => asset(`2026-10-21T08:00`, { takenAt: new Date(Date.parse("2026-10-21T02:30:00Z") + s * 1000).toISOString(), favorite: i === 1 }));
const dupA = asset("2026-10-22T07:00", { duplicateId: "dup1", rating: 4 });
const dupB = asset("2026-10-22T07:20", { duplicateId: "dup1", rating: 5 });
const screenshot = asset("2026-10-21T20:00", { fileName: "Screenshot_20261021-200000.png", mime: "image/png", make: null, favorite: true });
const forwarded = asset("2026-10-22T21:00", { fileName: "IMG-20261022-WA0001.jpg", make: null, favorite: false });
const withEx = asset("2026-10-22T22:00", { people: [EX], favorite: true, rating: 5 });
const stackedUnder = asset("2026-10-23T07:30", { favorite: true, rating: 5 });
const stackTop = asset("2026-10-23T07:31");
stacks.push({ id: randomUUID(), primaryAssetId: stackTop, assets: [stackTop, stackedUnder] });
const stackedBurst = [0, 1, 2, 3, 4].map((s) =>
  asset("2026-10-22T16:20", { takenAt: new Date(Date.parse("2026-10-22T10:50:00Z") + s * 1000).toISOString(), people: [MOM], favorite: s === 0, fileName: `PXL_BURST_${s}.jpg` }));
stacks.push({ id: randomUUID(), primaryAssetId: stackedBurst[0]!, assets: stackedBurst });
const partners = asset("2026-10-22T12:30", { ownerId: PARTNER, favorite: true, rating: 5 });
const archived = asset("2026-10-21T12:30", { visibility: "archive", favorite: true });
asset("2026-10-24T20:00", HOME);
const momIds: string[] = [];
for (let i = 0; i < 45; i++) momIds.push(asset(`${new Date(Date.UTC(2024, 0, 3 + i * 14)).toISOString().slice(0, 10)}T10:00`, { people: [MOM] }));
for (let i = 0; i < 5; i++) asset(`2025-02-${pad(i + 1)}T10:00`, { people: [DAD] });
for (const day of ["2024-03-09", "2026-11-07"]) for (let i = 0; i < 35; i++) asset(`${day}T${pad(8 + Math.floor(i / 4))}:${pad((i % 4) * 15)}`);
asset("2026-10-15T10:00", { ownerId: B.id });

// --- the fake Immich ---

type FakeKey = { id: string; secret: string; userId: string; permissions: string[]; revoked: boolean };
const keys = new Map<string, FakeKey>();
const memories: Array<{ id: string; ownerId: string; body: any; assetIds: string[] }> = [];
const calls: string[] = [];
let refuseMemories = 0;
let memoryPosts = 0;
let immichDelayMs = 0;
let uploadFailures = 0;
let originalHeld: Promise<void> = Promise.resolve();
const uploads: Array<{ id: string; filename: string; fileCreatedAt: string; checksum: string }> = [];
const albums = new Map<string, { id: string; albumName: string; ownerId: string; assets: Set<string> }>();
const tags = new Map<string, { id: string; value: string; ownerId: string; assets: Set<string> }>();

function caller(req: IncomingMessage): { userId: string; key?: FakeKey } | null {
  if (req.headers.cookie === COOKIE.A) return { userId: A.id };
  if (req.headers.cookie === COOKIE.B) return { userId: B.id };
  const key = keys.get(String(req.headers["x-api-key"] ?? ""));
  return key && !key.revoked ? { userId: key.userId, key } : null;
}

const local = (a: FakeAsset) => new Date(Date.parse(a.takenAt) + a.offsetH * 3_600_000).toISOString();
const visibleInTimeline = (a: FakeAsset, userId: string) =>
  a.ownerId === userId && a.visibility === "timeline" && !stacks.some((s) => s.primaryAssetId !== a.id && s.assets.includes(a.id));

const FILTER_KEYS = new Set(["takenAt", "visibility", "personIds"]);
function assetJson(a: FakeAsset, withExif: boolean, withPeople: boolean) {
  return {
    id: a.id, ownerId: a.ownerId, type: a.type, fileCreatedAt: a.takenAt, localDateTime: local(a), isFavorite: a.favorite, duration: a.durationMs,
    originalFileName: a.fileName, originalMimeType: a.mime, duplicateId: a.duplicateId, width: a.type === "VIDEO" ? 1920 : 4000, height: a.type === "VIDEO" ? 1080 : 3000, visibility: a.visibility,
    ...(withExif ? { exifInfo: { make: a.make, model: a.make ? "Pixel 9" : null, rating: a.rating, exifImageWidth: a.type === "VIDEO" ? 1920 : 4000, exifImageHeight: a.type === "VIDEO" ? 1080 : 3000, latitude: a.lat, longitude: a.lon, city: a.city, state: a.state, country: a.city ? "India" : null } } : {}),
    ...(withPeople ? { people: a.people.map((p) => { const person = PEOPLE.find((x) => x.id === p)!; return { id: p, name: person.name, isHidden: person.isHidden }; }) } : {}),
  };
}

const PERMISSION: Array<[string, RegExp, string]> = [
  ["GET", /^\/api\/timeline\/buckets$/, "asset.read"],
  ["GET", /^\/api\/timeline\/bucket$/, "asset.read"],
  ["POST", /^\/api\/search\/metadata$/, "asset.read"],
  ["GET", /^\/api\/people$/, "person.read"],
  ["POST", /^\/api\/memories$/, "memory.create"],
  ["GET", /^\/api\/users\/me$/, "user.read"],
  ["GET", /^\/api\/assets\/[^/]+\/thumbnail$/, "asset.view"],
  ["GET", /^\/api\/assets\/[^/]+\/video\/playback$/, "asset.view"],
  ["GET", /^\/api\/faces$/, "face.read"],
  ["POST", /^\/api\/assets$/, "asset.upload"],
  ["PUT", /^\/api\/tags$/, "tag.create"],
  ["PUT", /^\/api\/tags\/[^/]+\/assets$/, "tag.asset"],
  ["GET", /^\/api\/albums\/[^/]+$/, "album.read"],
  ["POST", /^\/api\/albums$/, "album.create"],
  ["PUT", /^\/api\/albums\/[^/]+\/assets$/, "albumAsset.create"],
  ["GET", /^\/api\/assets\/[^/]+$/, "asset.read"],
];

async function fakeImmich(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  calls.push(`${req.method} ${path}`);
  if (immichDelayMs) await new Promise((r) => setTimeout(r, immichDelayMs));
  const who = caller(req);
  if (!who) return json(res, 401, { message: "Invalid API key" });
  if (who.key) {
    const needed = PERMISSION.find(([m, p]) => m === req.method && p.test(path))?.[2];
    if (!needed || !(who.key.permissions.includes(needed) || who.key.permissions.includes("all"))) return json(res, 403, { message: `Missing permission ${needed}` });
  }
  const userId = who.userId;

  if (req.method === "GET" && path === "/api/users/me") return json(res, 200, userId === A.id ? A : B);

  if (req.method === "POST" && path === "/api/api-keys") {
    if (who.key) return json(res, 403, {});
    const b = JSON.parse(await readBody(req));
    const key: FakeKey = { id: randomUUID(), secret: randomBytes(24).toString("hex"), userId, permissions: b.permissions, revoked: false };
    keys.set(key.secret, key);
    return json(res, 201, { id: key.id, secret: key.secret });
  }
  const keyMatch = /^\/api\/api-keys\/([^/]+)$/.exec(path);
  if (req.method === "DELETE" && keyMatch) {
    if (who.key) return json(res, 403, {});
    for (const [secret, k] of keys) if (k.id === keyMatch[1] && k.userId === userId) keys.delete(secret);
    return json(res, 204);
  }

  if (req.method === "GET" && path === "/api/timeline/buckets") {
    assert.equal(url.searchParams.get("visibility"), "timeline");
    const person = url.searchParams.get("personId");
    const counts = new Map<string, number>();
    for (const a of assets.values()) {
      if (!visibleInTimeline(a, userId) || (person && !a.people.includes(person))) continue;
      const month = `${local(a).slice(0, 7)}-01`;
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return json(res, 200, [...counts].sort((x, y) => y[0].localeCompare(x[0])).map(([timeBucket, count]) => ({ timeBucket, count })));
  }
  if (req.method === "GET" && path === "/api/timeline/bucket") {
    const month = url.searchParams.get("timeBucket")!.slice(0, 7);
    const person = url.searchParams.get("personId");
    const list = [...assets.values()].filter((a) => visibleInTimeline(a, userId) && local(a).startsWith(month) && (!person || a.people.includes(person)));
    return json(res, 200, {
      id: list.map((a) => a.id), ownerId: list.map((a) => a.ownerId), isFavorite: list.map((a) => a.favorite), isImage: list.map((a) => a.type === "IMAGE"),
      fileCreatedAt: list.map((a) => a.takenAt.replace(/\.\d+Z$/, "")),
      localOffsetHours: list.map((a) => a.offsetH), city: list.map((a) => a.city), latitude: list.map((a) => a.lat), longitude: list.map((a) => a.lon),
    });
  }
  if (req.method === "POST" && path === "/api/search/metadata") {
    const b = JSON.parse(await readBody(req));
    for (const key of Object.keys(b.filter ?? {})) if (!FILTER_KEYS.has(key)) return json(res, 400, { message: `unknown filter ${key}` });
    for (const flat of ["takenAfter", "takenBefore", "personIds", "page", "visibility"]) if (flat in b) return json(res, 400, { message: `flat field ${flat}` });
    const f = b.filter;
    const found = [...assets.values()]
      .filter((a) => a.ownerId === userId || (userId === A.id && a.ownerId === PARTNER))
      .filter((a) => !f.takenAt?.gte || a.takenAt >= f.takenAt.gte)
      .filter((a) => !f.takenAt?.lt || a.takenAt < f.takenAt.lt)
      .filter((a) => !f.visibility?.in || f.visibility.in.includes(a.visibility))
      .filter((a) => !f.personIds?.any || f.personIds.any.some((p: string) => a.people.includes(p)))
      .sort((x, y) => x.takenAt.localeCompare(y.takenAt));
    const offset = b.cursor ? Number(b.cursor) : 0;
    const page = 40;
    const items = found.slice(offset, offset + page).map((a) => assetJson(a, b.withExif === true, b.withPeople === true));
    return json(res, 200, { assets: { items, nextCursor: offset + page < found.length ? String(offset + page) : null } });
  }
  if (req.method === "GET" && path === "/api/people") {
    return json(res, 200, { people: PEOPLE.filter((p) => p.ownerId === userId && !p.isHidden), hasNextPage: false });
  }
  const one = /^\/api\/assets\/([^/]+)$/.exec(path);
  if (req.method === "GET" && one) {
    const a = assets.get(one[1]!);
    if (!a || a.ownerId !== userId || a.visibility === "locked") return json(res, 400, { message: "Not found or no access" });
    return json(res, 200, { ...assetJson(a, true, false), isTrashed: a.trashed === true });
  }
  if (req.method === "POST" && path === "/api/memories") {
    const b = JSON.parse(await readBody(req));
    memoryPosts++;
    if (refuseMemories) return json(res, refuseMemories, { message: "no" });
    assert.equal(b.type, "on_this_day");
    assert.ok(Number.isInteger(b.data.year) && b.data.year >= 1000 && b.data.year <= 9999);
    for (const field of ["memoryAt", "showAt", "hideAt"]) assert.match(b[field], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const owned = (b.assetIds as string[]).filter((id) => assets.get(id)?.ownerId === userId);
    const memory = { id: randomUUID(), ownerId: userId, body: b, assetIds: owned };
    memories.push(memory);
    return json(res, 201, { id: memory.id, assets: owned.map((id) => ({ id })) });
  }
  const original = /^\/api\/assets\/([^/]+)\/original$/.exec(path);
  if (req.method === "GET" && original) {
    await originalHeld;
    return json(res, 500, { message: "the disk failed" });
  }
  const thumb = /^\/api\/assets\/([^/]+)\/thumbnail$/.exec(path);
  if (req.method === "GET" && thumb) {
    if (assets.get(thumb[1]!)?.ownerId !== userId) return json(res, 400, {});
    if (url.searchParams.get("edited") !== "true") return json(res, 400, { message: "the unedited image was asked for" });
    res.writeHead(200, { "content-type": "image/webp" }).end(`${url.searchParams.get("size")}:${thumb[1]}`);
    return;
  }
  const playback = /^\/api\/assets\/([^/]+)\/video\/playback$/.exec(path);
  if (req.method === "GET" && playback) {
    if (assets.get(playback[1]!)?.ownerId !== userId) return json(res, 400, {});
    res.writeHead(200, { "content-type": "video/mp4" }).end(`video:${playback[1]}`);
    return;
  }
  if (req.method === "GET" && path === "/api/faces") {
    const a = assets.get(url.searchParams.get("id")!);
    if (a?.ownerId !== userId) return json(res, 400, {});
    return json(res, 200, a.people.map((p, i) => ({
      id: randomUUID(), imageWidth: 1000, imageHeight: 750, boundingBoxX1: 100 + i * 300, boundingBoxY1: 100, boundingBoxX2: 300 + i * 300, boundingBoxY2: 350, person: { id: p },
    })));
  }
  if (req.method === "POST" && path === "/api/assets") {
    if (uploadFailures > 0) {
      uploadFailures--;
      return json(res, 500, { message: "storage full" });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
    const bytes = Buffer.from(await (form.get("assetData") as Blob).arrayBuffer());
    const checksum = createHash("sha1").update(bytes).digest("hex");
    const known = uploads.find((u) => u.checksum === checksum);
    if (known) return json(res, 200, { id: known.id, status: "duplicate" });
    const filename = String(form.get("filename"));
    const fileCreatedAt = String(form.get("fileCreatedAt"));
    const id = asset("2026-01-01T00:00", { takenAt: fileCreatedAt, ownerId: userId, make: null, fileName: filename, mime: "image/jpeg" });
    uploads.push({ id, filename, fileCreatedAt, checksum });
    return json(res, 201, { id, status: "created" });
  }
  if (req.method === "PUT" && path === "/api/tags") {
    const { tags: names } = JSON.parse(await readBody(req)) as { tags: string[] };
    return json(res, 200, names.map((value) => {
      const tag = [...tags.values()].find((x) => x.value === value && x.ownerId === userId) ?? { id: randomUUID(), value, ownerId: userId, assets: new Set<string>() };
      tags.set(tag.id, tag);
      return { id: tag.id, value };
    }));
  }
  const tagAssets = /^\/api\/tags\/([^/]+)\/assets$/.exec(path);
  if (req.method === "PUT" && tagAssets) {
    const tag = tags.get(tagAssets[1]!);
    if (tag?.ownerId !== userId) return json(res, 400, {});
    const { ids } = JSON.parse(await readBody(req)) as { ids: string[] };
    for (const id of ids) tag.assets.add(id);
    return json(res, 200, ids.map((id) => ({ id, success: true })));
  }
  if (req.method === "POST" && path === "/api/albums") {
    const album = { id: randomUUID(), albumName: JSON.parse(await readBody(req)).albumName, ownerId: userId, assets: new Set<string>() };
    albums.set(album.id, album);
    return json(res, 201, { id: album.id, albumName: album.albumName, albumUsers: [{ role: "owner", user: { id: userId } }] });
  }
  const album = /^\/api\/albums\/([^/]+)(\/assets)?$/.exec(path);
  if (album) {
    const found = albums.get(album[1]!);
    if (found?.ownerId !== userId) return json(res, 400, { message: "Not found or no access" });
    if (req.method === "GET" && !album[2]) return json(res, 200, { id: found.id, albumName: found.albumName, albumUsers: [{ role: "owner", user: { id: userId } }] });
    const { ids } = JSON.parse(await readBody(req)) as { ids: string[] };
    return json(res, 200, ids.map((id) => {
      const fresh = !found.assets.has(id);
      found.assets.add(id);
      return fresh ? { id, success: true } : { id, success: false, error: "duplicate" };
    }));
  }
  json(res, 404, { message: `fake Immich has no ${req.method} ${path}` });
}

// --- the fake creations container ---

const renders: any[] = [];
const measured: string[] = [];
const states = new Map<string, any>();
let containerDown = false;
let failNextRender = false;
let notABurst = false;
let noSubject = false;
let busy = false;
let mostAtOnce = 0;

async function fakeContainer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (containerDown) return void req.socket.destroy();
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, busy });
  const status = /^\/renders\/(.+)$/.exec(req.url ?? "");
  if (req.method === "GET" && status) return states.has(status[1]!) ? json(res, 200, states.get(status[1]!)) : json(res, 404, {});
  const body = JSON.parse(await readBody(req));
  if (busy) return json(res, 429, { error: "busy" });
  const dir = join(workDir, body.id);
  if (req.url === "/quality") {
    const results = (body.files as string[]).map((f) => {
      const assetId = readFileSync(join(dir, f), "utf8").split(":")[1]!;
      measured.push(assetId);
      return blurry.has(assetId) ? { sharpness: 4, brightness: 120, p2: 20, p98: 220 } : { sharpness: 300, brightness: 128, p2: 20, p98: 230 };
    });
    return json(res, 200, { results, ms: 1 });
  }
  busy = true;
  mostAtOnce = Math.max(mostAtOnce, renders.filter((r) => states.get(r.id)?.state === "running").length + 1);
  renders.push(body);
  states.set(body.id, { state: "running" });
  json(res, 202, { state: "running" });
  setTimeout(() => {
    busy = false;
    if (failNextRender) {
      failNextRender = false;
      return states.set(body.id, { state: "failed", error: "ffmpeg was stopped by the system, most likely for running out of memory" });
    }
    if (notABurst && body.kind === "animation") {
      notABurst = false;
      return states.set(body.id, { state: "unsuitable", error: "its photos aren't one burst of near-identical shots" });
    }
    if (noSubject && body.kind === "cinematic") {
      noSubject = false;
      return states.set(body.id, { state: "unsuitable", error: "it has no clear subject in front of a background" });
    }
    const file = { collage: "collage.jpg", recap: "recap.mp4", animation: "animation.mp4", cinematic: "cinematic.mp4" }[body.kind as string]!;
    const photos = (body.kind === "cinematic" ? [body.photo] : body.kind === "recap" ? body.items : body.photos) as Array<{ file: string }>;
    const inputs = (body.kind === "animation" ? body.frames : photos.map((p) => p.file)) as string[];
    const content = `${body.kind}:${inputs.map((f) => readFileSync(join(dir, f), "utf8")).join(",")}`;
    body.content = content;
    writeFileSync(join(dir, file), content);
    states.set(body.id, { state: "done", file, bytes: content.length, ms: 50 });
  }, 100);
}

let immich: Server;
let container: Server;
let dataDir: string;
let workDir: string;
let port: number;
let env: Record<string, string>;
let service: Service;

async function night(day: string): Promise<void> {
  await service.stop();
  service = new Service(port, { ...env, MEMORIES_TODAY: day });
  await service.start();
}

before(async () => {
  immich = createServer((req, res) => void fakeImmich(req, res).catch((e) => json(res, 500, { message: String(e) })));
  const immichPort = await listen(immich);
  dataDir = mkdtempSync(join(tmpdir(), "memories-test-"));
  workDir = join(dataDir, "work");
  mkdirSync(workDir);
  container = createServer((req, res) => void fakeContainer(req, res).catch((e) => json(res, 500, { error: String(e) })));
  const containerPort = await listen(container);
  port = await freePort();
  env = {
    GEMINI_API_KEY: "unused", IMMICH_URL: `http://127.0.0.1:${immichPort}`, DATA_DIR: dataDir, LIMITS_TIMEZONE: "Asia/Kolkata",
    MEMENTO_SECRET: randomBytes(32).toString("base64"), MEMORIES_CHECK_SECONDS: "0", LIVE_ALBUMS_INTERVAL_SECONDS: "3600", READER_URL: "http://127.0.0.1:9",
    CREATIONS_URL: `http://127.0.0.1:${containerPort}`, CREATIONS_WORK_DIR: workDir, CREATIONS_CHECK_SECONDS: "1", RENDER_QUIET_HOURS: "",
  };
  service = new Service(port, { ...env, MEMORIES_TODAY: "2026-11-01" });
  await service.start();
});

after(async () => {
  await service.stop();
  immich.close();
  container.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (method: string, path: string, opts?: CallOptions) => callService(service.base, method, path, opts);
const keysOf = (userId: string) => [...keys.values()].filter((k) => k.userId === userId);
const memoryOf = (id: string) => memories.find((m) => m.id === id)!;

function jobs(): Array<{ id: number; kind: string; state: string; attempts: number; asset_id: string | null; last_error: string | null; theme: string; inputs: string }> {
  const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
  const rows = db.prepare("SELECT j.*, m.theme FROM creation_jobs j JOIN themed_memories m ON m.id = j.themed_memory_id ORDER BY j.id").all() as any[];
  db.close();
  return rows;
}

function cards(): Array<{ id: number; status: string; memory_id: string | null; week: string }> {
  return sqlAll("SELECT id, status, memory_id, week FROM creation_cards ORDER BY id") as any;
}

function collageJob() {
  return jobs().find((j) => j.theme === "big_day" && j.kind === "collage" && j.state !== "skipped" && j.state !== "proposed")!;
}

function sqlAll(statement: string): unknown[] {
  const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
  const rows = db.prepare(statement).all().map((r) => ({ ...r }));
  db.close();
  return rows;
}

function sql(statement: string, ...params: Array<string | number>): void {
  const db = new DatabaseSync(join(dataDir, "data.db"));
  db.prepare(statement).run(...params);
  db.close();
}

async function until(what: string, check: () => boolean, ms = 8000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (check()) return;
  assert.fail(`waited for ${what}`);
}

test("off until the person turns it on; settings need a logged-in app, not an API key", async () => {
  assert.equal((await call("GET", "/memories/settings")).status, 401);
  assert.deepEqual((await call("GET", "/memories/settings", { cookie: COOKIE.A })).body, { enabled: false, creations: true, pausedReason: null, lastRunDay: null });
  assert.equal((await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} })).status, 409);
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { colour: true } })).status, 400);
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { enabled: "yes" } })).status, 400);
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: {} })).status, 400);
  const fullKey: FakeKey = { id: "full", secret: "fullaccesskeyfora0123456789", userId: A.id, permissions: ["all"], revoked: false };
  keys.set(fullKey.secret, fullKey);
  assert.equal((await call("PUT", "/memories/settings", { apiKey: fullKey.secret, json: { enabled: true } })).status, 403);
  keys.delete(fullKey.secret);
});

test("turning on makes a key with only the permissions memories need, stored encrypted", async () => {
  const res = await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { enabled: true } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { enabled: true, creations: true, pausedReason: null, lastRunDay: null });
  const [key] = keysOf(A.id);
  assert.deepEqual(key!.permissions.toSorted(), [
    "album.create", "album.read", "albumAsset.create", "asset.read", "asset.upload", "asset.view", "face.read", "memory.create",
    "person.read", "tag.asset", "tag.create",
  ]);
  const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
  const row = db.prepare("SELECT sealed FROM memory_users WHERE user_id = ?").get(A.id) as { sealed: string };
  db.close();
  assert.ok(!Buffer.from(row.sealed, "base64").toString("latin1").includes(key!.secret), "key stored in the clear");
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { enabled: true } })).status, 200);
  assert.equal(keysOf(A.id).length, 1);
});

test("1 November: the Goa trip and Best of October, at most two a night", async () => {
  const res = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.made.map((m: any) => [m.theme, m.label]), [["trip", "Goa trip, 2026"], ["month", "Best of October"]]);
  const [trip, month] = res.body.made.map((m: any) => memoryOf(m.memoryId));

  const tripAssets = trip!.assetIds.map((id: string) => assets.get(id)!);
  assert.ok(tripAssets.every((a: FakeAsset) => local(a) >= "2026-10-20" && local(a) < "2026-10-24"));
  for (const never of [screenshot, forwarded, withEx, stackedUnder, partners, archived, dupA]) {
    assert.ok(!trip!.assetIds.includes(never) && !month!.assetIds.includes(never), `picked ${never}`);
  }
  assert.ok(trip!.body.assetIds.every((id: string) => assets.get(id)!.ownerId === A.id), "a partner's photo was sent");
  assert.ok(trip!.assetIds.includes(dupB), "the better duplicate");
  assert.deepEqual(burst.filter((id) => trip!.assetIds.includes(id)), [burst[1]], "one of the burst: the favourite");
  assert.equal(new Set(tripAssets.map((a: FakeAsset) => local(a).slice(0, 10))).size, 4, "every day of the trip");

  assert.deepEqual(
    [trip!.body.memoryAt, trip!.body.showAt, trip!.body.hideAt, trip!.body.data.year],
    [`${local(tripAssets[0]!).slice(0, 10)}T00:00:00.000Z`, "2026-11-01T00:00:00.000Z", "2026-11-03T23:59:59.999Z", 2026],
  );

  assert.ok(month!.assetIds.includes(earlyOctober), "the early-morning favourite of 1 October");
  assert.ok(!month!.assetIds.includes(earlyNovember));
  assert.equal(month!.body.memoryAt, "2026-10-01T00:00:00.000Z");
  assert.ok(month!.assetIds.every((id: string) => !trip!.assetIds.includes(id)), "trip photos not repeated in the same night");

  const labels = await call("GET", "/memories/labels", { cookie: COOKIE.A });
  assert.deepEqual(new Set(labels.body.memories.map((m: any) => m.label)), new Set(["Goa trip, 2026", "Best of October"]));
  assert.deepEqual((await call("GET", "/memories/labels", { cookie: COOKIE.B })).body, { memories: [] });

  const again = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  assert.equal(again.status, 429);
  assert.match(again.body.error, /Try again in 10 minutes/);
});

test("quality: a blurred favourite is left out; each photo measured once, only a shortlist", async () => {
  const month = memories[1]!;
  assert.ok(!month.assetIds.includes(blurredFavourite), "the blurred favourite");
  assert.ok(measured.includes(blurredFavourite));
  assert.equal(new Set(measured).size, measured.length, "a photo measured twice");
  assert.ok(measured.length <= 2 * 120, "more than the shortlists");
  assert.ok(!measured.includes(screenshot) && !measured.includes(partners), "measured one that can't be used anyway");
});

test("Sunday 1 November: the week's best memory (the trip) gets a card: its collage, then its recap, then its photos with its animation and cinematic photo", async () => {
  await until("the card", () => cards().some((c) => c.status === "created"));
  assert.deepEqual(jobs().map((j) => [j.theme, j.kind, j.state]).sort(), [
    ["month", "animation", "skipped"], ["month", "cinematic", "skipped"], ["month", "recap", "skipped"],
    ["trip", "animation", "done"], ["trip", "cinematic", "done"], ["trip", "collage", "done"], ["trip", "recap", "done"],
  ], "Best of October's lost the weekly pick to the trip's");
  const trip = memories[0]!;
  assert.equal(renders.length, 4);
  const collage = renders.find((r) => r.kind === "collage");
  assert.equal(collage.photos.length, 6, "six of the trip's photos");
  const first = assets.get(trip.assetIds[0]!)!;
  const before = (s: number) => new Date(Date.parse(local(first)) - s * 1000).toISOString().slice(0, 19);
  assert.deepEqual(collage.stamp, { local: before(2), offset: "+05:30", gps: { lat: 15.5, lon: 73.83 } });
  const recap = renders.find((r) => r.kind === "recap");
  assert.equal(recap.stamp.local, before(1), "a second after the collage, a second before the first photo");
  assert.ok(recap.items.filter((i: any) => i.kind === "photo").length >= 8);
  assert.deepEqual(recap.items.filter((i: any) => i.kind === "video").map((i: any) => i.durationMs), [8000]);

  const [collageJob, recapJob] = ["collage", "recap"].map((k) => jobs().find((j) => j.kind === k && j.state === "done")!);
  const image = uploads.find((u) => u.id === collageJob!.asset_id)!;
  const video = uploads.find((u) => u.id === recapJob!.asset_id)!;
  assert.match(image.filename, /^memento-collage-20261020-\d+\.jpg$/);
  assert.match(video.filename, /^memento-recap-20261020-\d+\.mp4$/);
  assert.equal(image.fileCreatedAt, new Date(Date.parse(first.takenAt) - 2000).toISOString());
  const tag = [...tags.values()].find((x) => x.value === "Memento/Creations")!;
  assert.ok(tag.assets.has(image.id) && tag.assets.has(video.id));
  assert.deepEqual([...[...albums.values()].find((a) => a.albumName === "Collages")!.assets], [image.id]);
  assert.deepEqual([...[...albums.values()].find((a) => a.albumName === "Recaps")!.assets], [video.id]);

  const animation = renders.find((r) => r.kind === "animation");
  assert.equal(animation.content, `animation:${stackedBurst.map((id) => `preview:${id}`).join(",")}`);
  const animationJob = jobs().find((j) => j.kind === "animation" && j.state === "done")!;
  const loop = uploads.find((u) => u.id === animationJob.asset_id)!;
  assert.match(loop.filename, /^memento-animation-20261022-\d+\.mp4$/);
  assert.equal(loop.fileCreatedAt, assets.get(stackedBurst[0]!)!.takenAt);
  assert.ok(tag.assets.has(loop.id));
  assert.deepEqual([...[...albums.values()].find((a) => a.albumName === "Animations")!.assets], [loop.id]);

  const cinematic = renders.find((r) => r.kind === "cinematic");
  const source = /^cinematic:preview:(.+)$/.exec(cinematic.content)![1]!;
  assert.ok(trip.assetIds.includes(source));
  const people = assets.get(source)!.people.length;
  assert.ok(people >= 1 && people <= 2, `a clear subject: ${people} people`);
  assert.equal(cinematic.photo.faces.length, people);
  const cinematicJob = jobs().find((j) => j.kind === "cinematic" && j.state === "done")!;
  const still = uploads.find((u) => u.id === cinematicJob.asset_id)!;
  assert.match(still.filename, /^memento-cinematic-202610\d\d-\d+\.mp4$/);
  assert.equal(still.fileCreatedAt, assets.get(source)!.takenAt);
  assert.ok(tag.assets.has(still.id));
  assert.deepEqual([...[...albums.values()].find((a) => a.albumName === "Cinematic")!.assets], [still.id]);
  const photosWithFaces = renders.filter((r) => r.kind !== "animation")
    .flatMap((r) => r.kind === "cinematic" ? [r.photo] : r.photos ?? r.items.filter((i: any) => i.kind === "photo")).length;
  assert.equal(calls.filter((c) => c === "GET /api/faces").length, photosWithFaces);

  const card = memoryOf(cards()[0]!.memory_id!);
  assert.deepEqual(card.body.assetIds.slice(0, 4), [image.id, video.id, loop.id, still.id]);
  assert.deepEqual(card.body.assetIds.slice(4).toSorted(), [...trip.assetIds].sort());
  assert.deepEqual([card.body.showAt, card.body.hideAt, card.body.memoryAt], ["2026-11-01T00:00:00.000Z", "2026-11-03T23:59:59.999Z", trip.body.memoryAt]);
  assert.ok(![image.id, video.id, loop.id, still.id].some((id) => trip.assetIds.includes(id)));
  const labels = (await call("GET", "/memories/labels", { cookie: COOKIE.A })).body.memories;
  assert.deepEqual(labels.filter((m: any) => m.memoryId === card.id).map((m: any) => m.label), ["Goa trip, 2026"]);
  assert.deepEqual(readdirSync(workDir), [], "job folders left behind");
  assert.equal(mostAtOnce, 1);
});

test("2 November: a Spotlight on Mom, from photos not used yesterday, and an older big day", async () => {
  await night("2026-11-02");
  const res = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  assert.deepEqual(res.body.made.map((m: any) => [m.theme, m.label]), [["spotlight", "Spotlight: Mom"], ["big_day", "9 March 2024"]]);
  const spot = memoryOf(res.body.made[0].memoryId);
  assert.ok(spot.assetIds.every((id) => assets.get(id)!.people.includes(MOM)));
  const used = memories.slice(0, 2).flatMap((m) => m.assetIds);
  assert.ok(spot.assetIds.every((id) => !used.includes(id)), "a photo from yesterday's memories again");
  assert.ok(spot.assetIds.length >= 10);
  assert.equal(spot.body.memoryAt.slice(0, 4), "2024");
  assert.equal(spot.body.data.year, 2026 - Math.round((Date.parse("2026-11-02") - Date.parse(spot.body.memoryAt)) / (365.25 * 86_400_000)));
});

test("the older big day: that day's photos only", async () => {
  const day = memories.find((m) => m.body.memoryAt === "2024-03-09T00:00:00.000Z")!;
  assert.ok(day.assetIds.length >= 6 && day.assetIds.every((id) => local(assets.get(id)!).startsWith("2024-03-09")));
  await night("2026-11-03");
  assert.deepEqual((await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} })).body.made, [], "nothing due on the 3rd");
});

test("one card a week: 2 November's memories only propose; Sunday 8 November's card is the week's best", async () => {
  assert.deepEqual(jobs().filter((j) => j.theme === "big_day").map((j) => [j.kind, j.state]), [["collage", "proposed"], ["recap", "proposed"], ["cinematic", "proposed"]], "not made on a weekday");
  await night("2026-11-08");
  const res = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  assert.deepEqual(res.body.made.map((m: any) => [m.theme, m.label]), [["big_day", "A day to remember"]]);
  assert.equal(res.body.creationsQueued, 3, "a collage, a recap and a cinematic photo (no burst that day)");
  const bigDayCollages = jobs().filter((j) => j.theme === "big_day" && j.kind === "collage").map((j) => j.state);
  assert.deepEqual([bigDayCollages.length, bigDayCollages.filter((s) => s === "skipped").length], [2, 1], "one chosen, one skipped");
  assert.ok(jobs().filter((j) => j.theme === "spotlight").every((j) => j.state === "skipped"), "a big day ranks above a Spotlight");
  await until("the week's card", () => cards().filter((c) => c.status === "created").length === 2);
  assert.equal(renders.length, 7, "one card a week");
  assert.equal((await call("POST", "/memories/run", { cookie: COOKIE.A, json: { creations: "yes" } })).status, 400);
});

test("the container down: nothing counted, it waits; a render that fails is retried after its backoff, into a new Collages album", async () => {
  const bigDay = collageJob();
  containerDown = true;
  sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), bigDay.id);
  const before = renders.length;
  await new Promise((r) => setTimeout(r, 2500));
  const waiting = jobs().find((j) => j.id === bigDay.id)!;
  assert.deepEqual([waiting.state, waiting.attempts, renders.length], ["queued", 0, before], "not started, nothing counted");
  containerDown = false;
  failNextRender = true;
  await until("a failed try", () => jobs().find((j) => j.id === bigDay.id)!.attempts === 1 && jobs().find((j) => j.id === bigDay.id)!.state === "queued");
  assert.match(jobs().find((j) => j.id === bigDay.id)!.last_error!, /out of memory/);
  for (const [id, a] of albums) if (a.albumName === "Collages") albums.delete(id);
  sql("UPDATE creation_jobs SET next_at = ? WHERE id = ?", new Date().toISOString(), bigDay.id);
  await until("the retry", () => jobs().find((j) => j.id === bigDay.id)!.state === "done");
  const collages = [...albums.values()].filter((a) => a.albumName === "Collages");
  assert.equal(collages.length, 1);
  assert.ok(collages[0]!.assets.has(jobs().find((j) => j.id === bigDay.id)!.asset_id!));
});

test("a failed upload keeps the finished file: only the upload is tried again", async () => {
  const bigDay = collageJob();
  uploadFailures = 1;
  sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), bigDay.id);
  const before = renders.length;
  await until("the failed upload", () => jobs().find((j) => j.id === bigDay.id)!.attempts === 1 && jobs().find((j) => j.id === bigDay.id)!.state === "queued");
  assert.equal(renders.length, before + 1);
  assert.equal(readdirSync(workDir).length, 1, "its folder kept, with the file");
  sql("UPDATE creation_jobs SET next_at = ? WHERE id = ?", new Date().toISOString(), bigDay.id);
  await until("uploaded", () => jobs().find((j) => j.id === bigDay.id)!.state === "done");
  assert.equal(renders.length, before + 1, "not rendered again");
  assert.deepEqual(readdirSync(workDir), []);
});

test("photos deleted or locked away since: left out; with too few left, the job is dropped", async () => {
  const bigDay = collageJob();
  const inputs = JSON.parse(jobs().find((j) => j.id === bigDay.id)!.inputs).items.map((i: any) => i.id) as string[];
  assets.get(inputs[0]!)!.trashed = true;
  assets.get(inputs[1]!)!.visibility = "locked";
  sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), bigDay.id);
  const before = renders.length;
  await until("rendered", () => renders.length === before + 1);
  assert.equal(renders.at(-1).photos.length, 4, "six minus two: a 4-photo collage");
  await until("done", () => jobs().find((j) => j.id === bigDay.id)!.state === "done");
  for (const id of inputs.slice(2, 5)) assets.get(id)!.trashed = true;
  sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), bigDay.id);
  await until("dropped", () => jobs().find((j) => j.id === bigDay.id)!.state === "dropped");
  assert.equal(jobs().find((j) => j.id === bigDay.id)!.last_error, "too few of its photos are left");
  assert.equal(renders.length, before + 1);
  for (const id of inputs) Object.assign(assets.get(id)!, { trashed: false, visibility: "timeline" });
  sql("UPDATE creation_jobs SET state = 'done', asset_id = ? WHERE id = ?", uploads.at(-1)!.id, bigDay.id);
});

test("an animation's photos deleted since: the rest are used, in order; fewer than three left, it's dropped", async () => {
  const job = jobs().find((j) => j.kind === "animation" && j.state === "done")!;
  const frames = JSON.parse(job.inputs).items.map((i: any) => i.id) as string[];
  assert.deepEqual(frames, stackedBurst);
  const requeue = () => sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), job.id);
  assets.get(frames[1]!)!.trashed = true;
  assets.get(frames[3]!)!.visibility = "locked";
  requeue();
  const before = renders.length;
  await until("done", () => jobs().find((j) => j.id === job.id)!.state === "done");
  assert.equal(renders.length, before + 1);
  assert.equal(renders.at(-1).content, `animation:${[0, 2, 4].map((i) => `preview:${frames[i]}`).join(",")}`);
  assets.get(frames[0]!)!.trashed = true;
  requeue();
  await until("dropped", () => jobs().find((j) => j.id === job.id)!.state === "dropped");
  assert.equal(jobs().find((j) => j.id === job.id)!.last_error, "too few of its photos are left");
  assert.equal(renders.length, before + 1);
  for (const id of frames) Object.assign(assets.get(id)!, { trashed: false, visibility: "timeline" });
  sql("UPDATE creation_jobs SET state = 'done', asset_id = ? WHERE id = ?", job.asset_id!, job.id);
});

test("an animation the container finds isn't a burst is dropped at once, not tried again", async () => {
  const job = jobs().find((j) => j.kind === "animation" && j.state === "done")!;
  notABurst = true;
  sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, work_id = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), job.id);
  const before = renders.length;
  await until("dropped", () => jobs().find((j) => j.id === job.id)!.state === "dropped");
  assert.match(jobs().find((j) => j.id === job.id)!.last_error!, /isn't one burst|aren't one burst/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(renders.length, before + 1, "tried once");
  assert.deepEqual(readdirSync(workDir), [], "its photos removed at once");
  sql("UPDATE creation_jobs SET state = 'done', asset_id = ? WHERE id = ?", job.asset_id!, job.id);
});

test("a cinematic photo the container finds has no clear subject is dropped at once, not tried again", async () => {
  const job = jobs().find((j) => j.kind === "cinematic" && j.state === "done")!;
  noSubject = true;
  sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, work_id = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), job.id);
  const before = renders.length;
  await until("dropped", () => jobs().find((j) => j.id === job.id)!.state === "dropped");
  assert.match(jobs().find((j) => j.id === job.id)!.last_error!, /no clear subject/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(renders.length, before + 1, "tried once");
  assert.deepEqual(readdirSync(workDir), [], "its photo removed at once");
  sql("UPDATE creation_jobs SET state = 'done', asset_id = ? WHERE id = ?", job.asset_id!, job.id);
});

test("a job a crash left running is picked up again after a restart, without rendering twice", async () => {
  const bigDay = collageJob();
  const before = renders.length;
  sql("UPDATE creation_jobs SET state = 'running' WHERE id = ?", bigDay.id);
  writeFileSync(join(workDir, "leftover"), "x");
  await night("2026-11-04");
  await until("the job done again", () => jobs().find((j) => j.id === bigDay.id)!.state === "done");
  assert.equal(renders.length, before, "already uploaded: not rendered again");
  assert.deepEqual(readdirSync(workDir), [], "leftovers cleared at start");
  sql("UPDATE creation_jobs SET state = 'running', attempts = 3, asset_id = NULL WHERE id = ?", bigDay.id);
  await night("2026-11-04");
  await until("dropped", () => jobs().find((j) => j.id === bigDay.id)!.state === "dropped");
  assert.equal(renders.length, before);
  sql("UPDATE creation_jobs SET state = 'done', attempts = 1, asset_id = ? WHERE id = ?", bigDay.asset_id!, bigDay.id);
});

test("a render still going when the service restarted is waited for, its folder left alone; once done, its file is kept", async () => {
  const bigDay = collageJob();
  const before = renders.length;
  const workId = randomUUID();
  const dir = join(workDir, workId);
  mkdirSync(dir);
  writeFileSync(join(dir, "0.webp"), "preview:one of its photos");
  states.set(workId, { state: "running" });
  busy = true;
  sql("UPDATE creation_jobs SET state = 'running', asset_id = NULL, rendered_at = NULL, attempts = 0, work_id = ?, next_at = ? WHERE id = ?", workId, new Date().toISOString(), bigDay.id);
  await night("2026-11-04");
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(jobs().find((j) => j.id === bigDay.id)!.state, "queued", "waits for the container");
  assert.ok(existsSync(join(dir, "0.webp")), "the render's folder left alone");
  const content = "collage:finished while the service restarted";
  writeFileSync(join(dir, "collage.jpg"), content);
  states.set(workId, { state: "done", file: "collage.jpg" });
  busy = false;
  await until("uploaded", () => jobs().find((j) => j.id === bigDay.id)!.state === "done");
  assert.equal(renders.length, before, "not rendered again");
  assert.equal(uploads.at(-1)!.checksum, createHash("sha1").update(content).digest("hex"), "the finished file was uploaded");
  assert.equal(jobs().find((j) => j.id === bigDay.id)!.asset_id, uploads.at(-1)!.id);
  assert.ok(!existsSync(dir));
});

test("a person's video being cleaned: no new render starts meanwhile, but an upload left to retry goes and its card is made", async () => {
  const bigDay = collageJob();
  const card = (jobs().find((j) => j.id === bigDay.id) as unknown as { card_id: number }).card_id;
  const other = jobs().find((j) => j.state === "done" && j.kind !== "animation" && (j as unknown as { card_id: number | null }).card_id !== card)!;
  assert.ok(other, "a finished job of another card");
  const before = renders.length;
  const memoriesBefore = memoryPosts;
  const video = asset("2026-10-05T10:00", { type: "VIDEO", fileName: "PXL_trip.mp4", mime: "video/mp4", durationMs: 30_000 });
  let letGo = () => {};
  originalHeld = new Promise((resolve) => (letGo = resolve));
  try {
    const started = await call("POST", `/videos/${video}/reduce-noise`, { cookie: COOKIE.A, json: {} });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until("the video's download started", () => calls.includes(`GET /api/assets/${video}/original`));
    sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, attempts = 0, next_at = ? WHERE id = ?", new Date(Date.now() - 60_000).toISOString(), other.id);
    const workId = randomUUID();
    mkdirSync(join(workDir, workId));
    writeFileSync(join(workDir, workId, "collage.jpg"), "collage:made before the video came");
    sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = ?, work_id = ?, attempts = 0, next_at = ? WHERE id = ?", new Date().toISOString(), workId, new Date().toISOString(), bigDay.id);
    sql("UPDATE creation_cards SET status = 'waiting', memory_id = NULL, attempts = 0, next_at = NULL WHERE id = ?", card);
    await until("the upload retried", () => jobs().find((j) => j.id === bigDay.id)!.state === "done");
    await until("its card made", () => cards().find((c) => c.id === card)!.status === "created");
    assert.equal(memoryPosts, memoriesBefore + 1);
    await new Promise((r) => setTimeout(r, 2500));
    const held = jobs().find((j) => j.id === other.id)!;
    assert.deepEqual([held.state, held.attempts, renders.length], ["queued", 0, before], "the render didn't start while the video was cleaned");
  } finally {
    letGo();
  }
  await until("the held render made", () => jobs().find((j) => j.id === other.id)!.state === "done");
  assert.equal(renders.length, before + 1);
  assets.delete(video);
});

test("the night captions' hours: no render starts, nor one that wouldn't end before them; turning creations off drops what's waiting", async () => {
  const bigDay = collageJob();
  const before = renders.length;
  const at = (minutes: number) => new Date(Date.now() + 5.5 * 3_600_000 + minutes * 60_000).toISOString().slice(11, 16);
  for (const quiet of ["00:00-23:59", `${at(5)}-${at(60)}`]) {
    await service.stop();
    service = new Service(port, { ...env, MEMORIES_TODAY: "2026-11-04", RENDER_QUIET_HOURS: quiet });
    await service.start();
    sql("UPDATE creation_jobs SET state = 'queued', asset_id = NULL, rendered_at = NULL, next_at = ? WHERE id = ?", new Date().toISOString(), bigDay.id);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(renders.length, before, quiet);
    assert.equal(jobs().find((j) => j.id === bigDay.id)!.state, "queued");
  }
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { creations: false } })).body.creations, false);
  await night("2026-11-04");
  await until("dropped", () => jobs().find((j) => j.id === bigDay.id)!.state === "dropped");
  assert.equal(renders.length, before);
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { creations: true } })).body.creations, true);
});

test("Immich refusing a memory: nothing recorded, tried again the next time", async () => {
  await night("2026-11-10");
  const db = new DatabaseSync(join(dataDir, "data.db"));
  db.prepare("DELETE FROM themed_memories WHERE theme_key = 'day:2024-03-09'").run();
  db.close();
  refuseMemories = 500;
  const refused = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  assert.deepEqual(refused.body.made, []);
  assert.deepEqual(refused.body.skipped, [{ theme: "big_day", reason: "Immich refused it" }]);
  refuseMemories = 0;
  containerDown = true;
  await night("2026-11-10");
  const retried = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  containerDown = false;
  assert.deepEqual(retried.body.made.map((m: any) => m.theme), ["big_day"]);
});

test("a card: Immich's 5xx is tried again after 30, then 60 minutes, then given up; a refusal fails it; creations turned off closes it as empty", async () => {
  const card = cards().find((c) => c.week === "2026-11-08")!;
  const row = () => sqlAll(`SELECT status, attempts, next_at FROM creation_cards WHERE id = ${card.id}`)[0] as { status: string; attempts: number; next_at: string };
  const status = () => row().status;
  const inMinutes = () => Math.round((Date.parse(row().next_at) - Date.now()) / 60_000);
  const reopen = () => sql("UPDATE creation_cards SET status = 'waiting', memory_id = NULL, attempts = 0, next_at = NULL WHERE id = ?", card.id);
  const due = () => sql("UPDATE creation_cards SET next_at = ? WHERE id = ?", new Date().toISOString(), card.id);
  const made = memories.length;
  const asked = memoryPosts;
  refuseMemories = 503;
  reopen();
  await until("a first try", () => row().attempts === 1);
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual([status(), memoryPosts - asked, inMinutes()], ["waiting", 1, 30], "not again at every look");
  due();
  await until("a second try", () => row().attempts === 2);
  assert.equal(inMinutes(), 60);
  due();
  await until("given up", () => status() === "failed");
  assert.equal(memoryPosts - asked, 3);
  refuseMemories = 400;
  reopen();
  await until("refused", () => status() === "failed" && memoryPosts - asked === 4);
  refuseMemories = 0;
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { creations: false } })).body.creations, false);
  reopen();
  await until("closed", () => status() === "empty");
  assert.equal(memories.length, made, "no memory made");
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { creations: true } })).body.creations, true);
  sql("UPDATE creation_cards SET status = 'created', memory_id = ? WHERE id = ?", card.memory_id!, card.id);
});

test("the background run: once a day, at its time, for everyone who turned it on", async () => {
  await service.stop();
  service = new Service(port, { ...env, MEMORIES_TODAY: "2026-12-01", MEMORIES_CHECK_SECONDS: "1" });
  await service.start();
  const before = memories.length;
  for (let i = 0; i < 100 && (await call("GET", "/memories/settings", { cookie: COOKIE.A })).body.lastRunDay !== "2026-12-01"; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await call("GET", "/memories/settings", { cookie: COOKIE.A })).body.lastRunDay, "2026-12-01");
  const made = memories.slice(before);
  assert.ok(made.some((m) => m.body.data && m.body.memoryAt.startsWith("2026-11")), "Best of November");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(memories.length, before + made.length, "only once a night");
});

test("a theme due with too few good photos is recorded as skipped, not read again every night", async () => {
  const day = (await call("GET", "/memories/labels", { cookie: COOKIE.A })).status;
  assert.equal(day, 200);
  const skipped = sqlAll("SELECT status FROM themed_memories WHERE theme_key = 'day:2026-11-30'");
  assert.deepEqual(skipped, [{ status: "skipped" }], "30 November: screenshots only");
  await night("2026-12-02");
  const searches = calls.filter((c) => c === "POST /api/search/metadata").length;
  const next = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  assert.deepEqual(next.body.skipped, []);
  assert.equal(calls.filter((c) => c === "POST /api/search/metadata").length, searches, "nothing searched again");
});

test("one run at a time for everyone: someone else's \"now\" waits its turn", async () => {
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.B, json: { enabled: true } })).status, 200);
  await night("2026-12-03");
  immichDelayMs = 150;
  const [a, b] = await Promise.all([
    call("POST", "/memories/run", { cookie: COOKIE.A, json: {} }), call("POST", "/memories/run", { cookie: COOKIE.B, json: {} }),
  ]);
  immichDelayMs = 0;
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  assert.match((a.status === 429 ? a : b).body.error, /being made for someone/);
});

test("switched off: no runs, can't turn on, can still turn off; labels stay", async () => {
  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { themedMemories: { enabled: false } } })).status, 200);
  assert.equal((await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} })).status, 403);
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.B, json: { enabled: true } })).status, 403);
  assert.equal((await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { creations: false } })).body.creations, false);
  assert.ok((await call("GET", "/memories/labels", { cookie: COOKIE.A })).body.memories.length >= 4);
  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { themedMemories: { enabled: true } } })).status, 200);
});

test("a key Immich rejects pauses them; turning on again makes a new key", async () => {
  for (const k of keysOf(A.id)) k.revoked = true;
  await night("2027-01-01");
  const run = await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} });
  assert.deepEqual(run.body.made, []);
  const paused = (await call("GET", "/memories/settings", { cookie: COOKIE.A })).body;
  assert.match(paused.pausedReason, /stopped working/);
  assert.equal((await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} })).status, 409);
  const on = await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { enabled: true } });
  assert.equal(on.body.pausedReason, null);
  assert.equal(keysOf(A.id).filter((k) => !k.revoked).length, 1);
  await night("2027-01-01");
  assert.equal((await call("POST", "/memories/run", { cookie: COOKIE.A, json: {} })).status, 200);
});

test("turning off deletes the key in Immich; memories and labels stay", async () => {
  const off = await call("PUT", "/memories/settings", { cookie: COOKIE.A, json: { enabled: false } });
  assert.deepEqual([off.body.enabled, off.body.creations], [false, false]);
  assert.equal(keysOf(A.id).filter((k) => !k.revoked).length, 0);
  assert.ok((await call("GET", "/memories/labels", { cookie: COOKIE.A })).body.memories.length >= 4);
  assert.ok(memories.length >= 4);
});
