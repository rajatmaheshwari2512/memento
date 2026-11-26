// Peak memory (RSS) of the service while N AI edits are asked for at once, against a fake Immich and a fake Gemini.
// Run: npm run bench:edits            (or: node test/edits-memory.bench.ts [N ...])
// For the numbers in constants/edits.constants.ts, run it on Linux in the service's own image:
//   docker run --rm -v "$PWD":/app:ro -w /app node:24.22.2-alpine node test/edits-memory.bench.ts
// Settings: ORIGINAL_MB, RESULT_MB, PHOTO_MB, MARK_MB (sizes); GEMINI_MS (how long the fake
// Gemini takes, so the edits overlap); PROD_HEAP=0 for Node's own heap sizes on this machine;
// SERVICE_NODE_OPTIONS for more of Node's options for the service.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, json, listen, Service } from "./helpers.ts";

const MB = 1024 * 1024;
const setting = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const ORIGINAL_BYTES = Math.round(setting("ORIGINAL_MB", 12) * MB);
const RESULT_BYTES = Math.round(setting("RESULT_MB", 8) * MB);
const PHOTO_BYTES = Math.round(setting("PHOTO_MB", 5) * MB);
const MARK_BYTES = Math.round(setting("MARK_MB", 0.5) * MB);
const GEMINI_MS = setting("GEMINI_MS", 1500);
const PROD_HEAP = process.env.PROD_HEAP !== "0";
const COUNTS = process.argv.slice(2).map(Number).filter((n) => n > 0);
const RUNS = COUNTS.length > 0 ? COUNTS : [1, 2, 4, 8, 16];

const fakeJpeg = (bytes: number) => {
  const out = randomBytes(bytes);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  return out;
};
const ORIGINAL = fakeJpeg(ORIGINAL_BYTES);
const RESULT_REPLY = Buffer.from(JSON.stringify({
  id: "interaction-1", status: "completed",
  steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: fakeJpeg(RESULT_BYTES).toString("base64") }] }],
}));
const OWNER = { id: "11111111-1111-4111-8111-111111111111", name: "Owner", isAdmin: true };
const ASSET = "33333333-3333-4333-8333-333333333333";
const COOKIE = "immich_access_token=ownertoken0123456789";
const AREA_BODY = JSON.stringify({
  assetId: ASSET, prompt: "remove the car", mark: fakeJpeg(MARK_BYTES).toString("base64"), photo: fakeJpeg(PHOTO_BYTES).toString("base64"),
});

let geminiNow = 0;
let geminiMost = 0;

function fakeImmich(): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.headers.cookie !== COOKIE) return json(res, 401, {});
    if (path === "/api/users/me") return json(res, 200, OWNER);
    if (path === `/api/assets/${ASSET}`) {
      return json(res, 200, {
        id: ASSET, type: "IMAGE", ownerId: OWNER.id, isTrashed: false, originalFileName: "beach.jpg", originalMimeType: "image/jpeg",
        fileCreatedAt: "2024-05-01T10:00:00.000Z", width: 4080, height: 3072,
        exifInfo: { exifImageWidth: 4080, exifImageHeight: 3072, fileSizeInByte: ORIGINAL.length },
      });
    }
    if (path === `/api/assets/${ASSET}/original`) return void res.writeHead(200, { "content-type": "image/jpeg", "content-length": ORIGINAL.length }).end(ORIGINAL);
    json(res, 404, {});
  });
}

function fakeGemini(): Server {
  return createServer(async (req, res) => {
    geminiNow++;
    geminiMost = Math.max(geminiMost, geminiNow);
    for await (const _ of req);
    await new Promise((resolve) => setTimeout(resolve, GEMINI_MS));
    geminiNow--;
    res.writeHead(200, { "content-type": "application/json", "content-length": RESULT_REPLY.length }).end(RESULT_REPLY);
  });
}

function memory(pid: number): { now: number; peak: number | null } {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+) kB`).exec(status)![1]) * 1024;
    return { now: kb("VmRSS"), peak: kb("VmHWM") };
  } catch {
    return { now: Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) * 1024, peak: null };
  }
}

async function oneRun(kind: "whole" | "area", n: number, immichUrl: string, geminiUrl: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "memento-extras-bench-"));
  const service = new Service(await freePort(), {
    IMMICH_URL: immichUrl, GEMINI_URL: geminiUrl, GEMINI_API_KEY: "test-key-not-real", DATA_DIR: dataDir,
    DAILY_LIMIT_PER_USER: "10000", MONTHLY_LIMIT_TOTAL: "10000", LIMITS_TIMEZONE: "UTC",
    MEMORIES_CHECK_SECONDS: "0", CREATIONS_CHECK_SECONDS: "0", LIVE_ALBUMS_INTERVAL_SECONDS: "100000",
    NODE_OPTIONS: [PROD_HEAP ? "--max-old-space-size=256 --max-semi-space-size=1" : "", process.env.SERVICE_NODE_OPTIONS ?? ""].join(" ").trim(),
  });
  await service.start();
  const pid = service.pid!;
  const edit = () =>
    fetch(`${service.base}/edits${kind === "area" ? "/area" : ""}`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: kind === "area" ? AREA_BODY : JSON.stringify({ assetId: ASSET, prompt: "make it warmer" }),
    }).then(async (r) => {
      await r.arrayBuffer();
      return r.status;
    });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const fresh = memory(pid).now;
    const first = await edit();
    if (first !== 201) throw new Error(`warm-up edit failed: ${first}\n${service.logs.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    geminiMost = 0;
    let sampled = 0;
    let done = false;
    const sampling = (async () => {
      while (!done) {
        sampled = Math.max(sampled, memory(pid).now);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    const statuses = await Promise.all(Array.from({ length: n }, edit));
    done = true;
    await sampling;
    if (statuses.some((s) => s !== 201)) throw new Error(`edits failed: ${statuses.join(", ")}`);
    return { fresh, peak: Math.max(sampled, memory(pid).peak ?? 0), atGoogle: geminiMost };
  } finally {
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const immich = fakeImmich();
const gemini = fakeGemini();
const immichUrl = `http://127.0.0.1:${await listen(immich)}`;
const geminiUrl = `http://127.0.0.1:${await listen(gemini)}/v1beta/interactions`;
const f = (bytes: number) => (bytes / MB).toFixed(1);
console.log(
  `Node ${process.version}, ${PROD_HEAP ? "the production container's heap" : "this machine's heap"}. Original ${f(ORIGINAL_BYTES)} MB; ` +
    `Gemini's result ${f(RESULT_BYTES)} MB (${f(RESULT_REPLY.length)} MB reply); app's photo ${f(PHOTO_BYTES)} MB + mark ${f(MARK_BYTES)} MB.`,
);
console.log("kind   asked  at Google  fresh MB  peak MB  peak-fresh  per edit");
try {
  for (const kind of ["whole", "area"] as const) {
    for (const n of RUNS) {
      const { fresh, peak, atGoogle } = await oneRun(kind, n, immichUrl, geminiUrl);
      const above = peak - fresh;
      console.log(
        `${kind.padEnd(6)} ${String(n).padStart(5)}  ${String(atGoogle).padStart(9)}  ${f(fresh).padStart(8)}  ${f(peak).padStart(7)}  ` +
          `${f(above).padStart(10)}  ${f(above / Math.max(1, atGoogle)).padStart(8)}`,
      );
    }
  }
} finally {
  immich.close();
  gemini.close();
}
