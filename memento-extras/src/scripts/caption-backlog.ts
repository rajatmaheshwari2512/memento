// The one-off caption backlog: every existing photo's preview → llama-server → a results
// file, which import-captions.ts then loads into the database. Run on the main server in a
// throwaway container, while the temporary big server runs llama-server (docs/runbooks.md,
// "Caption the backlog").
//
//   node src/scripts/caption-backlog.ts --assets assets.tsv --out captions.jsonl \
//     --llama http://10.0.1.10:8080,http://10.0.1.10:8081 --concurrency 8 [--limit 200]
//
// --assets   one photo per line: asset ID, owner ID, type, preview path (tab-separated),
//            exported from Immich's database (the runbook has the query)
// --out      results, one JSON object per line. Photos already in it are skipped, so it
//            can be stopped (Ctrl-C) and started again at any time.
// --errors   failures, one per line (default: <out>.errors.jsonl). They're not in --out,
//            so the next run tries them again.
// --llama    one or more llama-server addresses; requests are spread across them
// --limit    caption only this many (the timing test)
//
// Prints progress every 15 s, including photos per hour, then a summary.
// Reads only previews (never originals) and needs no keys: the files are on this server.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { captionPhoto, modelName, readPhotoList } from "../services/captions.service.ts";

const { values: args } = parseArgs({
  options: {
    assets: { type: "string" },
    out: { type: "string" },
    errors: { type: "string" },
    llama: { type: "string" },
    concurrency: { type: "string", default: "4" },
    limit: { type: "string" },
    "timeout-seconds": { type: "string", default: "600" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function count(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a whole number above 0`);
  return n;
}

if (!args.assets || !args.out || !args.llama) {
  fail("Usage: node src/scripts/caption-backlog.ts --assets <tsv> --out <jsonl> --llama <url>[,<url>...] [--concurrency N] [--limit N]");
}
const outFile = args.out;
const errorsFile = args.errors ?? `${outFile}.errors.jsonl`;
const urls = args.llama.split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
const concurrency = count("concurrency", args.concurrency)!;
const limit = count("limit", args.limit);
const timeoutMs = count("timeout-seconds", args["timeout-seconds"])! * 1000;

// Photos already captioned, from an earlier run.
function doneIds(file: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(file)) return done;
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    try {
      const id = (JSON.parse(line) as { assetId?: unknown }).assetId;
      if (typeof id === "string") done.add(id);
    } catch {
      // empty, or a half-written last line from a crash: that photo is done again
    }
  }
  // Start on a fresh line if the last one was cut off.
  if (text.length > 0 && !text.endsWith("\n")) appendFileSync(file, "\n");
  return done;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

// --- Run ---

const assets = readPhotoList(args.assets);
const done = doneIds(outFile);
let queue = assets.filter((a) => !done.has(a.id));
if (limit !== undefined) queue = queue.slice(0, limit);

let models: string[];
try {
  models = await Promise.all(urls.map(modelName));
} catch (error) {
  fail(`Can't reach llama-server: ${(error as Error).message}`);
}
log("started", { photos: assets.length, alreadyDone: done.size, toDo: queue.length, servers: urls, models, concurrency });

let next = 0;
let captioned = 0;
let failed = 0;
let promptTokens = 0;
let stopping = false;
const started = performance.now();
let warmAt = 0; // when the first round of requests had finished; rates after that exclude the warm-up
let warmCount = 0;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(130);
    stopping = true;
    log("stopping", { note: "finishing the photos in progress; press Ctrl-C again to quit now" });
  });
}

function rates(): Record<string, unknown> {
  const hours = (performance.now() - started) / 3_600_000;
  const steadyHours = warmAt ? (performance.now() - warmAt) / 3_600_000 : 0;
  const perHour = steadyHours > 0 && captioned > warmCount ? (captioned - warmCount) / steadyHours : captioned / hours;
  const remaining = queue.length - captioned - failed;
  return {
    captioned,
    failed,
    remaining,
    photosPerHour: Math.round(perHour),
    hoursLeft: perHour > 0 ? Math.round((remaining / perHour) * 10) / 10 : null,
    avgPromptTokens: captioned ? Math.round(promptTokens / captioned) : null,
  };
}

async function worker(slot: number): Promise<void> {
  const url = urls[slot % urls.length]!;
  const model = models[slot % urls.length]!;
  while (!stopping && next < queue.length) {
    const asset = queue[next++]!;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await captionPhoto(url, model, asset, timeoutMs);
        appendFileSync(outFile, JSON.stringify(result) + "\n");
        captioned++;
        promptTokens += result.promptTokens ?? 0;
        if (!warmAt && captioned >= Math.min(concurrency, queue.length)) {
          warmAt = performance.now();
          warmCount = captioned;
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError !== undefined) {
      failed++;
      // With the cause (the model's reply), to see what went wrong: this file stays on the server.
      const message = lastError instanceof Error ? [lastError.message, lastError.cause].filter(Boolean).join(": ") : String(lastError);
      appendFileSync(errorsFile, JSON.stringify({ assetId: asset.id, error: message, at: new Date().toISOString() }) + "\n");
    }
  }
}

const progress = setInterval(() => log("progress", rates()), 15_000);
await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)));
clearInterval(progress);
log(stopping ? "stopped" : "finished", { ...rates(), minutes: Math.round((performance.now() - started) / 600) / 100 });
