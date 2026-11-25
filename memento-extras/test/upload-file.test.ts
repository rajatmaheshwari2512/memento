// A cleaned video's upload to Immich (immich.client.ts uploadFile), sent from its open file in the
// work folder, against fake Immich servers that answer, refuse before reading it all, drop the
// connection, or stop reading and never answer. Each must end promptly with the right error, send
// no more than the file's checked size, read nothing from the file afterwards (it's closed at
// once), and leave nothing unhandled. Runs in this process. Run: npm test

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listen } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "upload-file-test-"));
const VIDEO = join(dir, "reduce-noise.video");
const SIZE = 32 * 1024 * 1024; // well over what the sockets buffer, so a server that stops reading really stops the upload
writeFileSync(VIDEO, randomBytes(SIZE));

// Each fake Immich, by how it treats the upload; `received` counts what it read.
let mode: "answer" | "refuse" | "drop" | "stall" = "answer";
let received = 0;
const sockets = new Set<Socket>();
// A raw server, to control exactly what's read: Node's own HTTP server reads the rest of a body
// it has answered.
const raw: Server = createNetServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (mode === "refuse" && received === chunk.length) {
      const body = JSON.stringify({ message: "storage full" });
      socket.write(`HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      socket.pause(); // and reads no more
    } else if (mode === "drop" && received > 1024 * 1024) {
      socket.destroy();
    } else if (mode === "stall" && received > 1024 * 1024) {
      socket.pause(); // never reads more, never answers
    }
  });
});
// A real one for the upload that works, checking what arrived.
let form: { filename: string; type: string; bytes: number } | null = null;
const http = createHttpServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(chunks) }).formData();
    const file = data.get("assetData") as File;
    form = { filename: file.name, type: file.type, bytes: file.size };
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: "copy-1", status: "created" }));
  })();
});

let rawUrl = "";
let httpUrl = "";
let unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);

before(async () => {
  rawUrl = `http://127.0.0.1:${await listen(raw as unknown as import("node:http").Server)}`;
  httpUrl = `http://127.0.0.1:${await listen(http)}`;
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUnhandled);
});

after(() => {
  for (const socket of sockets) socket.destroy();
  raw.close();
  http.close();
  process.off("unhandledRejection", onUnhandled);
  process.off("uncaughtException", onUnhandled);
  rmSync(dir, { recursive: true, force: true });
});

const COOKIE = { name: "cookie", value: "immich_access_token=abc" };

// Uploads the test video to `base` (config.immichUrl is read once, so it's set per call through
// the module's own copy), `size` of it, giving up after `timeoutMs`. Returns what it threw (or
// the answer) and how long it took; the file is closed straight after, as the service does.
async function upload(base: string, size: number, timeoutMs: number): Promise<{ result: unknown; ms: number }> {
  const { config } = await import("../src/config.ts");
  const { uploadFile } = await import("../src/clients/immich.client.ts");
  (config as { immichUrl: string }).immichUrl = base;
  const handle = await open(VIDEO, "r");
  const started = Date.now();
  let result: unknown;
  try {
    result = await uploadFile(COOKIE, { handle, size }, "video/mp4", "trip-reduce-noise.mp4", "2024-05-01T10:00:00.000Z", "upload the cleaned video", timeoutMs);
  } catch (error) {
    result = error;
  } finally {
    await handle.close();
  }
  const ms = Date.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 200)); // anything left to go wrong, now
  return { result, ms };
}

process.env.GEMINI_API_KEY ??= "test-key-not-real";
process.env.DATA_DIR ??= dir;
process.env.IMMICH_URL ??= "http://127.0.0.1:9";

test("Immich answering: the whole file sent, as a form Immich reads, and no more than its checked size", async () => {
  unhandled = [];
  const whole = await upload(httpUrl, SIZE, 30_000);
  assert.deepEqual(whole.result, { id: "copy-1", status: "created" });
  assert.deepEqual(form, { filename: "trip-reduce-noise.mp4", type: "video/mp4", bytes: SIZE });
  // A file grown since it was checked: only the checked size goes.
  const part = await upload(httpUrl, 1000, 30_000);
  assert.deepEqual(part.result, { id: "copy-1", status: "created" });
  assert.equal(form!.bytes, 1000);
  assert.deepEqual(unhandled, []);
});

test("Immich refusing before it has read it all: its refusal at once, not after the time limit", async () => {
  unhandled = [];
  mode = "refuse";
  received = 0;
  const { result, ms } = await upload(rawUrl, SIZE, 20_000);
  const { HttpError } = await import("../src/utils/http-error.ts");
  assert.ok(result instanceof HttpError, String(result));
  assert.equal(result.message, "Immich returned an error while trying to upload the cleaned video.");
  assert.ok(ms < 5_000, `took ${ms} ms`);
  assert.ok(received < SIZE, "the rest wasn't sent");
  assert.deepEqual(unhandled, []);
});

test("the connection dropping mid-upload: Immich unreachable, at once", async () => {
  unhandled = [];
  mode = "drop";
  received = 0;
  const { result, ms } = await upload(rawUrl, SIZE, 20_000);
  const { ImmichUnreachable } = await import("../src/clients/immich.client.ts");
  assert.ok(result instanceof ImmichUnreachable, String(result));
  assert.ok(ms < 5_000, `took ${ms} ms`);
  assert.deepEqual(unhandled, []);
});

test("Immich stalling mid-upload: given up at the time limit, as unreachable", async () => {
  unhandled = [];
  mode = "stall";
  received = 0;
  const { result, ms } = await upload(rawUrl, SIZE, 1_000);
  const { ImmichUnreachable } = await import("../src/clients/immich.client.ts");
  assert.ok(result instanceof ImmichUnreachable, String(result));
  assert.ok(ms >= 900 && ms < 5_000, `took ${ms} ms`);
  assert.ok(received < SIZE);
  assert.deepEqual(unhandled, []);
});
