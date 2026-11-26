// Edited copies of a photo, saved into its owner's library next to the original, with its date and place, stacked on top. The one save path for AI edits, Adjust and videos whose sound was cleaned. Saves take turns (inSaveLine).

import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { copyDateAndPlace, getAsset, restoreFromTrash, stackOnTop, uploadBlob, uploadFile } from "../clients/immich.client.ts";
import { config } from "../config.ts";
import {
  COPY_IN_TRASH, LOW_DISK, SAVE_WAIT_MS, SAVES_AT_ONCE, SAVES_TOO_LONG, SAVES_TOO_MANY, SAVES_WAITING, UPLOADS_FOLDER,
} from "../constants/copies.constants.ts";
import { UPLOAD_TIMEOUT_MS } from "../constants/http.constants.ts";
import type { Asset, Credential, Uploaded, User } from "../types/immich.types.ts";
import type { ImageMime } from "../types/image.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { extensionFor } from "../utils/image-type.ts";
import { WaitLine } from "../utils/wait-line.ts";

const saves = new WaitLine({
  running: SAVES_AT_ONCE,
  waiting: SAVES_WAITING,
  timeoutMs: SAVE_WAIT_MS,
  tooMany: () => new HttpError(503, SAVES_TOO_MANY),
  tooLong: () => new HttpError(503, SAVES_TOO_LONG),
});

// Runs a save when its turn comes: SAVES_AT_ONCE at a time, the rest waiting in line for up to SAVE_WAIT_MS.
export const inSaveLine = <T>(save: () => Promise<T>): Promise<T> => saves.run(save);

// Runs one save of a photo the app sends when its turn comes, with a fresh file to receive the upload in, removed afterwards. Refused (507) when the disk is nearly full.
export function withSaveSlot<T>(save: (path: string) => Promise<T>): Promise<T> {
  return inSaveLine(async () => {
    await requireFreeSpace(LOW_DISK);
    const folder = join(config.dataDir, UPLOADS_FOLDER);
    const path = join(folder, randomUUID());
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      return await save(path);
    } finally {
      await rm(path, { force: true });
    }
  });
}

// Refused (507, with `message`) when DATA_DIR has less than ADJUST_MIN_FREE_BYTES free.
export async function requireFreeSpace(message: string): Promise<void> {
  const space = await statfs(config.dataDir);
  if (space.bavail * space.bsize < config.adjustMinFreeBytes) throw new HttpError(507, message);
}

// Uploads left behind by a crash (at start).
export async function clearUploads(): Promise<void> {
  await rm(join(config.dataDir, UPLOADS_FOLDER), { recursive: true, force: true });
}

// Own photos only; not videos, not photos in the trash or the locked folder.
export function requireOwnPhoto(asset: Asset, user: User): void {
  if (asset.ownerId !== user.id) throw new HttpError(403, "You can only edit your own photos.");
  if (asset.type !== "IMAGE") throw new HttpError(400, "Only photos can be edited, not videos.");
  if (asset.isTrashed) throw new HttpError(400, "This photo is in the trash.");
  if (asset.isLocked) throw new HttpError(400, "Photos in the locked folder can't be edited.");
}

// The same for a video whose sound is cleaned: yours, a video, not in the trash, the locked folder, or the hidden video half of a live photo.
export function requireOwnVideo(asset: Asset, user: User): void {
  if (asset.ownerId !== user.id) throw new HttpError(403, "You can only reduce noise in your own videos.");
  if (asset.type !== "VIDEO" || asset.isHidden) throw new HttpError(400, "Only videos can have their noise reduced.");
  if (asset.isTrashed) throw new HttpError(400, "This video is in the trash.");
  if (asset.isLocked) throw new HttpError(400, "Videos in the locked folder can't be changed.");
}

// A copy's name: the original's with `suffix` ("beach day-edited.jpg").
function copyName(original: Asset, suffix: string, extension: string, fallback: string): string {
  const base = original.originalFileName.replace(/\.[^.]+$/, "").slice(0, 100) || fallback;
  return `${base}-${suffix}.${extension}`;
}

// Uploads the copy (a Blob) as a new photo of the caller, named after the original with `suffix` ("beach day-edited.jpg"). Uploading the same bytes again returns the same photo.
export async function uploadCopy(
  cred: Credential, original: Asset, image: Blob, mime: ImageMime, suffix: string,
): Promise<string> {
  const filename = copyName(original, suffix, extensionFor(mime), "photo");
  return savedCopy(cred, await uploadBlob(cred, image, filename, original.fileCreatedAt, "upload the edited photo", UPLOAD_TIMEOUT_MS));
}

// The same for a video: an open file in the work folder and its checked size, named like the original, with its extension. May take `timeoutMs`.
export async function uploadVideoCopy(
  cred: Credential, original: Asset, file: { handle: FileHandle; size: number }, mime: string, extension: string, suffix: string, timeoutMs: number,
): Promise<string> {
  const filename = copyName(original, suffix, extension, "video");
  return savedCopy(cred, await uploadFile(cred, file, mime, filename, original.fileCreatedAt, "upload the cleaned video", timeoutMs));
}

// The copy's id. A copy Immich already has in the trash is taken out of it; if Immich won't, the save fails.
async function savedCopy(cred: Credential, uploaded: Uploaded): Promise<string> {
  if (uploaded.status !== "duplicate" || !(await getAsset(cred, uploaded.id)).isTrashed) return uploaded.id;
  if ((await restoreFromTrash(cred, [uploaded.id])) && !(await getAsset(cred, uploaded.id)).isTrashed) return uploaded.id;
  throw new HttpError(409, COPY_IN_TRASH);
}

// Gives the copy the original's date and place, and stacks it on top of the original.
// Safe to repeat.
export async function placeWithOriginal(cred: Credential, copyId: string, original: Asset): Promise<void> {
  await copyDateAndPlace(cred, copyId, original);
  await stackOnTop(cred, copyId, original);
}
