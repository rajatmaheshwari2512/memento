// Calls to the creations container (memento-extras/creations/): its health, rendering a job, and measuring photos' quality.

import { config } from "../config.ts";
import type { Quality } from "../types/creations.types.ts";
import type { RenderJob } from "../../creations/src/job.ts";

// The container is busy with another job: try later.
export class CreationsBusy extends Error {}
// The container didn't answer: try later.
export class CreationsUnreachable extends Error {}
// The container can't make this job from what it was given: trying again won't help. `reason` is the container's own.
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
    json = await readAnswer(res);
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

// Renders a job and waits for it, for at most `limitMs`.
export async function render(job: RenderJob, limitMs: number): Promise<void> {
  const started = await request("POST", "/render", job, 30_000);
  if (started.status !== 202) throw failed(started);
  const end = Date.now() + limitMs;
  for (let polls = 0; Date.now() < end; polls++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, 1000 * 2 ** polls)));
    let answer: Answer;
    try {
      answer = await request("GET", `/renders/${job.id}`, undefined, 10_000);
    } catch (error) {
      if (error instanceof CreationsUnreachable) continue;
      throw error;
    }
    if (answer.status === 404) throw new Error("the creations container lost the render (it restarted)");
    if (answer.json.state === "done") return;
    if (answer.json.state === "failed") throw failed(answer);
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
