// Calls to the creations container (memento-extras/creations/): its health, rendering a job, and
// measuring photos' quality, from files already in the job's folder of the shared work folder.
//
// A render takes up to minutes, longer than an HTTP request should stay open (Node's fetch gives
// up waiting for an answer after 300 s), so it's started with one request and then asked about
// until it's done, failed, or past its time limit.
//
// The container is trusted no further than it must be: an answer is read up to 64 KB, its
// numbers must be numbers, and its error text is cut short before it's logged or stored.

import { config } from "../config.ts";
import type { Quality } from "../types/creations.types.ts";
import type { RenderJob } from "../../creations/src/job.ts";

// The container is busy with another job (it does one at a time): try later.
export class CreationsBusy extends Error {}
// The container didn't answer (down or restarting): try later.
export class CreationsUnreachable extends Error {}
// The container can't make this job from what it was given (an animation whose photos aren't
// one burst, a cinematic photo with no clear subject, a video with no sound): trying again won't
// help. `reason` is the container's own (job.ts NOISE_UNSUITABLE for a video).
export class RenderUnsuitable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`the creations container can't make it: ${reason}`);
    this.reason = reason;
  }
}

const POLL_MS = 5_000;
const MAY_BE_UNSUITABLE = new Set<RenderJob["kind"]>(["animation", "cinematic", "reduce-noise"]);
const MAX_ANSWER_BYTES = 64 * 1024;

type Answer = { status: number; json: Record<string, unknown> };

async function readAnswer(res: Response): Promise<Record<string, unknown>> {
  const reader = res.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return {};
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function request(method: string, path: string, body: unknown, timeoutMs: number): Promise<Answer> {
  let res: Response;
  let json: Record<string, unknown>;
  try {
    res = await fetch(config.creationsUrl + path, {
      method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    json = await readAnswer(res); // a reply cut short (a reset, the time limit) is no answer either
  } catch (error) {
    throw new CreationsUnreachable(`the creations container didn't answer (${error instanceof Error ? error.name : "error"})`);
  }
  if (res.status === 429) throw new CreationsBusy("the creations container is busy");
  return { status: res.status, json };
}

function failed({ json, status }: Answer): Error {
  const said = typeof json.error === "string" ? json.error.slice(0, 300) : String(status);
  return new Error(`the creations container failed: ${said}`);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Throws CreationsUnreachable or CreationsBusy unless the container can take a job now.
export async function ready(): Promise<void> {
  const { status, json } = await request("GET", "/health", undefined, 5_000);
  if (status !== 200) throw new CreationsUnreachable(`the creations container isn't healthy (${status})`);
  if (json.busy === true) throw new CreationsBusy("the creations container is busy");
}

// What the container knows of a render: its state, or "unknown" (it restarted since, or never had it).
export async function renderState(id: string): Promise<"running" | "done" | "failed" | "unknown"> {
  const answer = await request("GET", `/renders/${id}`, undefined, 10_000);
  const state = answer.status === 200 ? answer.json.state : undefined;
  return state === "running" || state === "done" || state === "failed" ? state : "unknown";
}

// Renders a job and waits for it, for at most `limitMs` (the container stops its own tools at
// its own limit, a little earlier).
export async function render(job: RenderJob, limitMs: number): Promise<void> {
  const started = await request("POST", "/render", job, 30_000);
  if (started.status !== 202) throw failed(started);
  const end = Date.now() + limitMs;
  for (let polls = 0; Date.now() < end; polls++) {
    // Asked after 1 s, 2 s, then every POLL_MS: a collage is done in a second or two.
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, 1000 * 2 ** polls)));
    let answer: Answer;
    try {
      answer = await request("GET", `/renders/${job.id}`, undefined, 10_000);
    } catch (error) {
      if (error instanceof CreationsUnreachable) continue; // a moment's hiccup; asked again until the limit
      throw error;
    }
    if (answer.status === 404) throw new Error("the creations container lost the render (it restarted)");
    if (answer.json.state === "done") return;
    if (answer.json.state === "failed") throw failed(answer);
    // Only an animation (its photos aren't one burst), a cinematic photo (no clear subject) or a
    // video to clean (no sound, too long…) can be unsuitable; from any other kind it's a failure.
    if (answer.json.state === "unsuitable" && !MAY_BE_UNSUITABLE.has(job.kind)) throw failed(answer);
    if (answer.json.state === "unsuitable") throw new RenderUnsuitable(String(answer.json.error ?? "").slice(0, 300));
  }
  throw new Error(`the render took over ${Math.round(limitMs / 60_000)} minutes`);
}

function quality(v: unknown): Quality | null {
  const q = v as Record<string, unknown> | null;
  if (q === null || typeof q !== "object") return null;
  if (!finite(q.sharpness) || !finite(q.brightness) || !finite(q.p2) || !finite(q.p98)) return null;
  return { sharpness: q.sharpness, brightness: q.brightness, p2: q.p2, p98: q.p98 };
}

// One result per file (null: unreadable). Throws if the answer doesn't have one per file.
export async function measureQuality(id: string, files: string[], timeoutMs: number): Promise<Array<Quality | null>> {
  const answer = await request("POST", "/quality", { id, files }, timeoutMs);
  if (answer.status !== 200) throw failed(answer);
  const results = answer.json.results;
  if (!Array.isArray(results) || results.length !== files.length) throw new Error("the creations container's quality answer didn't fit");
  return results.map(quality);
}
