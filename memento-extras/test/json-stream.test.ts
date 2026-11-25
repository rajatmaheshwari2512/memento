// Reading JSON as it arrives (utils/json-stream.ts), base64 to and from files a piece at a time
// (utils/base64-file.ts), and reading Gemini's reply that way (clients/gemini.client.ts): the
// same results as reading everything whole, however the bytes are split. Run: npm test

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Base64ToFile, base64Length, base64OfFile } from "../src/utils/base64-file.ts";
import { readJsonStream, type JsonPath, type JsonRoute, type JsonStreamOptions, type StringSink } from "../src/utils/json-stream.ts";

process.env.GEMINI_API_KEY ??= "test-key-not-real"; // config.ts needs one; nothing is sent
const { readReply, resultOf } = await import("../src/clients/gemini.client.ts");

const folder = mkdtempSync(join(tmpdir(), "memento-extras-json-stream-"));
after(() => rmSync(folder, { recursive: true, force: true }));

// The bytes in pieces of `size` (0: one piece; -1: random sizes from 1 to 50).
async function* pieces(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let at = 0; at < bytes.length; ) {
    const n = size === 0 ? bytes.length : size > 0 ? size : 1 + Math.floor(Math.random() * 50);
    yield bytes.subarray(at, at + n);
    at += n;
  }
}
const SPLITS = [0, 1, 2, 3, 7, 64, -1];

// A web stream of the pieces (a fetch Response's body).
function streamOf(source: AsyncGenerator<Buffer>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const next = await source.next();
      if (next.done) controller.close();
      else controller.enqueue(new Uint8Array(next.value));
    },
  });
}

class TooLarge extends Error {}
class Invalid extends Error {}

const read = (json: string | Buffer, split: number, options: Partial<JsonStreamOptions> = {}) =>
  readJsonStream(pieces(Buffer.from(json), split), {
    route: () => "keep",
    sink: () => {
      throw new Error("nothing is streamed");
    },
    maxBytes: 1024 * 1024,
    maxKeptBytes: 1024 * 1024,
    tooLarge: () => new TooLarge(),
    invalid: () => new Invalid(),
    ...options,
  });

// A sink that keeps what it's given.
class Collect implements StringSink {
  text = "";
  ended = false;
  async write(text: string) {
    this.text += text;
  }
  async end() {
    this.ended = true;
  }
}

const DOCUMENTS = [
  `{"a":1,"b":[true,false,null],"c":{"d":"e"},"f":[]}`,
  ` \n\t{ "nested" : { "deeper" : [ [ 1 , 2 ] , { } , "x" ] } } \r\n`,
  `{"escapes":"quote \\" backslash \\\\ slash \\/ \\b\\f\\n\\r\\t \\u00e9 \\ud83d\\ude00 end"}`,
  `{"hindi":"थोड़ा गर्म करो","emoji":"🌅✨","mixed":"a\\u0915b"}`,
  `{"numbers":[0,-0,1.5,-2.25e10,1E-3,123456789012345678901234567890]}`,
  `[1,"two",{"three":3}]`,
  `"just a string"`,
  `42`,
  `true`,
  `null`,
  `{"dup":1,"dup":2}`,
  `{"__proto__":{"polluted":true},"x":1}`,
];

test("kept values come out exactly as JSON.parse gives them, however the JSON is split", async () => {
  for (const doc of DOCUMENTS) {
    for (const split of SPLITS) {
      assert.deepEqual(await read(doc, split), JSON.parse(doc), `${doc} in pieces of ${split}`);
      assert.deepEqual(await read(doc, split, { route: () => "open" }), JSON.parse(doc), `${doc} opened, in pieces of ${split}`);
    }
  }
  const proto = (await read(`{"__proto__":{"polluted":true}}`, 1)) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(proto), Object.prototype, "__proto__ is an own key, as with JSON.parse");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(await read("", 0), undefined, "an empty body is nothing");
});

test("what isn't JSON is refused, wherever it's split", async () => {
  const bad = [
    " ", "{", "}", "[1,]", `{"a":1,}`, `{"a" 1}`, "{a:1}", "[1 2]", `"abc`, "tru", "01", "1 2", "[1]x", `{"a":"\\x"}`,
    `{"a":"\u0001"}`, `{"a":1}}`, `[`, `{"a":}`, `{,}`, "+1", "NaN", `{"a":"b"c}`, `["a" "b"]`, `[1,,2]`,
  ];
  for (const doc of bad) {
    for (const split of [0, 1]) {
      await assert.rejects(read(doc, split, { route: () => "open" }), Invalid, `${JSON.stringify(doc)} in pieces of ${split}`);
    }
  }
});

test("a streamed string reaches its sink with its escapes decoded, even when one is split; it's left out of what's kept", async () => {
  const doc = `{"a":1,"img":"QUJD\\/REVG\\u003d\\u003d","b":[true],"n":7}`;
  for (const split of SPLITS) {
    const sink = new Collect();
    const paths: JsonPath[] = [];
    const kept = await read(doc, split, {
      route: (path) => (path.length === 0 ? "open" : path[0] === "img" || path[0] === "n" ? "stream" : "keep"),
      sink: (path) => {
        paths.push(path);
        return sink;
      },
    });
    assert.equal(sink.text, "QUJD/REVG==", `pieces of ${split}`);
    assert.ok(sink.ended);
    assert.deepEqual(paths, [["img"]], "only strings are streamed");
    assert.deepEqual(kept, { a: 1, b: [true], n: 7 });
  }
});

test("skipped values are left out (an array keeps their places); opened ones ask about each value inside", async () => {
  const doc = `{"keep":{"x":[1,{"y":2}]},"skip":{"big":"${"z".repeat(5000)}"},"list":[{"t":"a","drop":1},"s",{"t":"b"}]}`;
  const asked: string[] = [];
  const route = (path: JsonPath): JsonRoute => {
    asked.push(path.join("."));
    if (path.length === 0 || path[0] === "list") return path.length === 3 && path[2] === "drop" ? "skip" : path.length === 2 && path[1] === 1 ? "skip" : "open";
    return path[0] === "keep" ? "keep" : "skip";
  };
  for (const split of SPLITS) {
    asked.length = 0;
    const kept = await read(doc, split, { route, maxKeptBytes: 200 });
    assert.deepEqual(kept, { keep: { x: [1, { y: 2 }] }, list: [{ t: "a" }, undefined, { t: "b" }] });
    assert.deepEqual(asked, ["", "keep", "skip", "list", "list.0", "list.0.t", "list.0.drop", "list.1", "list.2", "list.2.t"]);
  }
});

test("limits: the whole JSON, and what's kept (skipped and streamed bytes don't count); a long kept string can be cut", async () => {
  const doc = JSON.stringify({ a: "x".repeat(1000), img: "A".repeat(5000) });
  await assert.rejects(read(doc, 7, { maxBytes: 4000 }), TooLarge);
  await assert.rejects(read(doc, 7, { maxKeptBytes: 500 }), TooLarge);
  const kept = await read(doc, 7, {
    maxKeptBytes: 1100,
    route: (path) => (path.length === 0 ? "open" : path[0] === "img" ? "stream" : "keep"),
    sink: () => new Collect(),
  });
  assert.deepEqual(kept, { a: "x".repeat(1000) });
  // Cut at 10 bytes: whatever escape the cut falls in is dropped, never broken.
  for (const text of ["0123456789abc", "012345678\\nabc", "0123456\\u00e9abc", "01234567\\\\abc", "012345678\\\"abc"]) {
    for (const split of [0, 1, 3]) {
      const cut = (await read(`{"t":"${text}"}`, split, { maxStringBytes: 10 })) as { t: string };
      assert.ok(JSON.parse(`"${text}"`).startsWith(cut.t) && cut.t.length >= 7, `${text}: ${JSON.stringify(cut.t)}`);
    }
  }
});

test("limits: brackets and commas count towards what's kept, and objects and arrays can't nest deeper than maxDepth, kept or skipped", async () => {
  const empties = `{"x":[${Array.from({ length: 5000 }, () => "[]").join(",")}]}`;
  await assert.rejects(read(empties, 64, { maxKeptBytes: 4096 }), TooLarge);
  assert.equal(((await read(empties, 64, { route: (path) => (path.length === 0 ? "open" : "skip"), maxKeptBytes: 64 })) as object).constructor, Object);
  const deep = "[".repeat(100) + "]".repeat(100);
  await assert.rejects(read(deep, 7, { maxKeptBytes: 1024 * 1024 }), TooLarge);
  await assert.rejects(read(deep, 7, { route: () => "skip" }), TooLarge);
  assert.deepEqual(await read("[".repeat(64) + "]".repeat(64), 7), JSON.parse("[".repeat(64) + "]".repeat(64)));
});

test("a file in base64, a piece at a time: the same as all at once, for every size around a piece's edge", async () => {
  for (const size of [0, 1, 2, 3, 4, 5, 49151, 49152, 49153, 49154, 150001]) {
    const bytes = randomBytes(size);
    const path = join(folder, `in-${size}`);
    writeFileSync(path, bytes);
    const out: Buffer[] = [];
    for await (const piece of base64OfFile(path)) {
      assert.equal(piece.length % 4, 0, "each piece stands on its own");
      out.push(piece);
    }
    assert.equal(Buffer.concat(out).toString("latin1"), bytes.toString("base64"), `${size} bytes`);
    assert.equal(base64Length(size), bytes.toString("base64").length);
  }
});

// Decodes `text` into a file with Base64ToFile, in pieces of `split` characters.
async function decode(text: string, split: number, options: { strict: boolean; maxBytes?: number }) {
  const sink = new Base64ToFile(join(folder, `out-${Math.random()}`), { maxBytes: Infinity, ...options });
  try {
    for (let at = 0; at < text.length; ) {
      const n = split === 0 ? text.length : split > 0 ? split : 1 + Math.floor(Math.random() * 9);
      await sink.write(text.slice(at, at + n));
      at += n;
    }
    await sink.end();
  } finally {
    await sink.close();
  }
  return { sink, bytes: readFileSync(sink.path) };
}

test("base64 into a file, a piece at a time: strict takes exactly what /^[A-Za-z0-9+/]+={0,2}$/ takes, and decodes as Buffer.from", async () => {
  const photo = randomBytes(1000);
  photo.set([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const cases = [
    photo.toString("base64"), photo.subarray(0, 998).toString("base64"), photo.subarray(0, 999).toString("base64"),
    "QUJD", "QUI=", "QQ==", "QQ", "Q", "", "==", "QQ===", "QQ=Q", "QU JD", "QUJD\n", "QU-_", "QU=D", "Q=", "é",
  ];
  for (const text of cases) {
    const valid = /^[A-Za-z0-9+/]+={0,2}$/.test(text);
    for (const split of [0, 1, 3, -1]) {
      const { sink, bytes } = await decode(text, split, { strict: true });
      assert.equal(sink.valid, valid, `${JSON.stringify(text.slice(0, 20))} in pieces of ${split}`);
      assert.equal(sink.chars, text.length);
      if (valid) {
        assert.deepEqual(bytes, Buffer.from(text, "base64"));
        assert.equal(sink.bytes, bytes.length);
        assert.deepEqual(sink.head, bytes.subarray(0, 12));
      }
    }
  }
  // Past its limit, nothing more is written, but it's still counted.
  const { sink, bytes } = await decode(photo.toString("base64"), 7, { strict: true, maxBytes: 100 });
  assert.ok(bytes.length <= 108 && sink.chars === photo.toString("base64").length);
});

test("base64 into a file, leniently (Gemini's reply): line breaks and the like are ignored, as Buffer.from does", async () => {
  const bytes = randomBytes(3000);
  const wrapped = bytes.toString("base64").replace(/.{76}/g, "$&\r\n");
  for (const split of [0, 1, 5, -1]) {
    const out = await decode(wrapped, split, { strict: false });
    assert.deepEqual(out.bytes, bytes);
    assert.deepEqual(out.bytes, Buffer.from(wrapped, "base64"));
  }
  const urlSafe = bytes.toString("base64url");
  assert.deepEqual((await decode(urlSafe, 7, { strict: false })).bytes, Buffer.from(urlSafe, "base64"));
});

// What the reply gave, read the old way: the whole JSON parsed at once.
function readWhole(json: string) {
  const result = JSON.parse(json) as { status?: string; steps?: Array<{ content?: Array<{ type?: string; text?: string; data?: string }> }> };
  const contents = (result.steps ?? []).flatMap((step) => step.content ?? []);
  const image = contents.filter((c) => c.type === "image" && typeof c.data === "string").at(-1);
  const said = contents.filter((c) => c.type === "text" && c.text).map((c) => c.text).join(" ").trim();
  return { image: result.status === "completed" && image?.data ? Buffer.from(image.data, "base64") : null, said };
}

const IMAGE_A = randomBytes(5000);
const IMAGE_B = randomBytes(7000);
const b64 = (bytes: Buffer) => bytes.toString("base64");
const REPLIES = {
  plain: JSON.stringify({ status: "completed", steps: [{ content: [{ type: "image", mime_type: "image/jpeg", data: b64(IMAGE_A) }] }] }),
  "keys in another order": `{"steps":[{"content":[{"data":"${b64(IMAGE_A)}","mime_type":"image/jpeg","type":"image"}],"type":"model_output"}],"status":"completed"}`,
  "two images: the last": JSON.stringify({
    status: "completed",
    steps: [{ content: [{ type: "image", data: b64(IMAGE_A) }] }, { content: [{ type: "text", text: "here" }, { type: "image", data: b64(IMAGE_B) }] }],
  }),
  "text only": JSON.stringify({ status: "completed", steps: [{ content: [{ type: "text", text: "  I can't edit this photo." }, { type: "text", text: "Sorry. " }] }] }),
  "not completed": JSON.stringify({ status: "failed", steps: [{ content: [{ type: "image", data: b64(IMAGE_A) }] }] }),
  "empty image": JSON.stringify({ status: "completed", steps: [{ content: [{ type: "image", data: "" }] }] }),
  "nothing": JSON.stringify({ status: "completed" }),
  "fields we don't use": JSON.stringify({
    id: "x", status: "completed", usage: { total_tokens: 5 }, model: { name: "m" },
    steps: [
      { type: "thought", signature: b64(randomBytes(3000)), content: [{ type: "thought", data: "not an image", annotations: [{ a: [1, 2] }] }] },
      { content: [{ type: "image", mime_type: "image/jpeg", data: b64(IMAGE_B), extra: { deep: [{ data: "x" }] } }] },
    ],
  }),
  "escaped and wrapped base64": JSON.stringify({ status: "completed", steps: [{ content: [{ type: "image", data: b64(IMAGE_A).replace(/.{76}/g, "$&\n") }] }] })
    .replaceAll("/", "\\/").replaceAll("=", "\\u003d"),
};

test("Gemini's reply, read as it arrives: the same image and words as reading it whole, whatever the order or the split", async () => {
  for (const [name, json] of Object.entries(REPLIES)) {
    const expected = readWhole(json);
    for (const split of [0, 1, 7, -1]) {
      const reply = await readReply(new Response(streamOf(pieces(Buffer.from(json), split))), mkdtempSync(join(folder, "reply-")));
      const { image, said } = resultOf(reply);
      assert.equal(said, expected.said, `${name}, pieces of ${split}`);
      assert.deepEqual(image ? readFileSync(image.path) : null, expected.image, `${name}, pieces of ${split}`);
    }
  }
});

test("Gemini's reply: a long text is cut, not refused, so the person still sees why", async () => {
  const json = JSON.stringify({ status: "completed", steps: [{ content: [{ type: "text", text: `No. ${"words ".repeat(50_000)}` }] }] });
  const { image, said } = resultOf(await readReply(new Response(json), mkdtempSync(join(folder, "reply-"))));
  assert.equal(image, null);
  assert.ok(said.startsWith("No. words words") && said.length <= 64 * 1024);
});
