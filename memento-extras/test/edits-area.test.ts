// AI tools: edit of a highlighted area, sizes, the AI tools switch, turns, logging, saving the pasted photo.
// Runs the real service against a fake Immich and a fake Gemini. Run: npm test

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EDITS_AT_ONCE } from "../src/constants/edits.constants.ts";
import { call as callService, freePort, json, listen, readBody, Service, type CallOptions } from "./helpers.ts";

const jpeg = (width: number, height: number, fill = 7) =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
    ...new Array<number>(60).fill(fill), 0xff, 0xd9,
  ]);
const ORIGINAL = jpeg(4080, 3072, 1);
const PHOTO = jpeg(3072, 2313, 2);
const MARK = jpeg(1536, 1157, 3);
const RESULT = jpeg(4096, 3088, 4);
const OWNER = { id: "11111111-1111-4111-8111-111111111111", name: "Owner", isAdmin: true };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "Other", isAdmin: false };
const PHONE_PHOTO = "33333333-3333-4333-8333-333333333333";
const SMALL_PHOTO = "55555555-5555-4555-8555-555555555555";
const CROPPED_PHOTO = "66666666-6666-4666-8666-666666666666";
const UNSIZED_PHOTO = "77777777-7777-4777-8777-777777777777";
const HUGE_PHOTO = "88888888-8888-4888-8888-888888888888";
const LONG_PHOTO = "99999999-9999-4999-8999-999999999999";
const UNSIZED_HUGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIMIT_PHOTO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CROPPED_HUGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAW_PHOTO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COPY = "44444444-4444-4444-8444-444444444444";
const OWNER_COOKIE = "immich_access_token=ownertoken0123456789";
const OTHER_COOKIE = "immich_access_token=othertoken0123456789";

type GeminiCall = {
  size: string; text: string; images: Array<{ mime: string; bytes: Buffer }>;
  keys: string[]; length: string | undefined; chunked: boolean; bodyBytes: number;
};
const geminiCalls: GeminiCall[] = [];
const immichCalls: string[] = [];
const uploads: Array<{ filename: string; bytes: Buffer }> = [];
const stacks: string[][] = [];
let geminiDelayMs = 0;
let geminiActive = 0;
let geminiMostAtOnce = 0;
let immich: Server;
let gemini: Server;
let service: Service;
const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-area-"));

const photo = (id: string, width: number, height: number, shown: { width?: number; height?: number } = { width, height }) => ({
  id, type: "IMAGE", ownerId: OWNER.id, isTrashed: false, originalFileName: "beach day.jpg",
  originalMimeType: "image/jpeg", fileCreatedAt: "2024-05-01T10:00:00.000Z", stack: null,
  localDateTime: "2024-05-01T15:30:00.000Z", ...shown,
  exifInfo: { exifImageWidth: width, exifImageHeight: height, fileSizeInByte: ORIGINAL.length, dateTimeOriginal: "2024-05-01T10:00:00+00:00" },
});

const readAll = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

before(async () => {
  immich = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const who = req.headers.cookie === OWNER_COOKIE ? OWNER : req.headers.cookie === OTHER_COOKIE ? OTHER : null;
    if (!who) return json(res, 401, {});
    if (path !== "/api/users/me") immichCalls.push(`${req.method} ${path}`);
    if (path === "/api/users/me") return json(res, 200, who);
    if (req.method === "GET" && path === `/api/assets/${PHONE_PHOTO}`) return json(res, 200, photo(PHONE_PHOTO, 4080, 3072));
    if (req.method === "GET" && path === `/api/assets/${SMALL_PHOTO}`) return json(res, 200, photo(SMALL_PHOTO, 1600, 1200));
    if (req.method === "GET" && path === `/api/assets/${CROPPED_PHOTO}`) return json(res, 200, photo(CROPPED_PHOTO, 4080, 3072, { width: 2000, height: 1500 }));
    if (req.method === "GET" && path === `/api/assets/${UNSIZED_PHOTO}`) return json(res, 200, photo(UNSIZED_PHOTO, 4080, 3072, {}));
    if (req.method === "GET" && path === `/api/assets/${HUGE_PHOTO}`) return json(res, 200, photo(HUGE_PHOTO, 10_001, 10_000));
    if (req.method === "GET" && path === `/api/assets/${LONG_PHOTO}`) return json(res, 200, photo(LONG_PHOTO, 12_001, 1000));
    if (req.method === "GET" && path === `/api/assets/${UNSIZED_HUGE}`) return json(res, 200, photo(UNSIZED_HUGE, 11_000, 10_000, {}));
    if (req.method === "GET" && path === `/api/assets/${LIMIT_PHOTO}`) return json(res, 200, photo(LIMIT_PHOTO, 12_000, 8333));
    if (req.method === "GET" && path === `/api/assets/${CROPPED_HUGE}`) return json(res, 200, photo(CROPPED_HUGE, 20_000, 15_000, { width: 4000, height: 3000 }));
    if (req.method === "GET" && path === `/api/assets/${RAW_PHOTO}`) return json(res, 200, photo(RAW_PHOTO, 6000, 4000));
    if (path.endsWith("/original")) return void res.writeHead(200, { "content-type": "image/jpeg" }).end(ORIGINAL);
    if (req.method === "POST" && path === "/api/assets") {
      const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(await readAll(req)) }).formData();
      const file = form.get("assetData") as File;
      uploads.push({ filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      return json(res, 201, { id: COPY, status: "created" });
    }
    if (req.method === "PUT" && path === `/api/assets/${COPY}`) return json(res, 200, {});
    if (req.method === "POST" && path === "/api/stacks") {
      stacks.push((JSON.parse(await readBody(req)) as { assetIds: string[] }).assetIds);
      return json(res, 201, {});
    }
    json(res, 404, {});
  });
  gemini = createServer(async (req, res) => {
    const raw = await readAll(req);
    const body = JSON.parse(raw.toString("utf8")) as {
      input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
      response_format: { image_size: string };
    };
    const call = {
      size: body.response_format.image_size,
      text: body.input.find((i) => i.type === "text")?.text ?? "",
      images: body.input.filter((i) => i.type === "image").map((i) => ({ mime: i.mime_type!, bytes: Buffer.from(i.data!, "base64") })),
      keys: Object.keys(body),
      length: req.headers["content-length"],
      chunked: req.headers["transfer-encoding"] !== undefined,
      bodyBytes: raw.length,
    };
    geminiCalls.push(call);
    geminiActive++;
    geminiMostAtOnce = Math.max(geminiMostAtOnce, geminiActive);
    await new Promise((resolve) => setTimeout(resolve, geminiDelayMs));
    geminiActive--;
    if (call.text.includes("BADREQUEST")) {
      return json(res, 400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "the secret walrus in your prompt" } });
    }
    if (call.text.includes("REFUSE")) {
      return json(res, 200, { status: "completed", steps: [{ content: [{ type: "text", text: "I won't do that to the secret pony picture" }] }] });
    }
    json(res, 200, { status: "completed", steps: [{ content: [{ type: "image", mime_type: "image/jpeg", data: RESULT.toString("base64") }] }] });
  });
  service = new Service(await freePort(), {
    IMMICH_URL: `http://127.0.0.1:${await listen(immich)}`,
    GEMINI_URL: `http://127.0.0.1:${await listen(gemini)}/v1beta/interactions`,
    GEMINI_API_KEY: "test-key-not-real",
    DATA_DIR: dataDir,
    DAILY_LIMIT_PER_USER: "1000",
    MONTHLY_LIMIT_TOTAL: "1000",
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

const call = (method: string, path: string, opts: CallOptions = {}) => callService(service.base, method, path, opts);
const b64 = (bytes: Buffer) => bytes.toString("base64");
const edit = (json: Record<string, unknown>, cookie = OWNER_COOKIE) =>
  call("POST", "/edits", { cookie, json: { assetId: PHONE_PHOTO, prompt: "make it warmer", ...json } });
const areaEdit = (json: Record<string, unknown>, cookie = OWNER_COOKIE) =>
  call("POST", "/edits/area", { cookie, json: { assetId: PHONE_PHOTO, prompt: "remove the car", mark: b64(MARK), photo: b64(PHOTO), ...json } });
const setFlags = (json: unknown) => call("PUT", "/flags", { cookie: OWNER_COOKIE, json });
const saveArea = (id: string, body: Buffer, opts: { cookie?: string; type?: string } = {}) =>
  fetch(`${service.base}/edits/${id}/save-area`, {
    method: "POST",
    headers: { cookie: opts.cookie ?? OWNER_COOKIE, "content-type": opts.type ?? "image/jpeg" },
    body: new Uint8Array(body),
  });

test("a highlighted edit: Gemini gets the app's upright photo, then the marked copy, and is told to change only that area", async () => {
  geminiCalls.length = 0;
  immichCalls.length = 0;
  const made = await areaEdit({});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const [sent] = geminiCalls;
  assert.deepEqual(sent!.images.map((i) => i.bytes), [PHOTO, MARK]);
  assert.match(sent!.text, /second attached image .* tinted red/);
  assert.match(sent!.text, /change only the highlighted area/);
  assert.match(sent!.text, /Instruction: remove the car$/);
  assert.deepEqual(immichCalls.filter((c) => c.endsWith("/original")), []);

  const more = await areaEdit({ fromEditId: made.body.editId, photo: undefined });
  assert.equal(more.status, 201, JSON.stringify(more.body));
  assert.deepEqual(geminiCalls[1]!.images.map((i) => i.bytes), [RESULT, MARK]);

  await edit({});
  assert.deepEqual(geminiCalls[2]!.images.map((i) => i.bytes), [ORIGINAL]);
  assert.doesNotMatch(geminiCalls[2]!.text, /tinted red/);
});

test("sizes are automatic, by the photo: 4K over ~5 MP, else 2K, for every edit; the admin's switch can make them 2K", async () => {
  await setFlags({ gemini: { allow4k: true } });
  geminiCalls.length = 0;
  const size = async (request: Promise<{ body: { size: string } }>) => (await request).body.size;
  assert.equal(await size(edit({})), "4K", "typed, as from any app build");
  assert.equal(await size(edit({ tools: ["unblur"] })), "4K");
  assert.equal(await size(areaEdit({})), "4K");
  assert.equal(await size(edit({ assetId: SMALL_PHOTO })), "2K");
  assert.equal(await size(areaEdit({ assetId: SMALL_PHOTO })), "2K");
  assert.equal(await size(edit({ assetId: CROPPED_PHOTO })), "2K");
  await setFlags({ gemini: { allow4k: false } });
  assert.equal(await size(areaEdit({})), "2K");
  await setFlags({ gemini: { allow4k: true } });
  assert.deepEqual(geminiCalls.map((c) => c.size), ["4K", "4K", "4K", "2K", "2K", "2K", "2K"]);
  const limits = await call("GET", "/limits", { cookie: OWNER_COOKIE });
  assert.equal(limits.body.fourKOverPixels, 5_250_000, "so the apps show the price of that size");
});

test("presets name their tools; bad names are refused", async () => {
  geminiCalls.length = 0;
  assert.equal((await edit({ tools: ["unblur"], prompt: "Make the photo sharp" })).status, 201);
  for (const bad of ["Unblur", "../x", 7, "a".repeat(41)]) assert.equal((await edit({ tools: [bad] })).status, 400, String(bad));
  assert.equal(geminiCalls.length, 1);
});

test("several presets in one edit: 1 to 3 different tools, sent as `tools`", async () => {
  geminiCalls.length = 0;
  const combined = "Make all of these changes to the photo in one edit:\n- Enhance it\n- A new sky\n- Watercolour\n- make it warmer";
  const made = await edit({ tools: ["enhance", "sky", "watercolour"], prompt: combined });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.ok(geminiCalls[0]!.text.endsWith(`Instruction: ${combined}`), "the app's joined instruction, as it is");
  assert.equal((await edit({ tools: ["unblur"] })).status, 201);
  assert.equal((await areaEdit({ tools: ["enhance", "erase"] })).status, 201);
  assert.equal((await edit({ tools: null })).status, 201, "null counts as not sent");
  for (const bad of [[], ["a", "b", "c", "d"], ["sky", "sky"], ["sky", "Sky"], ["sky", 7], "sky", { 0: "sky" }]) {
    assert.equal((await edit({ tools: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(geminiCalls.length, 4);
});

test("an edit's log names its tools, never the instruction", async () => {
  const made = await edit({ tools: ["relight", "glare"], prompt: "the secret otter instruction" });
  assert.equal(made.status, 201);
  assert.match(service.logs, new RegExp(`"event":"edit","edit":"${made.body.editId}".*"provider":"gemini".*"tools":\\["relight","glare"\\]`));
  const typed = await edit({ prompt: "the secret otter instruction" });
  assert.match(service.logs, new RegExp(`"edit":"${typed.body.editId}".*"tools":\\[\\]`));
  assert.doesNotMatch(service.logs, /secret otter/);
});

test("the instruction may be up to 1500 characters: 3 tools' instructions and 500 typed", async () => {
  assert.equal((await edit({ tools: ["enhance", "relight", "reframe"], prompt: "x".repeat(1500) })).status, 201);
  const long = await edit({ tools: ["enhance", "relight", "reframe"], prompt: "x".repeat(1501) });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /under 1500 characters/);
});

test("a highlighted edit needs its mark, and its photo unless it's Edit more; bad or oversized images are refused before Google is asked", async () => {
  geminiCalls.length = 0;
  assert.equal((await areaEdit({ mark: undefined })).status, 400);
  assert.equal((await areaEdit({ photo: undefined })).status, 400);
  assert.equal((await areaEdit({ mark: "not base64!" })).status, 400);
  assert.equal((await areaEdit({ photo: b64(Buffer.from("<svg>hello there</svg>")) })).status, 415);
  const big = (megabytes: number) => {
    const bytes = Buffer.alloc(megabytes * 1024 * 1024, 1);
    bytes.set([0xff, 0xd8, 0xff]);
    return b64(bytes);
  };
  assert.equal((await areaEdit({ mark: big(3.1) })).status, 413);
  assert.equal((await areaEdit({ photo: big(6.1) })).status, 413);
  assert.equal(await headersOnly("/edits/area", { cookie: OWNER_COOKIE }), 413);
  const chunked = await fetch(`${service.base}/edits/area`, {
    method: "POST",
    headers: { cookie: OWNER_COOKIE, "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ assetId: PHONE_PHOTO, prompt: "x", photo: big(12) })));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit).then((r) => r.status, () => "reset");
  assert.ok(chunked === 413 || chunked === "reset", `got ${chunked}`);
  assert.equal(await headersOnly("/edits", {}, 1024 * 1024), 401);
  assert.equal(await headersOnly("/edits", { cookie: OWNER_COOKIE, "content-type": "text/plain" }, 1024 * 1024), 415);
  assert.equal(await headersOnly("/edits", { cookie: OWNER_COOKIE }), 413);
  const brackets = (junk: string) =>
    fetch(`${service.base}/edits/area`, {
      method: "POST",
      headers: { cookie: OWNER_COOKIE, "content-type": "application/json" },
      body: `{"assetId":"${PHONE_PHOTO}","prompt":"x","mark":"${b64(MARK)}","junk":${junk}}`,
    }).then((r) => r.status);
  assert.equal(await brackets(`[${Array.from({ length: 50_000 }, () => "[]").join(",")}]`), 413);
  assert.equal(await brackets("[".repeat(10_000) + "]".repeat(10_000)), 413);
  assert.deepEqual(geminiCalls, []);
  assert.deepEqual(readdirSync(join(dataDir, "edit-files")), [], "a refused request's files are removed");
});

function headersOnly(path: string, headers: Record<string, string>, length = 13 * 1024 * 1024): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const sent = request(`${service.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(length), ...headers },
    });
    sent.on("response", (res) => {
      resolve(res.statusCode!);
      sent.destroy();
    });
    sent.on("error", reject);
    sent.flushHeaders();
  });
}

test("AI tools switched off: highlighted edits (before their body is read), presets and highlighted saves are refused; typed edits still work", async () => {
  const made = await areaEdit({});
  assert.equal(made.status, 201);
  assert.equal((await setFlags({ gemini: { tools: false } })).status, 200);
  geminiCalls.length = 0;
  const refused = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = request(`${service.base}/edits/area`, {
      method: "POST",
      headers: { cookie: OWNER_COOKIE, "content-type": "application/json", "content-length": "5000000" },
    });
    sent.on("response", async (res) => {
      resolve({ status: res.statusCode!, body: (await readAll(res)).toString() });
      sent.destroy();
    });
    sent.on("error", reject);
    sent.flushHeaders();
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body, /AI tools .* switched off/);
  assert.equal((await edit({ tools: ["unblur"] })).status, 403);
  assert.equal((await edit({ tools: ["unblur", "sky"] })).status, 403);
  assert.equal((await saveArea(made.body.editId, jpeg(4080, 3072))).status, 403);
  assert.deepEqual(geminiCalls, []);
  assert.equal((await edit({})).status, 201);
  await setFlags({ gemini: { tools: true } });
});

test("edits take turns: at most EDITS_AT_ONCE at Google at once; the rest wait and then go", async () => {
  geminiDelayMs = 150;
  geminiMostAtOnce = 0;
  const asked = [...Array.from({ length: EDITS_AT_ONCE }, () => edit({})), areaEdit({}), edit({}), areaEdit({})];
  const answers = await Promise.all(asked);
  geminiDelayMs = 0;
  assert.deepEqual(answers.map((a) => a.status), asked.map(() => 201));
  assert.equal(geminiMostAtOnce, EDITS_AT_ONCE);
  assert.deepEqual(readdirSync(join(dataDir, "edit-files")), [], "each edit's files are removed when it ends");
});

test("an edit whose request was closed while it waited its turn isn't made: no call to Google, nothing counted", async () => {
  geminiDelayMs = 300;
  geminiCalls.length = 0;
  const before = (await call("GET", "/limits", { cookie: OWNER_COOKIE })).body.today.used as number;
  const running = Array.from({ length: EDITS_AT_ONCE }, () => edit({}));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise<void>((resolve) => {
    const body = JSON.stringify({ assetId: PHONE_PHOTO, prompt: "left before its turn" });
    const sent = request(`${service.base}/edits`, {
      method: "POST",
      headers: { cookie: OWNER_COOKIE, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    sent.on("error", () => {});
    sent.end(body);
    setTimeout(() => {
      sent.destroy();
      resolve();
    }, 100);
  });
  await Promise.all(running);
  await new Promise((resolve) => setTimeout(resolve, 400));
  geminiDelayMs = 0;
  assert.equal(geminiCalls.length, EDITS_AT_ONCE);
  assert.ok(!geminiCalls.some((c) => c.text.includes("left before its turn")));
  assert.equal((await call("GET", "/limits", { cookie: OWNER_COOKIE })).body.today.used, before + EDITS_AT_ONCE);
});

test("Google's error message isn't logged either: only its status and code", async () => {
  const failed = await edit({ prompt: "BADREQUEST please" });
  assert.equal(failed.status, 422);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(service.logs, /secret walrus/);
  assert.match(service.logs, /"event":"gemini_error","status":400,"code":"INVALID_ARGUMENT"/);
});

test("Gemini's refusal is shown to the person, but its words aren't logged (they can repeat the instruction)", async () => {
  const refused = await edit({ prompt: "REFUSE this please" });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /secret pony/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(service.logs, /secret pony/);
  assert.match(service.logs, /"error":"gemini_refused"/);
});

test("saving a highlighted edit: only the photo the app pasted together, at the photo's size; streamed to Immich, dated, stacked; a retry doesn't upload again", async () => {
  const made = await areaEdit({});
  const id = made.body.editId as string;
  const PASTED = jpeg(4080, 3072, 5);
  assert.equal((await saveArea(id, PASTED, { cookie: OTHER_COOKIE })).status, 404);
  assert.equal((await saveArea(id, PASTED, { type: "application/json" })).status, 415);
  assert.equal((await saveArea(id, Buffer.from("not a jpeg at all"))).status, 415);
  assert.deepEqual(readdirSync(join(dataDir, "adjust-uploads")), [], "a refused upload's file is removed");
  assert.equal((await saveArea("not-an-id", PASTED)).status, 404);
  uploads.length = 0;
  const small = await saveArea(id, jpeg(1920, 1446));
  assert.equal(small.status, 400);
  assert.equal(uploads.length, 0, "nothing uploaded");
  const whole = await edit({});
  assert.equal((await saveArea(whole.body.editId, PASTED)).status, 400);
  stacks.length = 0;

  const saved = await saveArea(id, PASTED);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { assetId: COPY });
  assert.deepEqual(
    uploads.map((u) => u.filename),
    [`beach day-ai-edit-${id.slice(0, 8)}.jpg`],
  );
  assert.deepEqual(uploads.at(-1)?.bytes, PASTED, "the app's photo, not Gemini's result");
  assert.deepEqual(stacks, [[COPY, PHONE_PHOTO]]);
  assert.deepEqual(readdirSync(join(dataDir, "adjust-uploads")), [], "the upload's file is removed");

  const again = await saveArea(id, PASTED);
  assert.deepEqual(await again.json(), { assetId: COPY });
  assert.equal(uploads.length, 1);
});

test("saving a highlighted edit of a photo Immich gives no shown size for: checked against the original's size, either way round", async () => {
  const made = await areaEdit({ assetId: UNSIZED_PHOTO });
  const id = made.body.editId as string;
  assert.equal((await saveArea(id, jpeg(2000, 1500))).status, 400);
  assert.equal((await saveArea(id, jpeg(3072, 4080))).status, 200, "upright, the stored sideways photo's size turned");
});

test("a highlighted edit's whole result is saved only when the app says so (the person chose it)", async () => {
  const made = await areaEdit({});
  const id = made.body.editId as string;
  const plain = await call("POST", `/edits/${id}/save`, { cookie: OWNER_COOKIE, json: {} });
  assert.equal(plain.status, 400);
  uploads.length = 0;
  const whole = await call("POST", `/edits/${id}/save`, { cookie: OWNER_COOKIE, json: { whole: true } });
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  assert.deepEqual(uploads[0]!.bytes, RESULT);
});

const usedToday = async () => (await call("GET", "/limits", { cookie: OWNER_COOKIE })).body.today.used as number;

test("very large photos aren't AI-edited: over 100 MP or 12,000 px on the longer side, as shown; refused (413, photo_too_large) before anything is downloaded or counted", async () => {
  geminiCalls.length = 0;
  immichCalls.length = 0;
  const before = await usedToday();
  for (const assetId of [HUGE_PHOTO, LONG_PHOTO, UNSIZED_HUGE]) {
    for (const refused of [await edit({ assetId }), await areaEdit({ assetId }), await edit({ assetId, tools: ["sky"] })]) {
      assert.equal(refused.status, 413, assetId);
      assert.equal(refused.body.code, "photo_too_large");
      assert.match(refused.body.error, /too large for AI edits/);
    }
  }
  assert.ok(immichCalls.every((c) => /^GET \/api\/assets\/[0-9a-f-]+$/.test(c)), `only the photos' details were read: ${immichCalls.join(", ")}`);
  assert.deepEqual(geminiCalls, []);
  assert.equal(await usedToday(), before);
  assert.equal((await edit({ assetId: LIMIT_PHOTO })).status, 201);
  assert.equal((await areaEdit({ assetId: CROPPED_HUGE })).status, 201);
});

test("saving a highlighted edit of a RAW photo: its full-size picture may be up to 10% smaller, never larger, the same way round and shape (within 1%); a preview is still refused", async () => {
  const id = (await areaEdit({ assetId: RAW_PHOTO })).body.editId as string;
  uploads.length = 0;
  for (const [width, height] of [[6001, 4000], [6000, 4001], [4000, 6000], [3600, 5400], [5760, 3700], [5399, 3600], [5400, 3599], [1920, 1280]] as const) {
    assert.equal((await saveArea(id, jpeg(width, height))).status, 400, `${width}×${height}`);
  }
  assert.equal(uploads.length, 0, "nothing uploaded");
  for (const [width, height] of [[6000, 4000], [5760, 3840], [5400, 3600], [5450, 3620]] as const) {
    const each = (await areaEdit({ assetId: RAW_PHOTO })).body.editId as string;
    assert.equal((await saveArea(each, jpeg(width, height))).status, 200, `${width}×${height}`);
  }
  const unsized = (await areaEdit({ assetId: UNSIZED_PHOTO })).body.editId as string;
  assert.equal((await saveArea(unsized, jpeg(3600, 2700))).status, 400, "a little smaller, but sideways and the wrong shape");
  assert.equal((await saveArea(unsized, jpeg(2765, 3672))).status, 200, "upright, 90% of the original");
});

test("the request to Google: its exact length up front (not sent in pieces of unknown length), the JSON as before, an instruction in any language", async () => {
  geminiCalls.length = 0;
  const prompt = "थोड़ा गर्म करो 🌅 \"quoted\" and \\ a backslash";
  assert.equal((await edit({ prompt })).status, 201);
  assert.equal((await areaEdit({ prompt })).status, 201);
  assert.equal(geminiCalls.length, 2);
  for (const sent of geminiCalls) {
    assert.equal(sent.length, String(sent.bodyBytes));
    assert.equal(sent.chunked, false);
    assert.ok(sent.text.endsWith(`Instruction: ${prompt}`));
    assert.deepEqual(sent.keys, ["model", "store", "input", "response_format"]);
  }
  assert.deepEqual(geminiCalls[0]!.images.map((i) => i.bytes), [ORIGINAL]);
  assert.deepEqual(geminiCalls[1]!.images.map((i) => [i.mime, i.bytes]), [["image/jpeg", PHOTO], ["image/jpeg", MARK]]);
});

test("a highlighted edit's images may use JSON's escapes (\\/ for /, \\u003d for =): decoded all the same", async () => {
  geminiCalls.length = 0;
  const body = JSON.stringify({ assetId: PHONE_PHOTO, prompt: "remove the car", mark: b64(MARK), photo: b64(PHOTO) })
    .replaceAll("/", "\\/").replaceAll("=", "\\u003d");
  assert.match(body, /\\\/9j\\\//, "a JPEG's base64 starts with /9j/");
  const made = await fetch(`${service.base}/edits/area`, { method: "POST", headers: { cookie: OWNER_COOKIE, "content-type": "application/json" }, body });
  assert.equal(made.status, 201);
  assert.deepEqual(geminiCalls[0]!.images.map((i) => i.bytes), [PHOTO, MARK]);
});

test("the apps report how they lined a result up (numbers only, the edit's owner only), and it's logged", async () => {
  const made = await areaEdit({});
  const id = made.body.editId as string;
  const report = { scaleX: 1.0034, offsetX: 0.0003, scaleY: 1.0035, offsetY: -0.0018, error: 0.00027, patches: 70, refused: false };
  assert.equal((await call("POST", `/edits/${id}/alignment`, { cookie: OTHER_COOKIE, json: report })).status, 404);
  assert.equal((await call("POST", `/edits/${id}/alignment`, { cookie: OWNER_COOKIE, json: { ...report, error: "big" } })).status, 400);
  assert.equal((await call("POST", `/edits/${id}/alignment`, { cookie: OWNER_COOKIE, json: { ...report, scaleX: 9 } })).status, 400);
  assert.equal((await call("POST", `/edits/${id}/alignment`, { cookie: OWNER_COOKIE, json: report })).status, 204);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(service.logs, new RegExp(`"event":"alignment","edit":"${id}".*"error":0.00027,"patches":70,"refused":false`));
});
