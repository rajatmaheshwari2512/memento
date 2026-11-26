// Captions for new photos, at night on the main server. Started each night by a timer (host/roles/memento_extras: caption-night.sh).
//
//   node src/scripts/caption-night.ts --photos /work/photos.tsv --clean-up --existing /work/existing.txt [--max-removals N]
//       removes captions of photos gone from Immich for good (not in the list of every photo
//       Immich still has, one ID a line); refuses more than ~2% of the captions in one night
//   node src/scripts/caption-night.ts --photos /work/photos.tsv --count
//       how many photos wait for a caption, or "off" when switched off
//   node src/scripts/caption-night.ts --photos /work/photos.tsv --llama http://127.0.0.1:8090 --until <time>
//       caption them one at a time until <time> (e.g. 2026-11-21T07:00:00+05:30)
// Order: newest uploads first; photos that failed on earlier nights go last, and after FAILED_NIGHTS are left alone. Each caption goes into the database straight away. Stops at --until, when an admin switches it off (Memento Features), or when the model stops answering.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FAILED_NIGHTS, MAX_REMOVED_SHARE, MIN_REMOVALS, NIGHT_PHOTO_TIMEOUT_MS } from "../constants/captions.constants.ts";
import { closeDatabase } from "../db/database.ts";
import { removeGoneCaptions } from "../services/caption-records.service.ts";
import { captionPhoto, modelName, readPhotoList } from "../services/captions.service.ts";
import { getFlags } from "../services/flags.service.ts";
import { creationAssetIds } from "../services/repositories/creations.repository.ts";
import {
  captionedAssetIds, captionFailures, recordCaptionFailure, saveCaption,
} from "../services/repositories/captions.repository.ts";
import type { PhotoToCaption } from "../types/captions.types.ts";
import { isUuid } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";

const { values: args } = parseArgs({
  options: {
    photos: { type: "string" },
    llama: { type: "string" },
    until: { type: "string" },
    count: { type: "boolean", default: false },
    "clean-up": { type: "boolean", default: false },
    existing: { type: "string" },
    "max-removals": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!args.photos) fail("Usage: node src/scripts/caption-night.ts --photos <tsv> (--count | --llama <url> --until <time>)");

const switchedOn = () => getFlags().captions.enabled;

function waiting(): PhotoToCaption[] {
  const done = captionedAssetIds();
  const creations = creationAssetIds();
  const failures = captionFailures();
  const nights = (p: PhotoToCaption) => failures.get(p.id) ?? 0;
  return readPhotoList(args.photos!)
    .filter((p) => !done.has(p.id) && !creations.has(p.id) && nights(p) < FAILED_NIGHTS)
    .sort((a, b) => nights(a) - nights(b) || b.uploadedAt.localeCompare(a.uploadedAt));
}

if (args["clean-up"]) {
  if (!args.existing) fail("--clean-up needs --existing <file>");
  const existing = new Set(readFileSync(args.existing, "utf8").split("\n").map((l) => l.trim()).filter((l) => isUuid(l)));
  const max = args["max-removals"] !== undefined
    ? Number(args["max-removals"])
    : Math.max(MIN_REMOVALS, Math.ceil(captionedAssetIds().size * MAX_REMOVED_SHARE));
  if (!Number.isInteger(max) || max < 0) fail("--max-removals must be a whole number");
  if (existing.size === 0) {
    log({ event: "captions_cleanup", gone: 0, removed: false, skipped: "the photo list is empty" });
  } else {
    const { gone, removed } = removeGoneCaptions(existing, max);
    log({ event: "captions_cleanup", gone, removed, ...(gone > max ? { skipped: `more than ${max} to remove; check the photo list` } : {}) });
  }
  closeDatabase();
  process.exit(0);
}

if (args.count) {
  console.log(switchedOn() ? waiting().length : "off");
  closeDatabase();
  process.exit(0);
}

const url = args.llama?.replace(/\/+$/, "");
const until = Date.parse(args.until ?? "");
if (!url || Number.isNaN(until)) fail("--llama and --until (a time, e.g. 2026-11-21T07:00:00+05:30) are needed");

const started = performance.now();
let captioned = 0;
let failed = 0;
const on = switchedOn();
const queue = on ? waiting() : [];

function finish(stopped: string, exitCode = 0): never {
  const hours = (performance.now() - started) / 3_600_000;
  log({
    event: "captions_night", captioned, failed, waiting: queue.length - captioned, stopped,
    photosPerHour: hours > 0 ? Math.round(captioned / hours) : 0, minutes: Math.round(hours * 60),
  });
  closeDatabase();
  process.exit(exitCode);
}

process.on("SIGTERM", () => finish("stopped"));

async function modelAnswers(): Promise<boolean> {
  return fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
}

if (!on) finish("switched off");
const model = await modelName(url).catch(() => finish("the model didn't answer", 1));
for (const photo of queue) {
  if (Date.now() >= until) finish("morning");
  if (!switchedOn()) finish("switched off");
  try {
    saveCaption(await captionPhoto(url, model, photo, NIGHT_PHOTO_TIMEOUT_MS));
    captioned++;
  } catch (error) {
    failed++;
    const kind = error instanceof Error ? ((error as { code?: string }).code ?? error.message) : "failed";
    log({ event: "caption_failed", assetId: photo.id, error: kind });
    if (!(await modelAnswers())) finish("the model stopped answering", 1);
    recordCaptionFailure(photo.id, kind);
  }
}
finish("all done");
