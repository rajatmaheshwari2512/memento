// Memento's creations container: renders the collages, recap videos, animations and cinematic
// photos it's told to make, and cleans up videos' sound (Reduce noise), from files the extras
// service put in the job's folder. It has no keys, no internet and
// no access to Immich: it only reads and writes WORK_DIR/<job id>/. One job at a time; another
// is answered 429 (busy). Every tool runs at the lowest CPU priority with a time limit, and the
// job's scratch files are removed whatever happens.
//
//   GET  /health        { ok, busy }
//   POST /render        a job (job.ts): starts it and answers 202 at once (a recap takes minutes,
//                       longer than an HTTP request should stay open)
//   GET  /renders/:id   { state: running | done | failed | unsuitable, file?, bytes?, ms?, error? };
//                       unsuitable: it can't be made from what it was given (an animation whose
//                       photos aren't one burst, a cinematic photo with no clear subject, a video
//                       with no sound), so trying again won't help. 404 for a job this container
//                       doesn't know (it restarted since)
//   POST /quality       { id, files } (thumbnails in the job's folder) → { results, ms }: each
//                       photo's sharpness and exposure (quality.ts), or null if unreadable. Quick,
//                       so answered when done.
//   400 a bad job, 429 busy (one job at a time, whatever its kind), 500 it failed ({ error })

import { mkdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { renderAnimation } from "./animation.ts";
import { renderCinematic } from "./cinematic.ts";
import { renderCollage } from "./collage.ts";
import { reduceNoise } from "./noise.ts";
import { renderRecap } from "./recap.ts";
import {
  BadJob, LIMITS, OUTPUT_FILE, parseJob, parseQualityJob, type QualityJob, type RenderJob, type RenderNotes, type RenderResult, Unsuitable,
} from "./job.ts";
import { measureFiles, type Quality } from "./quality.ts";
import { Deadline } from "./run.ts";

const WORK_DIR = process.env.WORK_DIR ?? "/work";
// Music for recap videos, if the owner put any there (read-only). None: videos are silent.
const MUSIC_DIR = process.env.MUSIC_DIR || undefined;
const PORT = Number(process.env.PORT ?? 8000);

let busy = false;
type RenderState = { state: "running" } | ({ state: "done" } & RenderResult) | { state: "failed" | "unsuitable"; error: string };
const renders = new Map<string, RenderState>(); // the latest, by job id
const KEEP_RENDERS = 50;

function remember(id: string, state: RenderState): void {
  renders.delete(id);
  renders.set(id, state);
  while (renders.size > KEEP_RENDERS) renders.delete(renders.keys().next().value!);
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) }).end(json);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.bodyBytes) throw new BadJob("too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadJob("not JSON");
  }
}

// Runs `work` in the job's folder with a scratch folder that's removed afterwards, whatever happens.
async function inJobFolder<T>(id: string, work: (dir: string, tmp: string) => Promise<T>): Promise<T> {
  const dir = join(WORK_DIR, id);
  const tmp = join(dir, "tmp");
  await stat(dir); // the extras service made it, with the inputs
  await mkdir(tmp, { recursive: true });
  try {
    return await work(dir, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// How many inputs a job has (for the log).
function inputsOf(job: RenderJob): number {
  switch (job.kind) {
    case "collage": return job.photos.length;
    case "recap": return job.items.length;
    case "animation": return job.frames.length;
    case "cinematic": return 1;
    case "reduce-noise": return 1;
  }
}

// Renders the job into OUTPUT_FILE[kind]; an animation, a cinematic photo or a cleaned video also
// says how it went.
async function renderKind(job: RenderJob, dir: string, tmp: string, deadline: Deadline): Promise<RenderNotes | void> {
  const { bytes } = LIMITS[job.kind];
  switch (job.kind) {
    case "collage": return renderCollage(job, dir, tmp, deadline, bytes);
    case "recap": return renderRecap(job, dir, tmp, deadline, bytes, MUSIC_DIR);
    case "animation": return renderAnimation(job, dir, tmp, deadline, bytes);
    case "cinematic": return renderCinematic(job, dir, tmp, deadline, bytes);
    case "reduce-noise": return reduceNoise(job, dir, tmp, deadline, bytes);
  }
}

async function render(job: RenderJob): Promise<RenderResult> {
  const started = Date.now();
  return inJobFolder(job.id, async (dir, tmp) => {
    const notes = await renderKind(job, dir, tmp, new Deadline(LIMITS[job.kind].ms));
    const file = OUTPUT_FILE[job.kind];
    const { size } = await stat(join(dir, file));
    return { file, bytes: size, ms: Date.now() - started, ...(notes ? { notes } : {}) };
  });
}

async function quality(job: QualityJob): Promise<{ results: Array<Quality | null>; ms: number }> {
  const started = Date.now();
  const results = await inJobFolder(job.id, (dir, tmp) => measureFiles(job.files, dir, tmp, new Deadline(LIMITS.quality.ms)));
  return { results, ms: Date.now() - started };
}

// One job at a time, whatever its kind. Logs only the job id and what went wrong: never what's in
// the photos.
async function exclusive<T extends { ms: number }>(what: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  busy = true;
  try {
    const result = await work();
    const notes = "notes" in result ? (result.notes as RenderNotes | undefined) : undefined;
    log({ event: "done", ...what, ...("bytes" in result ? { bytes: result.bytes } : {}), ms: result.ms, ...notes });
    return result;
  } catch (error) {
    log({ event: error instanceof Unsuitable ? "unsuitable" : "failed", ...what, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    busy = false;
  }
}

// Starts a render in the background; its outcome is kept for GET /renders/:id.
function startRender(job: RenderJob): void {
  remember(job.id, { state: "running" });
  exclusive({ job: job.id, kind: job.kind, items: inputsOf(job) }, () => render(job)).then(
    (result) => remember(job.id, { state: "done", ...result }),
    async (error: unknown) => {
      await rm(join(WORK_DIR, job.id, OUTPUT_FILE[job.kind]), { force: true }).catch(() => {}); // no half-made output
      remember(job.id, { state: error instanceof Unsuitable ? "unsuitable" : "failed", error: error instanceof Error ? error.message : String(error) });
    },
  );
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, busy });
  if (req.method === "POST" && req.url === "/render") {
    const job = parseJob(await readBody(req));
    if (busy) return send(res, 429, { error: "busy" });
    startRender(job);
    return send(res, 202, { state: "running" });
  }
  const status = /^\/renders\/([0-9a-f-]{36})$/.exec(req.url ?? "");
  if (req.method === "GET" && status) {
    const state = renders.get(status[1]!);
    return state ? send(res, 200, state) : send(res, 404, { error: "unknown job" });
  }
  if (req.method === "POST" && req.url === "/quality") {
    const job = parseQualityJob(await readBody(req));
    if (busy) return send(res, 429, { error: "busy" });
    try {
      return send(res, 200, await exclusive({ job: job.id, kind: "quality", files: job.files.length }, () => quality(job)));
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (res.headersSent) return;
    send(res, error instanceof BadJob ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
  });
});
server.listen(PORT, () => log({ event: "started", port: PORT, workDir: WORK_DIR }));

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
