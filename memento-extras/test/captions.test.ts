// Captions: the checks, storage and search, and the backlog script against a fake llama-server.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { TAGS } from "../src/constants/captions.constants.ts";
import { fakeLlama, listen } from "./helpers.ts";

const dataDir = mkdtempSync(join(tmpdir(), "memento-captions-"));
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "test";
const { captionRequest } = await import("../src/services/captions.service.ts");
const { parseCaption, parseRecord } = await import("../src/schemas/captions.schema.ts");
const { importCaptions } = await import("../src/services/caption-records.service.ts");
const { searchCaptions } = await import("../src/services/repositories/captions.repository.ts");
const { database, snapshotDatabase, closeDatabase } = await import("../src/db/database.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the checker", () => {
  test("accepts a good reply", () => {
    assert.deepEqual(parseCaption('{"caption": "A birthday cake with candles.", "tags": ["Food", "Birthday"]}'), {
      caption: "A birthday cake with candles.",
      tags: ["Food", "Birthday"],
    });
  });

  test("drops tags that aren't on the list, fixes their case, removes repeats, keeps at most 3", () => {
    const reply = JSON.stringify({ caption: "x y z", tags: ["food", "Dog", "FOOD", "Beach", "Snow", "Night", "City", "Art"] });
    assert.deepEqual(parseCaption(reply)?.tags, ["Food", "Beach", "Snow"]);
  });

  test("tidies and caps a long caption, and accepts a fenced reply", () => {
    const long = "word ".repeat(200);
    const parsed = parseCaption("```json\n" + JSON.stringify({ caption: long, tags: [] }) + "\n```");
    assert.ok(parsed && parsed.caption.length <= 401 && parsed.caption.endsWith("…"));
  });

  test("refuses anything else", () => {
    for (const bad of [undefined, 42, "", "not json", "[]", '{"tags": []}', '{"caption": "  "}', '{"caption": 5}']) {
      assert.equal(parseCaption(bad), null, String(bad));
    }
  });

  test("results-file lines need real IDs and a model", () => {
    const good = { assetId: asset(1), ownerId: OWNER, model: "m", caption: "A dog.", tags: ["Pet"] };
    assert.deepEqual(parseRecord(JSON.stringify(good)), good);
    assert.equal(parseRecord(JSON.stringify({ ...good, assetId: "../etc" })), null);
    assert.equal(parseRecord(JSON.stringify({ ...good, model: "" })), null);
  });

  test("the request carries the image, the tag list, the JSON shape and no thinking", () => {
    const body = captionRequest(Buffer.from("jpeg")) as any;
    assert.equal(body.messages[0].content[0].image_url.url, "data:image/jpeg;base64," + Buffer.from("jpeg").toString("base64"));
    assert.match(body.messages[0].content[1].text, /Receipt/);
    assert.deepEqual(body.response_format.json_schema.schema.properties.tags.items.enum, [...TAGS]);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
  });
});

describe("storage and search", () => {
  const file = join(dataDir, "import.jsonl");
  const line = (n: number, caption: string, tags: string[] = [], owner = OWNER) =>
    JSON.stringify({ assetId: asset(n), ownerId: owner, model: "test-model", caption, tags });

  after(() => closeDatabase());

  test("imports good lines and skips bad ones", () => {
    writeFileSync(file, [
      line(1, "Two children blowing out candles on a birthday cake.", ["Birthday", "Food"]),
      line(2, "A boarding pass for an IndiGo flight to Goa.", ["Ticket"]),
      line(3, "A Royal Enfield motorbike parked by the sea.", ["Motorbike", "Beach"]),
      line(4, "A cake on a table in someone else's house.", ["Food"], OTHER),
      "not json",
      JSON.stringify({ assetId: asset(5), ownerId: OWNER, model: "m", caption: "" }),
      "",
    ].join("\n"));
    assert.deepEqual(importCaptions(file), { imported: 4, skipped: 2, total: 4 });
  });

  test("finds words in captions and tags, including other word forms", () => {
    assert.deepEqual(searchCaptions(OWNER, "cakes").map((m) => m.assetId), [asset(1)]);
    assert.deepEqual(searchCaptions(OWNER, "boarding pass").map((m) => m.assetId), [asset(2)]);
    assert.deepEqual(searchCaptions(OWNER, "motorbike").map((m) => m.assetId), [asset(3)]);
    assert.deepEqual(searchCaptions(OWNER, "ticket").map((m) => m.assetId), [asset(2)]);
    assert.deepEqual(searchCaptions(OWNER, "birthday goa"), []);
  });

  test("only ever returns the user's own photos", () => {
    assert.deepEqual(searchCaptions(OTHER, "cake").map((m) => m.assetId), [asset(4)]);
    assert.ok(!searchCaptions(OWNER, "cake").some((m) => m.assetId === asset(4)));
  });

  test("search syntax in the query is treated as plain words", () => {
    for (const q of ['"', "cake*", "cake OR goa", "NEAR(cake goa)", "caption:cake", "-", ""]) {
      assert.doesNotThrow(() => searchCaptions(OWNER, q), q);
    }
    assert.deepEqual(searchCaptions(OWNER, ""), []);
  });

  test("a re-imported caption replaces the old one, and its old words stop matching", () => {
    writeFileSync(file, line(1, "A chocolate dessert at a party.", ["Party"]));
    assert.deepEqual(importCaptions(file), { imported: 1, skipped: 0, total: 4 });
    assert.deepEqual(searchCaptions(OWNER, "candles"), []);
    assert.deepEqual(searchCaptions(OWNER, "chocolate").map((m) => m.assetId), [asset(1)]);
  });

  test("the backup copy's index still points at the right photos", () => {
    database().prepare("DELETE FROM captions WHERE asset_id = ?").run(asset(2));
    assert.deepEqual(searchCaptions(OWNER, "boarding"), []);
    assert.deepEqual(searchCaptions(OWNER, "ticket"), []);
    const orphans = database().prepare("SELECT count(*) AS n FROM caption_tags WHERE caption_id NOT IN (SELECT id FROM captions)").get() as { n: number };
    assert.equal(orphans.n, 0);
    snapshotDatabase();
    const copy = new DatabaseSync(join(dataDir, "backup", "memento-extras.db"), { readOnly: true });
    const rows = copy.prepare(`
      SELECT c.asset_id FROM captions_fts JOIN captions c ON c.id = captions_fts.rowid WHERE captions_fts MATCH ?
    `).all('"enfield"') as { asset_id: string }[];
    copy.close();
    assert.deepEqual(rows.map((r) => r.asset_id), [asset(3)]);
  });
});

describe("the backlog script", () => {
  const dir = mkdtempSync(join(tmpdir(), "memento-backlog-"));
  const assetsFile = join(dir, "assets.tsv");
  const out = join(dir, "captions.jsonl");
  const requests: { server: number; image: string }[] = [];
  const servers: Server[] = [];
  const urls: string[] = [];

  const llama = (n: number): Server =>
    fakeLlama({
      reply: (image) => {
        requests.push({ server: n, image });
        return image === "bad" ? { content: "I can't help with that." }
          : image === "thinker" ? { content: '{"caption": "A cat.", "tags": []}', reasoning_content: "Let me think..." }
          : { content: JSON.stringify({ caption: `A photo called ${image}.`, tags: ["Pet", "Unknown"] }) };
      },
    });

  function run(...extra: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning", "src/scripts/caption-backlog.ts",
        "--assets", assetsFile, "--out", out, "--llama", urls.join(","), "--concurrency", "2", ...extra,
      ], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d));
      child.stderr.on("data", (d: Buffer) => (output += d));
      child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`exit ${code}: ${output}`))));
    });
  }

  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  before(async () => {
    for (const n of [0, 1]) {
      const server = llama(n);
      servers.push(server);
      urls.push(`http://127.0.0.1:${await listen(server)}`);
    }
    const rows: string[] = [];
    for (const [n, content] of [[1, "one"], [2, "two"], [3, "bad"], [4, "three"], [5, "thinker"]] as const) {
      writeFileSync(join(dir, `${n}.jpg`), content);
      rows.push([asset(n), OWNER, "IMAGE", join(dir, `${n}.jpg`)].join("\t"));
    }
    rows.push([asset(6), OWNER, "VIDEO", join(dir, "missing.jpg")].join("\t"));
    writeFileSync(assetsFile, rows.join("\n") + "\n");
  });

  after(() => servers.forEach((s) => s.close()));

  test("--limit does only that many", async () => {
    await run("--limit", "1");
    assert.equal(lines(out).length, 1);
  });

  test("captions the rest, records failures separately, spreads the work", async () => {
    const output = await run();
    const results = lines(out);
    assert.deepEqual(results.map((r) => r.assetId).sort(), [asset(1), asset(2), asset(4)]);
    const first = results.find((r) => r.assetId === asset(1));
    assert.equal(first.model, "fake-vl.gguf");
    assert.deepEqual(first.tags, ["Pet"]);
    assert.equal(first.promptTokens, 300);
    const errors = lines(`${out}.errors.jsonl`);
    assert.deepEqual(errors.map((e) => e.assetId).sort(), [asset(3), asset(5), asset(6)]);
    assert.match(errors.find((e) => e.assetId === asset(5)).error, /thought/);
    assert.equal(requests.filter((r) => r.image === "bad").length, 2);
    assert.ok(requests.some((r) => r.server === 0) && requests.some((r) => r.server === 1));
    assert.match(output, /"event":"finished"/);
  });

  test("a second run only retries the failures, and its results import", async () => {
    const before = requests.length;
    writeFileSync(out, readFileSync(out, "utf8") + '{"assetId": "half a li');
    await run();
    const tried = requests.slice(before).map((r) => r.image);
    assert.ok(!tried.includes("one") && !tried.includes("two") && !tried.includes("three"));
    assert.ok(tried.includes("bad") && tried.includes("thinker"));
    assert.equal(importCaptions(out).imported, 3);
    closeDatabase();
  });
});
