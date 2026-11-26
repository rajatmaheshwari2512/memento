// Captions: the checks, storage and search, and asking a fake llama-server for a photo's caption.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import type { Tag } from "../src/types/captions.types.ts";
import { TAGS } from "../src/constants/captions.constants.ts";
import { fakeLlama, listen } from "./helpers.ts";

const dataDir = mkdtempSync(join(tmpdir(), "memento-captions-"));
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "test";
process.env.MEMENTO_SECRET ??= "A".repeat(44);
const { captionPhoto, captionRequest, modelName } = await import("../src/services/captions.service.ts");
const { parseCaption } = await import("../src/schemas/captions.schema.ts");
const { saveCaption, searchCaptions } = await import("../src/services/repositories/captions.repository.ts");
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

  test("the request carries the image, the tag list, the JSON shape and no thinking", () => {
    const body = captionRequest(Buffer.from("jpeg")) as any;
    assert.equal(body.messages[0].content[0].image_url.url, "data:image/jpeg;base64," + Buffer.from("jpeg").toString("base64"));
    assert.match(body.messages[0].content[1].text, /Receipt/);
    assert.deepEqual(body.response_format.json_schema.schema.properties.tags.items.enum, [...TAGS]);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
  });
});

describe("storage and search", () => {
  const save = (n: number, caption: string, tags: Tag[] = [], owner = OWNER) =>
    saveCaption({ assetId: asset(n), ownerId: owner, model: "test-model", caption, tags });

  after(() => closeDatabase());

  test("saves captions", () => {
    save(1, "Two children blowing out candles on a birthday cake.", ["Birthday", "Food"]);
    save(2, "A boarding pass for an IndiGo flight to Goa.", ["Ticket"]);
    save(3, "A Royal Enfield motorbike parked by the sea.", ["Motorbike", "Beach"]);
    save(4, "A cake on a table in someone else's house.", ["Food"], OTHER);
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

  test("a re-saved caption replaces the old one, and its old words stop matching", () => {
    save(1, "A chocolate dessert at a party.", ["Party"]);
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

describe("asking llama-server for a caption", () => {
  const dir = mkdtempSync(join(tmpdir(), "memento-captionphoto-"));
  const photo = (image: string) => {
    const path = join(dir, `${image}.jpg`);
    writeFileSync(path, image);
    return { id: asset(1), ownerId: OWNER, path, uploadedAt: "" };
  };
  let server: Server;
  let url: string;

  before(async () => {
    server = fakeLlama({
      reply: (image) =>
        image === "bad" ? { content: "I can't help with that." }
          : image === "thinker" ? { content: '{"caption": "A cat.", "tags": []}', reasoning_content: "Let me think..." }
          : { content: JSON.stringify({ caption: `A photo called ${image}.`, tags: ["Pet", "Unknown"] }) },
    });
    url = `http://127.0.0.1:${await listen(server)}`;
  });

  after(() => server.close());

  test("a good reply becomes a record, with the model's name and only known tags", async () => {
    const model = await modelName(url);
    assert.equal(model, "fake-vl.gguf");
    assert.deepEqual(await captionPhoto(url, model, photo("one"), 5000), {
      assetId: asset(1), ownerId: OWNER, model, caption: "A photo called one.", tags: ["Pet"],
    });
  });

  test("an unusable reply, or a model that thought first, throws", async () => {
    await assert.rejects(captionPhoto(url, "m", photo("bad"), 5000), /unusable reply/);
    await assert.rejects(captionPhoto(url, "m", photo("thinker"), 5000), /thought/);
  });
});
