// Ask Photos with the trained reader: how the model's labels become a search
// (services/ask-reader.service.ts), and the client that calls it (clients/reader.client.ts).
// No model is needed: the labels are written by hand. Run: npm test

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, test } from "node:test";
import { json, listen } from "./helpers.ts";

// A fake reader, started first: the service reads its address when it's first imported.
let mode = "good";
const server: Server = createServer(async (req, res) => {
  for await (const _ of req);
  if (mode === "slow") await new Promise((r) => setTimeout(r, 1000));
  if (mode === "odd") return json(res, 200, { tokens: ["a"], tags: ["B-NOPE"] });
  json(res, 200, { tokens: ["goa"], tags: ["B-WORD"], ms: 3 });
});
process.env.GEMINI_API_KEY ??= "test";
process.env.READER_URL = `http://127.0.0.1:${await listen(server)}`;
process.env.READER_TIMEOUT_MS = "300";
const { planFromReply, spansOf } = await import("../src/services/ask-reader.service.ts");
const { readQuestion } = await import("../src/clients/reader.client.ts");

const person = (id: string, name: string, birthDate: string | null = null) => ({ id, name, birthDate });
const PEOPLE = [
  person("mummy", "Mummy", "1968-02-10"),
  person("me-face", "Arun Rao"),
  person("ishaan", "Ishaan"),
  person("kiran-mehra", "Kiran Mehra"),
  person("sunny", "Sunny"),
  person("bruno", "Bruno"),
];
const CTX = { people: PEOPLE, accountName: "Arun Rao", today: { y: 2026, m: 11, d: 20 } };
// "word/LABEL word/LABEL ..." → a reply, as the reader would send it.
const reply = (labelled: string) => {
  const pairs = labelled.split(" ").map((p) => p.split("/") as [string, string]);
  return { tokens: pairs.map(([w]) => w), tags: pairs.map(([, t]) => t) };
};
const read = (labelled: string) => {
  const r = reply(labelled);
  return planFromReply(r.tokens.join(" "), r, CTX);
};

describe("labels → a search", () => {
  test("labelled phrases come out whole and in order", () => {
    assert.deepEqual(spansOf(reply("pichle/B-DATE saal/I-DATE ki/O goa/B-WORD trip/B-WORD")).map((s) => [s.kind, s.words.join(" ")]), [
      ["DATE", "pichle saal"], ["WORD", "goa"], ["WORD", "trip"],
    ]);
  });

  test("sort, videos, favourites, and words for each search", () => {
    const plan = read("last/B-NEW time/I-NEW in/O goa/B-WORD");
    assert.deepEqual([plan.order, plan.words, plan.text, plan.people, plan.dates], ["newest", ["goa"], "goa", [], null]);
    const fav = read("sabse/B-OLD purani/I-OLD fav/B-FAV beach/B-WORD vids/B-VIDEO");
    assert.deepEqual([fav.order, fav.favorite, fav.type, fav.words], ["oldest", true, "VIDEO", ["beach"]]);
  });

  test("the search gets what the model marked as things and places, no word lists", () => {
    const plan = read("yaar/O show/O me/O wugong/B-WORD mountain/I-WORD pics/O na/O");
    assert.deepEqual([plan.words, plan.text], [["wugong", "mountain"], "wugong mountain"]);
    // A word it left unmarked isn't searched: the model's labels decide.
    assert.equal(read("yaar/O show/O me/O wugong/O mountain/B-WORD pics/O").text, "mountain");
    // Marked nothing at all: the question goes to the search model as it is.
    assert.equal(read("wugong/O ki/O pics/O").text, "wugong ki pics");
  });

  test("places: the phrases marked as where the photos were taken", () => {
    const plan = read("last/B-NEW time/I-NEW jab/O hum/O new/B-PLACE delhi/I-PLACE gaye/O the/O");
    assert.deepEqual([plan.places, plan.text, plan.words, plan.order], [["new delhi"], "new delhi", ["new", "delhi"], "newest"]);
    // A place that only describes people isn't one: "Delhi wale cousins".
    assert.deepEqual(read("delhi/O wale/O cousins/B-WORD ke/O saath/O").places, []);
    // A place named like someone on the People page stays a place, not a person filter.
    const sydney = planFromReply("sydney trip", reply("sydney/B-PLACE trip/B-WORD"), { ...CTX, people: [...PEOPLE, person("sydney", "Sydney")] });
    assert.deepEqual([sydney.people, sydney.places], [[], ["sydney"]]);
  });

  test("people: names, first names, possessives, nicknames, me", () => {
    assert.deepEqual(read("ishaan's/B-PER bike/B-WORD").people.map((p) => p.id), ["ishaan"]);
    assert.deepEqual(read("kiran/B-PER at/O work/B-WORD").people.map((p) => p.id), ["kiran-mehra"]);
    assert.deepEqual(read("maa/B-PER ke/O saath/O mandir/B-WORD").people.map((p) => p.id), ["mummy"]); // nickname
    assert.deepEqual(read("me/B-PER and/O bruno/B-PER").people.map((p) => p.id), ["me-face", "bruno"]);
    // "I", "I’m" (a phone's curly apostrophe) and "I am" are the asker when marked as a person.
    for (const mention of ["I/B-PER", "I’m/B-PER", "i'm/B-PER", "I/B-PER am/I-PER"]) {
      assert.deepEqual(read(`last/B-NEW time/I-NEW ${mention} in/O goa/B-PLACE`).people.map((p) => p.id), ["me-face"], mention);
    }
    // A name the People page doesn't know: no filter, and not a search word either.
    assert.deepEqual([read("tanvi/B-PER at/O beach/B-WORD").people, read("tanvi/B-PER at/O beach/B-WORD").words], [[], ["beach"]]);
  });

  test("me without a face called me: a hint, no filter", () => {
    const plan = planFromReply("me at the beach", reply("me/B-PER at/O the/O beach/B-WORD"), { ...CTX, accountName: "Someone Else" });
    assert.deepEqual(plan.people, []);
    assert.match(plan.hints[0]!, /name your own face/);
  });

  test("dates go through the date reader, birthdays through the People page", () => {
    assert.equal(read("pichle/B-DATE saal/I-DATE beach/B-WORD").dates?.label, "2025");
    const birthday = read("mummy's/B-DATE birthday/I-DATE cake/B-WORD");
    assert.match(birthday.dates!.label, /Mummy's birthday/);
    assert.deepEqual([birthday.people, birthday.words], [[], ["cake"]]); // her birthday, not a filter on her
    // No birthday on the People page: the person and the word, and how to fix it.
    const ishaan = read("ishaan's/B-DATE birthday/I-DATE");
    assert.deepEqual([ishaan.dates, ishaan.people.map((p) => p.id), ishaan.words], [null, ["ishaan"], ["birthday"]]);
    assert.match(ishaan.hints[0]!, /Add Ishaan's birthday/);
    assert.equal(read("june/B-DATE").dates?.label, "June 2026"); // a lone month is the month
  });

  test("found in review: dates it can't convert still searched, no request words, possessives", () => {
    // "diwali" isn't converted to dates (it moves each year): it's still searched, not dropped.
    const diwali = read("diwali/B-DATE ki/O pics/O");
    assert.deepEqual([diwali.dates, diwali.text, diwali.words], [null, "diwali", ["diwali"]]);
    // Request words never reach the search: Mummy's photos by date, not a search for "get".
    const get = read("can/O you/O get/O me/O mummy's/B-PER pics/O");
    assert.deepEqual([get.text, get.people.map((p) => p.id)], ["", ["mummy"]]);
    assert.equal(read("send/O me/O beach/B-WORD pics/O").text, "beach");
    // "Vikas'" is Vikas, not "vika".
    const vikas = planFromReply("vikas' bike", reply("vikas'/B-PER bike/B-WORD"), { ...CTX, people: [...PEOPLE, person("vikas", "Vikas")] });
    assert.deepEqual(vikas.people.map((p) => p.id), ["vikas"]);
  });

  test("the safety net adds a People-page name the model missed, but not a thing or a date", () => {
    assert.deepEqual(read("ishaan/O at/O the/O beach/B-WORD").people.map((p) => p.id), ["ishaan"]);
    assert.deepEqual(read("sunny/B-WORD day/B-WORD at/O the/O beach/B-WORD").people, []); // the weather
    assert.deepEqual(read("mummy's/B-DATE birthday/I-DATE").people, []); // her birthday
  });

  test("found in review: a name that's also a common word, and sort words inside a date", () => {
    // A face named Will: "will you show me…" isn't him; "Will Smith" in full, or marked, is.
    const will = { ...CTX, people: [...PEOPLE, person("will", "Will")] };
    const willSmith = { ...CTX, people: [...PEOPLE, person("ws", "Will Smith")] };
    const ask = (q: string, ctx: typeof CTX) => planFromReply(q.replace(/\/[A-Z-]+/g, ""), reply(q), ctx).people.map((p) => p.id);
    assert.deepEqual(ask("will/O you/O show/O me/O the/O beach/B-WORD pics/O", will), []);
    assert.deepEqual(ask("will/O you/O show/O me/O the/O beach/B-WORD pics/O", willSmith), []);
    assert.deepEqual(ask("will/O smith/O at/O the/O beach/B-WORD", willSmith), ["ws"]);
    assert.deepEqual(ask("will/B-PER at/O the/O beach/B-WORD", will), ["will"]);
    // "my first birthday" marked as a date: the captions are searched for "birthday" only.
    assert.deepEqual(read("my/B-DATE first/I-DATE birthday/I-DATE photos/O").words, ["birthday"]);
  });
});

describe("the reader client", () => {
  after(() => server.close());

  test("a good reply, and null for an odd, slow or missing one (then the question is searched as typed)", async () => {
    mode = "good";
    assert.deepEqual(await readQuestion("goa"), { tokens: ["goa"], tags: ["B-WORD"] });
    mode = "odd";
    assert.equal(await readQuestion("goa"), null);
    mode = "slow";
    assert.equal(await readQuestion("goa"), null);
    server.close();
    assert.equal(await readQuestion("goa"), null);
  });
});

test("the 'me' words match the reader's list (reader/common.py)", async () => {
  const { readFileSync } = await import("node:fs");
  const { FIRST_PERSON } = await import("../src/constants/ask.constants.ts");
  const python = readFileSync(new URL("../reader/common.py", import.meta.url), "utf8");
  const block = /FIRST_PERSON = frozenset\(\{([^}]*)\}\)/.exec(python)![1]!;
  const fromPython = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
  assert.deepEqual([...FIRST_PERSON].sort(), fromPython);
});
