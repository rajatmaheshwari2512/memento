// Places in Ask Photos: the reader's place looked up in the asker's own places. Run: npm test

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { json, listen } from "./helpers.ts";

let mode: "good" | "broken" | "slow" = "good";
let reads = 0;
let placeSearches = 0;
const FOUND: Record<string, Array<{ name: string; admin1name?: string }>> = {
  bombay: [{ name: "Bambali", admin1name: "North Bank" }, { name: "Mumbai", admin1name: "Maharashtra" }],
  calcutta: [{ name: "Calcutta", admin1name: "Corozal District" }, { name: "Calcutta", admin1name: "Ohio" }, { name: "Kolkata", admin1name: "West Bengal" }],
  banglore: [{ name: "Bengaluru", admin1name: "Karnataka" }],
  shimla: [{ name: "Shimla", admin1name: "Himachal Pradesh" }],
};
const immich = createServer(async (req, res) => {
  for await (const _ of req);
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/api/search/places") {
    placeSearches++;
    if (url.searchParams.get("name") === "broken town") return json(res, 500, { message: "boom" });
    if (mode === "slow") await new Promise((r) => setTimeout(r, 2_000));
    return json(res, 200, FOUND[url.searchParams.get("name")!] ?? []);
  }
  reads++;
  if (mode === "broken") return json(res, 500, { message: "boom" });
  if (mode === "slow") await new Promise((r) => setTimeout(r, 2_000));
  json(res, 200, url.searchParams.get("type") === "state" ? ["Goa", null] : []);
});
process.env.GEMINI_API_KEY ??= "test";
process.env.IMMICH_URL = `http://127.0.0.1:${await listen(immich)}`;
const { cachedPlaces, findPlace, indexPlaces, placesOf, withoutOnce } = await import("../src/services/ask-places.service.ts");
const { wordsOf } = await import("../src/utils/words.ts");
after(() => immich.close());

const cred = { name: "x-api-key", value: "test" };
const index = indexPlaces({
  country: ["India", "Singapore"],
  state: ["Delhi", "Goa", "West Bengal", "Jammu and Kashmir"],
  city: ["New Delhi", "Delhi", "Manāli", "Mumbai", "Bengaluru", "Kolkata", "Singapore"],
});
const plan = (...places: string[]) => ({
  text: places.join(" "), words: places.flatMap(wordsOf), people: [], dates: null, type: null, favorite: false, order: null, hints: [], places,
});
const place = async (...places: string[]) => (await findPlace(cred, plan(...places), index))?.place ?? null;

test("the asker's places: a name that's both is the wider place; accents don't matter", () => {
  assert.deepEqual(index.get("delhi"), { name: "Delhi", kind: "state" });
  assert.deepEqual(index.get("singapore"), { name: "Singapore", kind: "country" });
  assert.deepEqual(index.get("manali"), { name: "Manāli", kind: "city" });
});

test("the marked place, by its own name", async () => {
  mode = "good";
  const before = placeSearches;
  assert.deepEqual(await findPlace(cred, plan("goa"), index), { place: { name: "Goa", kind: "state" }, words: ["goa"] });
  assert.deepEqual(await place("New Delhi"), { name: "New Delhi", kind: "city" });
  assert.deepEqual(await place("Manali"), { name: "Manāli", kind: "city" });
  assert.deepEqual(await place("Goa's"), { name: "Goa", kind: "state" });
  assert.equal(placeSearches, before, "found without asking Immich");
  assert.equal(await findPlace(cred, plan(), index), null);
  assert.equal(placeSearches, before);
});

test("a phrase's words that name a place, more than one place, and '&' for 'and'", async () => {
  mode = "good";
  assert.deepEqual(await findPlace(cred, plan("goa beach"), index), { place: { name: "Goa", kind: "state" }, words: ["goa"] });
  assert.deepEqual(await place("delhi", "manali"), { name: "Delhi", kind: "state" });
  assert.deepEqual(await place("Jammu & Kashmir"), { name: "Jammu and Kashmir", kind: "state" });
});

test("old names and typos through Immich's place search, only if they're the asker's places", async () => {
  mode = "good";
  assert.deepEqual(await place("bombay"), { name: "Mumbai", kind: "city" });
  const before = placeSearches;
  assert.deepEqual(await place("bombay"), { name: "Mumbai", kind: "city" });
  assert.equal(placeSearches, before, "Immich's answer is kept: its place data is the same for everyone");
  assert.deepEqual(await place("calcutta"), { name: "Kolkata", kind: "city" });
  assert.deepEqual(await place("banglore"), { name: "Bengaluru", kind: "city" });
  assert.equal(await place("shimla"), null);
  assert.equal(await place("wugong"), null);
  assert.equal(await place("broken town"), null);
  const searchesSoFar = placeSearches;
  assert.equal(await findPlace(cred, plan("bombay"), indexPlaces({ city: [], state: [], country: [] })), null);
  assert.equal(placeSearches, searchesSoFar, "an asker with no places: Immich isn't asked");
});

test("a slow place search doesn't hold Ask up", async () => {
  mode = "slow";
  const started = Date.now();
  assert.equal(await place("madras", "poona", "gurgaon"), null);
  assert.ok(Date.now() - started < 1_900);
  mode = "good";
});

test("what's left to search for in the place's photos", () => {
  assert.deepEqual(withoutOnce(wordsOf("new car new delhi"), ["new", "delhi"]), ["new", "car"]);
  assert.deepEqual(withoutOnce(wordsOf("goa's beaches"), ["goa"]), ["beaches"]);
});

test("reading the asker's places: kept per user, never holds Ask up, a failure remembered", async () => {
  mode = "good";
  assert.equal((await placesOf(cred, "user-1"))?.get("goa")?.name, "Goa");
  const before = reads;
  await placesOf(cred, "user-1");
  assert.equal(reads, before, "kept, not read again");

  mode = "slow";
  const started = Date.now();
  assert.equal(await placesOf(cred, "user-2"), null);
  assert.ok(Date.now() - started < 1_900);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(cachedPlaces("user-2")?.has("goa"), true);
  assert.equal((await placesOf(cred, "user-2"))?.has("goa"), true);

  mode = "broken";
  assert.equal(await placesOf(cred, "user-3"), null);
  const failed = reads;
  assert.equal(await placesOf(cred, "user-3"), null);
  assert.equal(reads, failed);
});
