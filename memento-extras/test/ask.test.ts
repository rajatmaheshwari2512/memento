// Ask Photos end to end: the real service against a fake Immich, with captions in its
// database. Run: npm test
//
// A fake trained reader labels each test question by hand (as the real one would); a question
// it doesn't know gets an error, so Ask searches it as it is.
//
// The fake Immich checks what the real one (v3.4) checks for the v3 search shape: a strict
// filter (unknown keys refused), no old flat fields next to `filter`, and its own access
// rules. Its smart search returns the photos whose made-up "look" has any of the query's
// words, most first; its other search returns newest first, with a cursor.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { call as callService, COOKIE, freePort, json, listen, readBody, Service, type CallOptions } from "./helpers.ts";

const A = { id: randomUUID(), name: "Asha Rao", isAdmin: true };
const B = { id: randomUUID(), name: "Bo", isAdmin: false };
const PARTNER = randomUUID(); // shares their photos with A (Immich's search includes them)

// A's people. The fake gives 2 per page, so Zoe is only on the third page.
const MOM = randomUUID();
const ME = randomUUID();
const DAD = randomUUID();
const ZOE = randomUUID();
const PEOPLE_A = [
  { id: MOM, name: "Mom", birthDate: null }, { id: ME, name: "Asha Rao", birthDate: null },
  { id: DAD, name: "Dad", birthDate: null }, { id: randomUUID(), name: "", birthDate: null },
  { id: ZOE, name: "Zoe", birthDate: null },
];

type FakeAsset = {
  id: string; ownerId: string; people: string[]; takenAt: string; type: "IMAGE" | "VIDEO";
  favorite: boolean; trashed: boolean; visibility: string; look: string; state?: string; city?: string;
};
const assets = new Map<string, FakeAsset>();
function asset(over: Partial<FakeAsset>): string {
  const id = randomUUID();
  assets.set(id, {
    id, ownerId: A.id, people: [], takenAt: "2023-06-01T06:00:00.000Z", type: "IMAGE", favorite: false,
    trashed: false, visibility: "timeline", look: "", ...over,
  });
  return id;
}

const beachMomMe = asset({ people: [MOM, ME], look: "beach sea sand", takenAt: "2023-01-10T06:00:00.000Z" });
const beachMomOnly = asset({ people: [MOM], look: "beach sand", takenAt: "2023-01-11T06:00:00.000Z" });
const beachDec31 = asset({ people: [MOM, ME], look: "beach", takenAt: "2022-12-31T20:00:00.000Z" }); // 1 Jan 2023 in India
const beachPartner = asset({ ownerId: PARTNER, look: "beach", takenAt: "2023-02-01T06:00:00.000Z" });
// The search model misses the boarding pass; only its caption has the words.
const pass2023 = asset({ look: "paper hand", takenAt: "2023-03-01T06:00:00.000Z" });
const pass2024 = asset({ look: "paper", takenAt: "2024-03-01T06:00:00.000Z" });
const passTrashed = asset({ look: "paper", trashed: true });
const passXmas = asset({ look: "paper", takenAt: "2022-12-25T06:00:00.000Z" });
const bothLists = asset({ look: "airport boarding", takenAt: "2023-04-01T06:00:00.000Z" }); // found by both
// Taken in Goa (Immich found the state from their location); one more that only looks like it.
const goaOld = asset({ look: "", state: "Goa", takenAt: "2019-12-28T06:00:00.000Z" });
const goaNew = asset({ look: "", state: "Goa", takenAt: "2025-12-29T06:00:00.000Z" });
const goaLookalike = asset({ look: "goa", takenAt: "2024-05-01T06:00:00.000Z" });
const mumbai = asset({ look: "", city: "Mumbai", state: "Maharashtra", takenAt: "2018-06-01T06:00:00.000Z" });
const bPhoto = asset({ ownerId: B.id, look: "beach" });
const zoe = asset({ people: [ZOE], look: "park" });
const hiddenPart = asset({ people: [ZOE], visibility: "hidden" });
const momVideos = Array.from({ length: 260 }, (_, i) =>
  asset({ people: [MOM], type: "VIDEO", look: "video", takenAt: new Date(Date.UTC(2021, 0, 1) + i * 86_400_000).toISOString() }));
asset({ look: "sand castle" });
// More caption matches than one Immich search takes (2,000 IDs); the newest has the worst word
// match, so it's cut by the caption search's usual 200 and lands in the last batch.
const kites = Array.from({ length: 2_100 }, (_, i) => asset({ look: "", takenAt: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString() }));
const newestKite = asset({ look: "", takenAt: "2025-06-01T06:00:00.000Z" });

const captions = [
  { assetId: pass2023, ownerId: A.id, caption: "A man holds a boarding pass for a flight to Delhi.", tags: ["Ticket"] },
  { assetId: pass2024, ownerId: A.id, caption: "Two boarding passes on a table at the airport.", tags: ["Ticket", "Document"] },
  { assetId: passTrashed, ownerId: A.id, caption: "A boarding pass, crumpled.", tags: ["Ticket"] },
  { assetId: passXmas, ownerId: A.id, caption: "A boarding pass next to a Christmas tree.", tags: ["Ticket"] },
  { assetId: bothLists, ownerId: A.id, caption: "An airport gate with a boarding pass in hand.", tags: ["Plane"] },
  { assetId: bPhoto, ownerId: B.id, caption: "Bo's boarding pass on a beach.", tags: ["Beach"] }, // B's: never shown to A
  ...kites.map((assetId) => ({ assetId, ownerId: A.id, caption: "A kite.", tags: [] })),
  {
    assetId: newestKite, ownerId: A.id, tags: [],
    caption: "A long afternoon in a wide green park with many people, dogs, benches, trees and, far away, one small kite.",
  },
];

// --- the fake trained reader ---

const LABELS: Record<string, string> = {
  "beach": "beach/B-WORD",
  "boarding pass": "boarding/B-WORD pass/I-WORD",
  "boarding pass at christmas": "boarding/B-WORD pass/I-WORD at/O christmas/B-DATE",
  "boarding pass in 2023": "boarding/B-WORD pass/I-WORD in/O 2023/B-DATE",
  "bombay ki photos": "bombay/B-PLACE ki/O photos/O",
  "kite": "kite/B-WORD",
  "last time goa gaye the": "last/B-NEW time/I-NEW goa/B-PLACE gaye/O the/O",
  "last time in goa": "last/B-NEW time/I-NEW in/O goa/B-PLACE",
  "last time in shimla": "last/B-NEW time/I-NEW in/O shimla/B-PLACE",
  "Mom and me at the beach in 2023": "Mom/B-PER and/O me/B-PER at/O the/O beach/B-WORD in/O 2023/B-DATE",
  "most recent photos of the beach": "most/B-NEW recent/I-NEW photos/O of/O the/O beach/B-WORD",
  "oldest videos of Mom": "oldest/B-OLD videos/B-VIDEO of/O Mom/B-PER",
  "2025 mein goa ki photos": "2025/B-DATE mein/O goa/B-PLACE ki/O photos/O",
  "the first time I had a boarding pass": "the/O first/B-OLD time/I-OLD I/O had/O a/O boarding/B-WORD pass/I-WORD",
  "the first time I saw a kite": "the/O first/B-OLD time/I-OLD I/O saw/O a/O kite/B-WORD",
  "the last time I had a boarding pass": "the/O last/B-NEW time/I-NEW I/O had/O a/O boarding/B-WORD pass/I-WORD",
  "the last time I saw a kite": "the/O last/B-NEW time/I-NEW I/O saw/O a/O kite/B-WORD",
  "videos of Mom": "videos/B-VIDEO of/O Mom/B-PER",
  "Zoe": "Zoe/B-PER",
  "me at the beach": "me/B-PER at/O the/O beach/B-WORD",
};
async function fakeReader(req: IncomingMessage, res: ServerResponse) {
  const { question } = JSON.parse(await readBody(req)) as { question: string };
  const labelled = LABELS[question];
  if (!labelled) return json(res, 503, { error: "not ready" });
  const pairs = labelled.split(" ").map((p) => p.split("/") as [string, string]);
  json(res, 200, { tokens: pairs.map(([w]) => w), tags: pairs.map(([, t]) => t), ms: 3 });
}

// --- the fake Immich ---

const calls: string[] = [];
const bodies: Array<{ path: string; body: any }> = [];

const BRANCH_KEYS = new Set(["id", "type", "visibility", "isFavorite", "takenAt", "trashedAt", "personIds", "city", "state", "country"]);
function badFilter(f: any, top = true): string | null {
  for (const k of Object.keys(f)) {
    if (k === "or" && top) {
      if (!Array.isArray(f.or) || f.or.length === 0) return "or must be a non-empty list";
      for (const b of f.or) {
        if (Object.keys(b).length === 0) return "empty branch";
        const bad = badFilter(b, false);
        if (bad) return bad;
      }
    } else if (!BRANCH_KEYS.has(k)) return `Unrecognized key: ${k}`;
  }
  return null;
}
function matchesBranch(a: FakeAsset, f: any): boolean {
  if (f.id?.eq && a.id !== f.id.eq) return false;
  if (f.type?.eq && a.type !== f.type.eq) return false;
  if (f.visibility?.eq && a.visibility !== f.visibility.eq) return false;
  if (f.isFavorite && a.favorite !== f.isFavorite.eq) return false;
  if (f.trashedAt && "eq" in f.trashedAt && f.trashedAt.eq === null && a.trashed) return false;
  if (f.takenAt?.gte && a.takenAt < f.takenAt.gte) return false;
  if (f.takenAt?.lt && a.takenAt >= f.takenAt.lt) return false;
  if (f.personIds?.all && !f.personIds.all.every((p: string) => a.people.includes(p))) return false;
  if (f.state?.eq && a.state !== f.state.eq) return false;
  if (f.city?.eq && a.city !== f.city.eq) return false;
  if (f.country?.eq) return false; // no countries in this library
  return true;
}
const matches = (a: FakeAsset, f: any) => matchesBranch(a, f) && (!f.or || f.or.some((b: any) => matchesBranch(a, b)));
const toJson = (a: FakeAsset) => ({
  id: a.id, ownerId: a.ownerId, type: a.type, fileCreatedAt: a.takenAt, isFavorite: a.favorite, isTrashed: a.trashed,
  visibility: a.visibility, exifInfo: { city: null }, people: [],
});

async function fakeImmich(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const user = req.headers.cookie === COOKIE.A ? A : req.headers.cookie === COOKIE.B ? B : null;
  if (!user) return json(res, 401, {});
  calls.push(url.pathname);
  if (url.pathname === "/api/users/me") return json(res, 200, user);
  if (url.pathname === "/api/people") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const all = user === A ? PEOPLE_A : [];
    return json(res, 200, { people: all.slice((page - 1) * 2, page * 2), total: all.length, hidden: 0, hasNextPage: page * 2 < all.length });
  }
  const searchable = (a: FakeAsset) => a.ownerId === user.id || (user === A && a.ownerId === PARTNER);
  if (url.pathname === "/api/search/places") { // old names and typos, as Immich's place data has them
    return json(res, 200, url.searchParams.get("name") === "bombay" ? [{ name: "Mumbai", admin1name: "Maharashtra" }] : []);
  }
  if (url.pathname === "/api/search/suggestions") {
    const kind = url.searchParams.get("type") as "city" | "state" | "country";
    const values = [...assets.values()].filter(searchable).map((a) => (kind === "country" ? undefined : a[kind]));
    return json(res, 200, [...new Set(values.filter(Boolean))]);
  }
  if (req.method === "POST" && (url.pathname === "/api/search/smart" || url.pathname === "/api/search/metadata")) {
    const b = JSON.parse(await readBody(req));
    bodies.push({ path: url.pathname, body: b });
    const flat = Object.keys(b).filter((k) => !["filter", "size", "query", "language", "withExif", "cursor", "orderBy"].includes(k));
    if (flat.length) return json(res, 400, { message: `Deprecated field ${flat[0]} cannot be combined with filter` });
    const bad = badFilter(b.filter ?? {});
    if (bad) return json(res, 400, { message: bad });
    const found = [...assets.values()].filter((a) => searchable(a) && matches(a, b.filter ?? {}));
    if (url.pathname === "/api/search/smart") {
      if (!b.query) return json(res, 400, { message: "Either `query` or `queryAssetId` must be set" });
      const words = String(b.query).toLowerCase().split(/\s+/);
      const score = (a: FakeAsset) => words.filter((w) => a.look.split(" ").includes(w)).length;
      // Only photos that look like the words, so caption-only matches can be told apart.
      const relevant = found.filter((a) => score(a) > 0).sort((x, y) => score(y) - score(x) || x.takenAt.localeCompare(y.takenAt));
      return json(res, 200, { assets: { items: relevant.slice(0, b.size).map(toJson), nextCursor: null } });
    }
    found.sort((x, y) => (b.orderBy?.direction === "asc" ? 1 : -1) * x.takenAt.localeCompare(y.takenAt));
    const start = b.cursor ? Number(b.cursor) : 0;
    const page = found.slice(start, start + b.size);
    return json(res, 200, { assets: { items: page.map(toJson), nextCursor: start + b.size < found.length ? String(start + b.size) : null } });
  }
  json(res, 404, {});
}

let immich: Server;
let reader: Server;
let service: Service;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-ask-"));

before(async () => {
  // Captions go in the way they do on the server: a results file, imported.
  process.env.DATA_DIR = dataDir;
  process.env.GEMINI_API_KEY = "unused";
  const { importCaptions } = await import("../src/services/caption-records.service.ts");
  const { closeDatabase } = await import("../src/db/database.ts");
  const file = join(dataDir, "captions.jsonl");
  writeFileSync(file, captions.map((c) => JSON.stringify({ ...c, model: "test-model" })).join("\n"));
  assert.equal(importCaptions(file).imported, captions.length);
  closeDatabase();

  immich = createServer((req, res) => void fakeImmich(req, res));
  const immichPort = await listen(immich);
  reader = createServer((req, res) => void fakeReader(req, res));
  const readerPort = await listen(reader);
  service = new Service(await freePort(), {
    IMMICH_URL: `http://127.0.0.1:${immichPort}`, READER_URL: `http://127.0.0.1:${readerPort}`, GEMINI_API_KEY: "unused", GEMINI_URL: "http://127.0.0.1:9/unused",
    DATA_DIR: dataDir, LIVE_ALBUMS_INTERVAL_SECONDS: "3600", SNAPSHOT_FIRST_SECONDS: "3600",
  });
  await service.start();
});

after(async () => {
  await service.stop();
  immich.close();
  reader.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (method: string, path: string, opts: CallOptions = {}) => callService(service.base, method, path, opts);
const askA = (question: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/ask", { cookie: COOKIE.A, json: { question, timeZone: "Asia/Kolkata", ...extra } });
const ids = (body: any) => (body.assets as Array<{ id: string }>).map((a) => a.id);

test("people and dates become Immich filters, in the user's time zone", async () => {
  const { status, body } = await askA("Mom and me at the beach in 2023");
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.understood.people.map((p: any) => p.name), ["Mom", "Asha Rao"]);
  assert.equal(body.understood.dates.label, "2023");
  assert.equal(body.understood.text, "beach");
  assert.equal(body.words, undefined);
  // Mom and me, in 2023 India time: 31 Dec 2022 20:00 UTC is 1 Jan 2023 there.
  assert.deepEqual(ids(body), [beachDec31, beachMomMe]);
  const smart = bodies.findLast((b) => b.path === "/api/search/smart")!.body;
  assert.equal(smart.query, "beach");
  assert.deepEqual(smart.filter.personIds, { all: [MOM, ME] });
  assert.deepEqual(smart.filter.takenAt, { gte: "2022-12-31T18:30:00.000Z", lt: "2023-12-31T18:30:00.000Z" });
  assert.deepEqual(smart.filter.visibility, { eq: "timeline" });
  assert.deepEqual(smart.filter.trashedAt, { eq: null });
});

test("Immich's search includes timeline partners' photos, like Immich's own search", async () => {
  const { body } = await askA("beach");
  assert.ok(ids(body).includes(beachPartner));
  assert.ok(!ids(body).includes(bPhoto));
  assert.ok(ids(body).includes(beachMomOnly));
});

test("caption matches join the results; a photo found by both lists ranks first", async () => {
  const { body } = await askA("boarding pass");
  const got = ids(body);
  assert.equal(got[0], bothLists);
  for (const id of [pass2023, pass2024, passXmas]) assert.ok(got.includes(id), "caption match missing");
  assert.ok(!got.includes(passTrashed), "a trashed photo came back");
  assert.ok(!got.includes(bPhoto), "another user's caption came back");
  const viaCaptions = bodies.findLast((b) => b.path === "/api/search/metadata")!.body;
  assert.ok(viaCaptions.filter.or.every((b: any) => Object.keys(b).join() === "id"));
});

test("caption matches obey the same filters", async () => {
  const { body } = await askA("boarding pass in 2023");
  assert.ok(ids(body).includes(pass2023));
  assert.ok(!ids(body).includes(pass2024));
  // several date ranges (every Christmas): checked on each photo's date
  const xmas = await askA("boarding pass at christmas");
  assert.equal(xmas.status, 200, JSON.stringify(xmas.body));
  assert.deepEqual(ids(xmas.body).filter((id) => [pass2023, pass2024, passXmas, bothLists].includes(id)), [passXmas]);
});

test("no words left: every match, newest first, page by page", async () => {
  const first = await askA("videos of Mom");
  assert.equal(first.status, 200);
  assert.equal(first.body.understood.type, "VIDEO");
  assert.equal(first.body.assets.length, 250);
  assert.equal(first.body.assets[0].id, momVideos.at(-1));
  assert.ok(first.body.nextCursor);
  assert.ok(!bodies.slice(-1).some((b) => b.path === "/api/search/smart"));
  const second = await askA("videos of Mom", { cursor: first.body.nextCursor });
  assert.equal(second.body.assets.length, 10);
  assert.equal(second.body.nextCursor, null);
});

test("the last / first time: caption matches first, sorted by date", async () => {
  const last = await askA("the last time I had a boarding pass");
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(last.body.understood.order, "newest");
  assert.deepEqual(ids(last.body), [pass2024, bothLists, pass2023, passXmas]);
  const first = await askA("the first time I had a boarding pass");
  assert.deepEqual(ids(first.body), [passXmas, pass2023, bothLists, pass2024]);
  // more matches than the caption search keeps: the newest is still found, and first
  assert.ok(!ids((await askA("kite")).body).includes(newestKite)); // by word match, it's cut
  const kite = await askA("the last time I saw a kite");
  assert.equal(ids(kite.body)[0], newestKite);
  assert.equal(ids((await askA("the first time I saw a kite")).body)[0], kites[0]);
  // no caption matches: the AI search's best matches are sorted instead
  const beach = await askA("most recent photos of the beach");
  const dates = beach.body.assets.map((a: any) => a.fileCreatedAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test("oldest first with no words left: Immich sorts, page by page", async () => {
  const { body } = await askA("oldest videos of Mom");
  assert.equal(body.understood.order, "oldest");
  assert.equal(body.assets[0].id, momVideos[0]);
  assert.deepEqual(bodies.findLast((b) => b.path === "/api/search/metadata")!.body.orderBy, { field: "fileCreatedAt", direction: "asc" });
  const second = await askA("oldest videos of Mom", { cursor: body.nextCursor });
  assert.equal(second.body.assets.at(-1).id, momVideos.at(-1));
});

test("people on later pages of Immich's list are found; hidden parts are not shown", async () => {
  const { body } = await askA("Zoe");
  assert.deepEqual(ids(body), [zoe]);
  assert.ok(!ids(body).includes(hiddenPart));
});

test("a user with no captions and no 'me' still gets results, and a hint", async () => {
  const { status, body } = await call("POST", "/ask", { cookie: COOKIE.B, json: { question: "me at the beach" } });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(ids(body), [bPhoto]);
  assert.match(body.understood.hints[0], /name your own face “me” or “Bo”/);
});

test("bad requests", async () => {
  assert.equal((await askA("   ")).status, 400);
  assert.equal((await askA("x".repeat(301))).status, 400);
  assert.equal((await askA("beach", { timeZone: "Mars/Olympus" })).status, 400);
  assert.equal((await askA("beach", { cursor: 5 })).status, 400);
  assert.equal((await call("POST", "/ask", { json: { question: "beach" } })).status, 401);
  assert.equal((await call("POST", "/ask", { cookie: COOKIE.A, json: { question: "beach" }, contentType: "text/plain" })).status, 415);
});

test("switched off: refused before anything is read from Immich", async () => {
  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { askPhotos: { enabled: false } } })).status, 200);
  const before = calls.filter((p) => p !== "/api/users/me").length;
  const { status, body } = await askA("beach");
  assert.equal(status, 403);
  assert.match(body.error, /Ask Photos is switched off/);
  assert.equal(calls.filter((p) => p !== "/api/users/me").length, before);
  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { askPhotos: { enabled: true } } })).status, 200);
  assert.equal((await askA("beach")).status, 200);
});

test("a place in the asker's photos: taken there first, newest first for 'last time', then look-alikes", async () => {
  const res = await askA("last time in goa");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.understood.place, { name: "Goa", kind: "state" });
  assert.deepEqual(res.body.assets.slice(0, 2).map((a: { id: string }) => a.id), [goaNew, goaOld]);
  assert.ok(res.body.assets.some((a: { id: string }) => a.id === goaLookalike), "photos that only look like it still come after");
  // A place that isn't in this user's photos is just a word.
  const nowhere = await askA("last time in shimla");
  assert.equal(nowhere.body.understood.place, null);
});

test("the reader can't answer: the question goes to Immich's search as it is, no filters", async () => {
  bodies.length = 0;
  const res = await askA("Mom at the beach in 2023 please");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.understood.people, res.body.understood.dates, res.body.understood.place], [[], null, null]);
  const smart = bodies.filter((b) => b.path === "/api/search/smart");
  assert.deepEqual(smart.map((b) => b.body.query), ["Mom at the beach in 2023 please"]);
  assert.deepEqual(Object.keys(smart[0]!.body.filter).sort(), ["trashedAt", "visibility"]);
  assert.match(res.body.understood.hints[0], /Searched as typed/);
  // A next page needs the first page's filters, which can't be rebuilt without the reader.
  const page2 = await askA("Mom at the beach in 2023 please", { cursor: "250" });
  assert.equal(page2.status, 409);
  assert.match(page2.body.error, /Search again/);
});

test("places: a city by its old name, Hinglish questions, and the switch", async () => {
  const bombay = await askA("bombay ki photos");
  assert.deepEqual(bombay.body.understood.place, { name: "Mumbai", kind: "city" });
  assert.equal(ids(bombay.body)[0], mumbai);
  // Hindi grammar words aren't search words: Goa's photos by date, newest first.
  assert.deepEqual(ids((await askA("last time goa gaye the")).body).slice(0, 2), [goaNew, goaOld]);
  assert.deepEqual(ids((await askA("2025 mein goa ki photos")).body), [goaNew]);

  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { askPhotos: { places: false } } })).status, 200);
  assert.equal((await askA("last time in goa")).body.understood.place, null);
  assert.equal((await call("PUT", "/flags", { cookie: COOKIE.A, json: { askPhotos: { places: true } } })).status, 200);
});
