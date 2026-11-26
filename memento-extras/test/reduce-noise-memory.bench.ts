// Peak memory (RSS) of the service while Reduce noise moves a 2 GB video in and a ~2.1 GB copy out.
// Needs ~2.5 GB of free disk (the copy is sparse), and ~9 GB free for the service's own disk check.
// Run: npm run bench:reduce-noise
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, json, listen, Service } from "./helpers.ts";

const MiB = 1024 ** 2;
const ORIGINAL = 2048 * MiB - MiB;
const COPY = 2048 * MiB + 100 * MiB;
const VIDEO = "00000001-0000-4000-8000-000000000000";
const COOKIE = "immich_access_token=ownertoken0123456789";
const OWNER = { id: "11111111-1111-4111-8111-111111111111", name: "Owner", isAdmin: true };
const dataDir = mkdtempSync(join(tmpdir(), "noise-bench-data-"));
const workDir = mkdtempSync(join(tmpdir(), "noise-bench-work-"));
let downloaded = 0;
let uploaded = 0;

const immich = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  if (path === "/api/users/me") return json(res, 200, OWNER);
  if (req.method === "GET" && path === `/api/assets/${VIDEO}`) {
    return json(res, 200, {
      id: VIDEO, type: "VIDEO", ownerId: OWNER.id, isTrashed: false, originalFileName: "big.mp4", fileCreatedAt: "2024-05-01T10:00:00.000Z",
      localDateTime: "2024-05-01T15:30:00.000Z", visibility: "timeline", duration: 590_000, stack: null,
      exifInfo: { fileSizeInByte: ORIGINAL, dateTimeOriginal: "2024-05-01T10:00:00+00:00", latitude: null, longitude: null },
    });
  }
  if (path === `/api/assets/${VIDEO}/original`) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": ORIGINAL });
    const chunk = Buffer.alloc(MiB);
    const pump = () => {
      while (downloaded < ORIGINAL) {
        const n = Math.min(chunk.length, ORIGINAL - downloaded);
        downloaded += n;
        if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void res.once("drain", pump);
      }
      res.end();
    };
    return pump();
  }
  for await (const c of req) if (path === "/api/assets") uploaded += (c as Buffer).length;
  if (req.method === "POST" && path === "/api/assets") return json(res, 201, { id: "22222222-2222-4222-8222-222222222222", status: "created" });
  return json(res, 200, {});
});

const states = new Map<string, unknown>();
const creations = createServer(async (req, res) => {
  if (req.url === "/health") return json(res, 200, { ok: true, busy: false });
  if (req.method === "POST" && req.url === "/render") {
    let body = "";
    for await (const c of req) body += c;
    const job = JSON.parse(body) as { id: string };
    const fd = openSync(join(workDir, job.id, "reduce-noise.video"), "w");
    writeSync(fd, "ftyp");
    ftruncateSync(fd, COPY);
    closeSync(fd);
    states.set(job.id, { state: "done", file: "reduce-noise.video", bytes: COPY, ms: 1 });
    return json(res, 202, { state: "running" });
  }
  const m = /^\/renders\/(.+)$/.exec(req.url!);
  if (m) return json(res, 200, states.get(m[1]!) ?? {});
  json(res, 404, {});
});

const service = new Service(await freePort(), {
  IMMICH_URL: `http://127.0.0.1:${await listen(immich)}`, CREATIONS_URL: `http://127.0.0.1:${await listen(creations)}`,
  CREATIONS_WORK_DIR: workDir, DATA_DIR: dataDir, GEMINI_API_KEY: "x", RENDER_QUIET_HOURS: "", CREATIONS_CHECK_SECONDS: "0", MEMORIES_CHECK_SECONDS: "0",
  NODE_OPTIONS: "--max-old-space-size=384",
});
await service.start();
const rss = () => Number(execFileSync("ps", ["-o", "rss=", "-p", String(service.pid)]).toString().trim()) * 1024;
const before = rss();
let peak = before;
const sampler = setInterval(() => (peak = Math.max(peak, rss())), 50);
const started = Date.now();
const call = (method: string, path: string) => fetch(service.base + path, { method, headers: { cookie: COOKIE, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }).then((r) => r.json());
const job = (await call("POST", `/videos/${VIDEO}/reduce-noise`)) as { jobId: string };
let state: Record<string, unknown> = {};
for (;;) {
  await new Promise((r) => setTimeout(r, 200));
  state = await call("GET", `/videos/jobs/${job.jobId}`);
  if (state.state === "done" || state.state === "failed") break;
}
clearInterval(sampler);
console.log(JSON.stringify({
  state: state.state, error: state.error, seconds: (Date.now() - started) / 1000,
  downloadedMiB: Math.round(downloaded / MiB), uploadedMiB: Math.round(uploaded / MiB),
  rssBeforeMiB: Math.round(before / MiB), rssPeakMiB: Math.round(peak / MiB),
}));
await service.stop();
immich.close();
creations.close();
rmSync(dataDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
