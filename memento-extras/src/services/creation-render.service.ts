// Making one creation (a queued job, creations.service.ts): each photo checked again, the inputs downloaded into the job's folder, rendered by the creations container, then uploaded into the person's library, tagged Memento/Creations and added to their album. The job's folder is kept until the upload works.

import { openAsBlob } from "node:fs";
import { rm } from "node:fs/promises";
import { CreationsBusy, render, renderState } from "../clients/creations.client.ts";
import { addToAlbum, createAlbum, downloadTo, facesOf, getAlbum, getAsset, tagAssets, uploadBlob } from "../clients/immich.client.ts";
import { ALBUM_NAME, EXTENSION, FILE_PREFIX, MAX_BYTES, MIME, OUTPUT, RECAP, TAG, TIMEOUT_MS } from "../constants/creations.constants.ts";
import { evenly } from "./memory-picks.service.ts";
import { albumId, markRendered, recordAsset, saveAlbumId } from "./repositories/creations.repository.ts";
import { memoriesRunning } from "./schedule.service.ts";
import type { CreationKind, Job, JobInputs, JobItem } from "../types/creations.types.ts";
import type { Credential } from "../types/immich.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { enoughSpace, freshJobFolder, inFolder, takeOutput } from "../utils/work-folder.ts";
import { LIMITS, type RecapItem, type RenderJob } from "../../creations/src/job.ts";
import type { Box } from "../../creations/src/layout.ts";

// The job can't be made any more (too few of its photos are left): dropped, not retried.
export class JobGone extends Error {}

// The person's "Collages", "Recaps", "Animations" or "Cinematic" album: found by id, or a new one if it was deleted.
async function albumFor(cred: Credential, userId: string, kind: CreationKind): Promise<string> {
  const known = albumId(userId, kind);
  if (known) {
    const album = await getAlbum(cred, known);
    if (album && album.ownerId === userId) return known;
  }
  const album = await createAlbum(cred, ALBUM_NAME[kind]);
  saveAlbumId(userId, kind, album.id);
  return album.id;
}

async function stillThere(cred: Credential, userId: string, item: JobItem): Promise<boolean> {
  try {
    const asset = await getAsset(cred, item.id);
    return asset.ownerId === userId && !asset.isTrashed && asset.inTimeline;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    throw error;
  }
}

// The job's items that are still there, or JobGone if too few are left to make it.
async function itemsLeft(cred: Credential, job: Job, inputs: JobInputs): Promise<JobItem[]> {
  const left: JobItem[] = [];
  for (const item of inputs.items) if (await stillThere(cred, job.user_id, item)) left.push(item);
  const photos = left.filter((i) => i.image);
  const gone = () => new JobGone("too few of its photos are left");
  switch (job.kind) {
    case "collage": {
      const n = LIMITS.collageSizes.find((size) => size <= photos.length);
      if (!n) throw gone();
      return evenly(photos, n);
    }
    case "recap":
      if (photos.length < RECAP.minPhotos) throw gone();
      return left;
    case "animation":
      if (photos.length < LIMITS.animationFrames.min) throw gone();
      return photos;
    case "cinematic":
      if (photos.length < 1) throw gone();
      return photos.slice(0, 1);
  }
}

// A photo's biggest faces, as many as the container takes, rounded.
export function mainFaces(faces: Box[]): Box[] {
  const area = ([x1, y1, x2, y2]: Box) => (x2 - x1) * (y2 - y1);
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
  return [...faces].sort((a, b) => area(b) - area(a)).slice(0, LIMITS.faces).map((f) => f.map(round) as Box).filter(([x1, y1, x2, y2]) => x1 < x2 && y1 < y2);
}

// The items, downloaded into `dir`, as the container's job (with each photo's faces, if `faces`).
async function download(cred: Credential, items: JobItem[], dir: string, faces: boolean): Promise<RecapItem[]> {
  const out: RecapItem[] = [];
  for (const [i, item] of items.entries()) {
    const id = encodeURIComponent(item.id);
    if (item.image) {
      await downloadTo(cred, `/api/assets/${id}/thumbnail?size=preview&edited=true`, await inFolder(dir, `${i}.jpg`), MAX_BYTES.preview);
      out.push({ kind: "photo", file: `${i}.jpg`, faces: faces ? mainFaces(await facesOf(cred, item.id)) : [] });
      continue;
    }
    try {
      await downloadTo(cred, `/api/assets/${id}/video/playback`, await inFolder(dir, `${i}.mp4`), MAX_BYTES.video, 300_000);
      out.push({ kind: "video", file: `${i}.mp4`, durationMs: item.durationMs ?? 0 });
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 413)) throw error;
    }
  }
  return out;
}

// The container's job for these downloaded inputs.
function renderJob(job: Job, media: RecapItem[], { stamp: { local, offset, gps }, moods = [] }: JobInputs): RenderJob {
  const id = job.work_id!;
  const stamp = { local, offset, gps };
  const photo = (p: RecapItem) => ({ file: p.file, faces: p.kind === "photo" ? p.faces : [] });
  switch (job.kind) {
    case "collage": return { id, kind: "collage", photos: media.map(photo), stamp };
    case "recap": return { id, kind: "recap", items: media, stamp, moods };
    case "animation": return { id, kind: "animation", frames: media.map((p) => p.file), stamp };
    case "cinematic": return { id, kind: "cinematic", photo: photo(media[0]!), stamp };
  }
}

// Downloads the inputs into a fresh job folder and has the container render them there.
async function renderInFolder(job: Job, inputs: JobInputs, cred: Credential): Promise<void> {
  markRendered(job.id, false);
  const items = await itemsLeft(cred, job, inputs);
  await enoughSpace();
  const dir = await freshJobFolder(job.work_id!);
  const request = renderJob(job, await download(cred, items, dir, job.kind !== "animation"), inputs);
  if (memoriesRunning()) throw new CreationsBusy("a themed-memories run is going");
  await render(request, TIMEOUT_MS[job.kind]);
  markRendered(job.id, true);
}

async function upload(job: Job, inputs: JobInputs, cred: Credential, file: string): Promise<string> {
  const day = inputs.stamp.local.slice(0, 10).replace(/-/g, "");
  const name = `${FILE_PREFIX[job.kind]}-${day}-${job.id}.${EXTENSION[job.kind]}`;
  return (await uploadBlob(cred, await openAsBlob(file, { type: MIME[job.kind] }), name, inputs.stamp.utc, `save the ${job.kind}`, 300_000)).id;
}

// Makes the job's creation (unless it was uploaded on an earlier try) and files it. Returns its asset id; throws if anything fails.
export async function makeCreation(job: Job, cred: Credential): Promise<string> {
  const inputs = JSON.parse(job.inputs) as JobInputs;
  let assetId = job.asset_id;
  if (!assetId) {
    const output = OUTPUT[job.kind];
    const finished = job.rendered_at !== null || (await renderState(job.work_id!)) === "done";
    let file = finished ? await takeOutput(job.work_id!, output.file, output.maxBytes) : null;
    if (file) markRendered(job.id, true);
    else {
      await renderInFolder(job, inputs, cred);
      file = await takeOutput(job.work_id!, output.file, output.maxBytes);
      if (!file) throw new Error("the container's file wasn't there afterwards");
    }
    try {
      assetId = await upload(job, inputs, cred, file);
    } finally {
      await rm(file, { force: true });
    }
    recordAsset(job.id, assetId);
  }
  await tagAssets(cred, TAG, [assetId]);
  await addToAlbum(cred, await albumFor(cred, job.user_id, job.kind), [assetId]);
  return assetId;
}
