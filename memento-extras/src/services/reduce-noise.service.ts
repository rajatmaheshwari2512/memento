// Reduce noise for videos (DECISIONS.md, "Videos: Reduce noise"): a video's sound cleaned up on
// our own server, saved as a copy like an edited photo (copies.service.ts): named after the
// original ("trip-reduce-noise.mp4"), with its date and place, stacked on top of it. Not a
// creation: no album, tag, memory or card. The cleaning is the creations container's
// (creations/src/noise.ts: DeepFilterNet; the picture copied as it is); this decides who may,
// when, and in what order.
//
//   - Asked for (POST /videos/:assetId/reduce-noise), it's checked at once: the switch, your own
//     video (not in the trash, the locked folder, or a live photo's hidden half), at most 10
//     minutes and 2 GB as Immich describes it, a kind of file the copy can be, not the night
//     captions' hours, free disk, room in the line. It answers with the job's id at once, and
//     the apps ask how it's going (GET /videos/jobs/:id) while the person keeps browsing.
//   - One video at a time for everyone, NOISE_LINE.waiting more in line (503 beyond). The line
//     is in memory, with the person's login, which is never stored: a restart ends what was in
//     it, and its record (noise_jobs) says so, so the app tells them to try again. Whether the
//     same video is already in line, and whether there's room, are decided at the moment a job
//     is added, with nothing awaited in between, so requests at the same moment can't add one
//     video twice or overfill the line.
//   - Whatever goes wrong with a job (even its record failing to be written), it ends as failed
//     and the line moves on; a job its record says is still going but that isn't in the line any
//     more is answered as failed.
//   - The night captions' hours: refused, saying when to try again, rather than kept until the
//     morning (the app asking would be long gone, and the line full all night). One that would
//     run into them is refused too; so is one still waiting when they come.
//   - A job waits while the container is busy (a creation being made) or the morning's memories
//     run is going (schedule.service.ts), up to REDUCE_NOISE_WAIT_SECONDS; no new creation's
//     render starts while a video waits or is cleaned (creations.service.ts), as a person is
//     waiting for it.
//   - When its turn comes the video is checked again (it may have been deleted meanwhile), its
//     original downloaded into the job's work folder (never into memory), cleaned, and the copy
//     uploaded straight from the folder, opened as creations' files are (the container isn't
//     trusted: no link followed, its size checked and never more read), and stacked. The job's
//     folder and files go whatever happens.

import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { CreationsBusy, CreationsUnreachable, ready, render, RenderUnsuitable } from "../clients/creations.client.ts";
import { downloadTo, getAsset } from "../clients/immich.client.ts";
import { config } from "../config.ts";
import {
  BUSY, BUSY_CODE, COPY_SUFFIX, FAILED, JOB_NOT_FOUND, LOW_DISK, NOISE_LINE, NOISE_SPACE_PER_VIDEO_BYTE, NOISE_TIMEOUT_MS, NOT_FOUND, quietMessage,
  REDUCE_NOISE_OFF, RESTARTED, TOO_BIG, TOO_LONG, UNSUITABLE, UNSUPPORTED_TYPE, VIDEO_LIMITS, VIDEO_TYPES, WAITED_TOO_LONG,
} from "../constants/reduce-noise.constants.ts";
import { placeWithOriginal, requireOwnVideo, uploadVideoCopy } from "./copies.service.ts";
import { getFlags } from "./flags.service.ts";
import {
  addNoiseJob, failNoiseJob, failUnfinishedNoiseJobs, finishNoiseJob, noiseJobRow, setNoiseStep, startNoiseJob,
} from "./repositories/reduce-noise.repository.ts";
import { fitsBeforeQuiet, rendersMayStart } from "./schedule.service.ts";
import type { Asset, Credential, User } from "../types/immich.types.ts";
import type { NoiseStatus, QueuedNoiseJob } from "../types/reduce-noise.types.ts";
import { HttpError, isUuid } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";
import { freshJobFolder, inFolder, openOutput, removeJobFolder } from "../utils/work-folder.ts";
import { type NoiseJob, OUTPUT_FILE } from "../../creations/src/job.ts";

const line: QueuedNoiseJob[] = []; // waiting, first come first served
let current: QueuedNoiseJob | null = null; // being cleaned
let draining = false;

export function requireReduceNoise(): void {
  if (!getFlags().reduceNoise.enabled) throw new HttpError(403, REDUCE_NOISE_OFF);
}

// Whether a person's video is waiting or being cleaned: no creation starts meanwhile.
export function videosWaiting(): boolean {
  return current !== null || line.length > 0;
}

// At start: the line was in memory, so whatever was in it is gone; its records say so.
export function recoverNoiseJobs(): void {
  const failed = failUnfinishedNoiseJobs(RESTARTED);
  if (failed > 0) log({ event: "reduce_noise_recovered", failed });
}

// Starts cleaning one of the person's videos (or, asked again while it's waiting or being
// cleaned, answers about that job). Everything is checked before it's queued.
export async function requestReduceNoise(user: User, cred: Credential, assetId: string): Promise<NoiseStatus> {
  requireReduceNoise();
  if (!isUuid(assetId)) throw new HttpError(404, NOT_FOUND);
  const asked = inLine(user, assetId);
  if (asked) return noiseStatus(user, asked.id);
  const video = await ownVideo(cred, user, assetId);
  const type = typeOf(video);
  if ((video.durationMs ?? 0) > VIDEO_LIMITS.videoSeconds * 1000) throw new HttpError(413, TOO_LONG);
  if ((video.fileSize ?? 0) > VIDEO_LIMITS.videoBytes) throw new HttpError(413, TOO_BIG);
  requireDaytime();
  await requireSpace(video.fileSize);
  // From here to the job in line, nothing is awaited: another request for the same video (asked
  // at the same moment) finds this job, and the line can't fill up meanwhile.
  const same = inLine(user, assetId);
  if (same) return noiseStatus(user, same.id);
  if ((current ? 1 : 0) + line.length >= 1 + NOISE_LINE.waiting) throw new HttpError(503, BUSY, { code: BUSY_CODE });
  const id = randomUUID();
  addNoiseJob({ id, userId: user.id, assetId, videoMs: video.durationMs, videoBytes: video.fileSize });
  line.push({ id, user, cred, assetId, ...type, queuedAt: Date.now() });
  log({ event: "reduce_noise_queued", job: id, user: user.id, asset: assetId, ahead: line.length - 1 + (current ? 1 : 0) });
  kick();
  return noiseStatus(user, id);
}

// The person's job for this video, if it's waiting or being cleaned.
function inLine(user: User, assetId: string): QueuedNoiseJob | undefined {
  return [current, ...line].find((job) => job?.user.id === user.id && job.assetId === assetId) ?? undefined;
}

// How the person's job is going (only theirs). One its record says is still going but that's
// neither in line nor being cleaned ended without its record being written (the database
// failing): it failed.
export function noiseStatus(user: User, id: string): NoiseStatus {
  const row = isUuid(id) ? noiseJobRow(id) : undefined;
  if (!row || row.user_id !== user.id) throw new HttpError(404, JOB_NOT_FOUND);
  const going = row.state === "queued" || row.state === "running";
  if (going && current?.id !== id && !line.some((job) => job.id === id)) return { jobId: row.id, state: "failed", error: FAILED };
  return {
    jobId: row.id,
    state: row.state,
    ...(row.copy_id ? { assetId: row.copy_id } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

// The person's own video, as requireOwnVideo says.
async function ownVideo(cred: Credential, user: User, assetId: string): Promise<Asset> {
  let video: Asset;
  try {
    video = await getAsset(cred, assetId);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw new HttpError(404, NOT_FOUND);
    throw error;
  }
  requireOwnVideo(video, user);
  return video;
}

// What its copy will be, from the original's extension (kept as it is, "trip.MOV" → "….MOV").
function typeOf(video: Asset): Pick<QueuedNoiseJob, "format" | "mime" | "extension"> {
  const extension = /\.([A-Za-z0-9]+)$/.exec(video.originalFileName)?.[1] ?? "";
  const type = Object.hasOwn(VIDEO_TYPES, extension.toLowerCase()) ? VIDEO_TYPES[extension.toLowerCase()] : undefined;
  if (!type) throw new HttpError(415, UNSUPPORTED_TYPE);
  return { ...type, extension };
}

// Refused in the night captions' hours, or when a job couldn't finish before they start.
function requireDaytime(): void {
  const quiet = config.renderQuietHours;
  if (!quiet || fitsBeforeQuiet(NOISE_TIMEOUT_MS.job)) return;
  const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  throw new HttpError(503, quietMessage(hhmm(quiet.from), hhmm(quiet.to)));
}

// Refused (507) when the work folder hasn't room for the video twice over and a margin.
async function requireSpace(videoBytes: number | null): Promise<void> {
  const space = await statfs(config.creationsWorkDir);
  if (space.bavail * space.bsize < config.reduceNoiseMinFreeBytes + NOISE_SPACE_PER_VIDEO_BYTE * (videoBytes ?? VIDEO_LIMITS.videoBytes)) {
    throw new HttpError(507, LOW_DISK);
  }
}

// Cleans what's in line, one at a time, in the background. Never throws (a failure is logged).
function kick(): void {
  drain().catch((error: unknown) => log({ event: "reduce_noise_worker_failed", error: error instanceof Error ? error.message : String(error) }));
}

// One job at a time, first come first served. Whatever goes wrong with one (its record failing to
// be written included), it's failed and the next one's turn comes.
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (line.length > 0) {
      const job = line[0]!;
      let started: number | undefined;
      try {
        await waitForTurn(job);
        line.shift();
        current = job;
        started = Date.now();
        await clean(job);
      } catch (error) {
        fail(job, error, started === undefined ? undefined : Date.now() - started);
      } finally {
        if (line[0] === job) line.shift();
        if (current === job) current = null;
      }
    }
  } finally {
    draining = false;
  }
}

// Waits until the container may take the job: free, no memories run going, not the night (see
// rendersMayStart). Throws what to tell the person if the switch went off, the night came, or
// it waited too long.
async function waitForTurn(job: QueuedNoiseJob): Promise<void> {
  for (;;) {
    requireReduceNoise();
    requireDaytime();
    if (rendersMayStart()) {
      try {
        await ready();
        return;
      } catch (error) {
        if (!(error instanceof CreationsBusy || error instanceof CreationsUnreachable)) throw error;
      }
    }
    if (Date.now() - job.queuedAt > config.reduceNoiseWaitSeconds * 1000) throw new HttpError(503, WAITED_TOO_LONG);
    await new Promise((resolve) => setTimeout(resolve, NOISE_LINE.pollMs));
  }
}

// Cleans one job's video and saves the copy; its folder is gone by the time it's marked done or
// failed. Throws what went wrong (drain fails the job).
async function clean(job: QueuedNoiseJob): Promise<void> {
  const started = Date.now();
  let copyId: string;
  try {
    startNoiseJob(job.id);
    copyId = await cleanAndSave(job);
  } finally {
    await removeJobFolder(job.id).catch(() => {});
  }
  finishNoiseJob(job.id, copyId);
  log({ event: "reduce_noise_done", job: job.id, user: job.user.id, asset: job.assetId, copy: copyId, ms: Date.now() - started });
}

// Checked again (it may have been deleted, trashed or locked while it waited), downloaded,
// cleaned, and its copy saved. Returns the copy's id.
async function cleanAndSave(job: QueuedNoiseJob): Promise<string> {
  const video = await ownVideo(job.cred, job.user, job.assetId);
  await requireSpace(video.fileSize);
  const dir = await freshJobFolder(job.id);
  const name = `video.${job.format}`;
  await downloadTo(job.cred, `/api/assets/${encodeURIComponent(job.assetId)}/original`, await inFolder(dir, name), VIDEO_LIMITS.videoBytes, NOISE_TIMEOUT_MS.download);
  setNoiseStep(job.id, "cleaning");
  await renderInTurn(job, { id: job.id, kind: "reduce-noise", video: name, format: job.format });
  const copy = await openOutput(job.id, OUTPUT_FILE["reduce-noise"], VIDEO_LIMITS.bytes);
  if (!copy) throw new Error("the container's copy wasn't there afterwards");
  try {
    setNoiseStep(job.id, "saving");
    const copyId = await uploadVideoCopy(job.cred, video, copy, job.mime, job.extension, COPY_SUFFIX, NOISE_TIMEOUT_MS.upload);
    await placeWithOriginal(job.cred, copyId, video);
    return copyId;
  } finally {
    await copy.handle.close();
  }
}

// The container cleans it; if another job took the container while this one downloaded (the
// memories run's photo checks), it waits its turn again.
async function renderInTurn(job: QueuedNoiseJob, request: NoiseJob): Promise<void> {
  for (;;) {
    await waitForTurn(job);
    try {
      return await render(request, NOISE_TIMEOUT_MS.clean);
    } catch (error) {
      if (!(error instanceof CreationsBusy || error instanceof CreationsUnreachable)) throw error;
    }
  }
}

// Records the job as failed, with what the person is told. Never throws: if even that can't be
// written, it's logged, and noiseStatus answers "failed" from the line.
function fail(job: QueuedNoiseJob, error: unknown, ms?: number): void {
  const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
  log({ event: "reduce_noise_failed", job: job.id, user: job.user.id, asset: job.assetId, ...(ms === undefined ? {} : { ms }), error: text(error) });
  try {
    failNoiseJob(job.id, messageFor(error));
  } catch (recordError) {
    log({ event: "reduce_noise_record_failed", job: job.id, error: text(recordError) });
  }
}

// What the person is told: the container's reason in their words, a refusal's own message
// (a download over the limit says so), or that it failed.
function messageFor(error: unknown): string {
  if (error instanceof RenderUnsuitable) return Object.hasOwn(UNSUITABLE, error.reason) ? UNSUITABLE[error.reason]! : FAILED;
  if (error instanceof HttpError) return error.status === 413 ? TOO_BIG : error.message;
  return FAILED;
}
