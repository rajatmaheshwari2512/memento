// AI edits: making one with Gemini, showing the result to whoever made it, saving it into their library next to the original, discarding it, and deleting old results.

import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAsset, getSourceImage } from "../clients/immich.client.ts";
import { config } from "../config.ts";
import {
  EDIT_FILES_FOLDER, EDIT_WAIT_MS, EDITS_AT_ONCE, EDITS_LOW_DISK, EDITS_TOO_LONG, EDITS_TOO_MANY, EDITS_WAITING, FOUR_K_OVER_PIXELS,
  FULL_SIZE_MIN_SHARE, FULL_SIZE_SHAPE_TOLERANCE, GEMINI_OFF, MAX_EDIT_PIXELS, MAX_EDIT_SIDE, PHOTO_TOO_LARGE, PHOTO_TOO_LARGE_CODE,
  TOOLS_OFF,
} from "../constants/edits.constants.ts";
import { gemini, GeminiRefused } from "../clients/gemini.client.ts";
import { inSaveLine, placeWithOriginal, requireFreeSpace, requireOwnPhoto, uploadCopy, withSaveSlot } from "./copies.service.ts";
import { getFlags } from "./flags.service.ts";
import { tryFreeTool } from "./free-first.service.ts";
import { finish, reserve, usage } from "./limits.service.ts";
import {
  editIds, editImagePath, getEdit, openEditImage, putEdit, removeEdit, updateEdit,
} from "./repositories/edits.repository.ts";
import type { AlignmentReport, EditImage, EditMade, EditRecord, EditRequest, EditSource } from "../types/edits.types.ts";
import type { Flags } from "../types/flags.types.ts";
import type { ImageSize } from "../types/edit-provider.types.ts";
import type { Asset, Credential, User } from "../types/immich.types.ts";
import type { ImageMime } from "../types/image.types.ts";
import { HttpError, isUuid } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";
import { extensionFor, imageFileSize } from "../utils/image-type.ts";
import { WaitLine } from "../utils/wait-line.ts";

// Automatic, by the photo's size: 4K when the original is clearly bigger than a 2K result, otherwise 2K.
function sizeFor(asset: Asset): ImageSize {
  if (config.imageSize !== "auto") return config.imageSize;
  const { width, height } = shownSize(asset);
  return width * height > FOUR_K_OVER_PIXELS ? "4K" : "2K";
}

// The photo as shown (with Immich's own crop), else the original's; 0 × 0 when Immich doesn't know.
function shownSize(asset: Asset): { width: number; height: number } {
  return asset.shownWidth !== null && asset.shownHeight !== null
    ? { width: asset.shownWidth, height: asset.shownHeight }
    : { width: asset.width ?? 0, height: asset.height ?? 0 };
}

// Very large photos aren't AI-edited (constants/edits.constants.ts, MAX_EDIT_PIXELS).
function requireEditableSize(asset: Asset): void {
  const { width, height } = shownSize(asset);
  if (width * height > MAX_EDIT_PIXELS || Math.max(width, height) > MAX_EDIT_SIDE) {
    throw new HttpError(413, PHOTO_TOO_LARGE, { code: PHOTO_TOO_LARGE_CODE });
  }
}

// The admin's "Allow full quality (4K)" switch. Off: nothing is made at 4K, including
// "Edit more" on an earlier 4K result.
function allowedSize(size: ImageSize, flags: Flags): ImageSize {
  return size === "4K" && !flags.gemini.allow4k ? "2K" : size;
}

// Loads an edit result, but only for the user who made it.
async function ownEdit(id: string, userId: string): Promise<EditRecord> {
  const record = isUuid(id) ? await getEdit(id) : null;
  if (!record || record.userId !== userId) throw new HttpError(404, "Edit not found. Unsaved edits are deleted after an hour.");
  return record;
}

// Checked before anything else by the route: when off, nothing is read from Immich or sent
// to Google.
export function requireGemini(): Flags {
  const flags = getFlags();
  if (!flags.gemini.enabled) throw new HttpError(403, GEMINI_OFF);
  return flags;
}

// The AI tools (presets and highlighting) on top of that: refused when off.
export function requireTools(flags: Flags): void {
  if (!flags.gemini.tools) throw new HttpError(403, TOOLS_OFF);
}

const edits = new WaitLine({
  running: EDITS_AT_ONCE,
  waiting: EDITS_WAITING,
  timeoutMs: EDIT_WAIT_MS,
  tooMany: () => new HttpError(503, EDITS_TOO_MANY),
  tooLong: () => new HttpError(503, EDITS_TOO_LONG),
});

// Runs an edit when its turn comes (EDITS_AT_ONCE at a time), with a fresh folder for its files, removed afterwards. Refused (507) when the disk is nearly full.
export function inEditLine<T>(job: (folder: string) => Promise<T>): Promise<T> {
  return edits.run(async () => {
    await requireFreeSpace(EDITS_LOW_DISK);
    const folder = join(config.dataDir, EDIT_FILES_FOLDER, randomUUID());
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      return await job(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new HttpError(507, EDITS_LOW_DISK);
      throw error;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
}

export async function clearEditFiles(): Promise<void> {
  await rm(join(config.dataDir, EDIT_FILES_FOLDER), { recursive: true, force: true });
}

// Made in `folder`, the edit's own. `wanted` is asked again just before the edit is counted: null if the person left.
export async function makeEdit(
  user: User, cred: Credential, flags: Flags, request: EditRequest, folder: string, wanted: () => boolean = () => true,
): Promise<EditMade | null> {
  const { assetId, fromEditId, prompt, tools, mark, photo } = request;
  if (mark || tools.length > 0) requireTools(flags);
  const asset = await getAsset(cred, assetId);
  requireOwnPhoto(asset, user);

  const free = await tryFreeTool(user, asset, request);
  if (free !== null) return free;
  requireEditableSize(asset);

  // "Edit more" works on the previous result instead of the original, at its size.
  let source: EditSource;
  let parentEditId: string | null = null;
  let size: ImageSize;
  if (fromEditId !== null) {
    const previous = await ownEdit(fromEditId, user.id);
    if (previous.assetId !== assetId) throw new HttpError(400, "That edit belongs to a different photo.");
    const path = join(folder, "previous");
    await copyFile(editImagePath(previous), path);
    source = { path, mime: previous.mime, bytes: (await stat(path)).size, from: "edit" };
    parentEditId = previous.id;
    size = allowedSize(previous.size, flags);
  } else {
    // A highlighted edit: the app's upright photo, so it matches the mark (EditRequest).
    source = photo ? { ...photo, from: "app" } : await getSourceImage(cred, asset, folder);
    size = allowedSize(sizeFor(asset), flags);
  }

  if (!wanted()) return null;
  const id = randomUUID();
  const refused = reserve(id, user.id, assetId, prompt.length, gemini.model);
  if (refused) throw new HttpError(429, refused, { usage: usage(user.id) });

  const started = Date.now();
  try {
    const out = await gemini.edit({ image: source, prompt, size, mark: mark ?? undefined, folder });
    const area = mark !== null;
    await putEdit(
      {
        id, userId: user.id, assetId, mime: out.image.mime, model: out.model, size, area, createdAt: new Date().toISOString(), parentEditId,
        savedAssetId: null, saved: false,
      },
      out.image.path,
    );
    finish(id, true, Date.now() - started, out.costUsd);
    log({
      event: "edit", edit: id, user: user.id, asset: assetId, provider: gemini.name, model: out.model, tools, size, area, from: source.from,
      ms: Date.now() - started, bytesIn: source.bytes, markBytes: mark?.bytes ?? 0, bytesOut: out.image.bytes, costUsd: out.costUsd,
    });
    return { editId: id, size, usage: usage(user.id) };
  } catch (error) {
    finish(id, false, Date.now() - started, 0);
    const reason = error instanceof GeminiRefused ? "gemini_refused" : error instanceof Error ? error.message : String(error);
    log({ event: "edit_failed", edit: id, user: user.id, asset: assetId, ms: Date.now() - started, error: reason });
    throw error;
  }
}

// The result, for whoever made it, opened to be sent from disk, with the name it downloads under.
export async function editImage(user: User, id: string): Promise<EditImage> {
  const record = await ownEdit(id, user.id);
  const image = await openEditImage(record);
  if (!image) throw new HttpError(404, "Edit not found. Unsaved edits are deleted after an hour.");
  return { record, ...image, filename: `ai-edit-${id.slice(0, 8)}.${extensionFor(record.mime)}` };
}

// Saves the result into the user's library, stacked on top of the original. Safe to retry. A highlighted edit is normally pasted by the app (saveAreaEdit); its whole result only when the app says so (`whole`).
export async function saveEdit(user: User, cred: Credential, id: string, whole: boolean): Promise<string> {
  const record = await ownEdit(id, user.id);
  if (record.area && !whole) {
    throw new HttpError(400, "This is an edit of a highlighted area: the app pastes it onto the photo, or saves the whole result with { whole: true }.");
  }
  if (record.saved && record.savedAssetId) return record.savedAssetId;

  const original = await getAsset(cred, record.assetId);
  if (original.ownerId !== user.id) throw new HttpError(403, "You can only save edits of your own photos.");

  // Takes its turn with other saves (copies.service.ts).
  const savedAssetId = await inSaveLine(async () => {
    if (!record.savedAssetId) {
      const image = await openAsBlob(editImagePath(record), { type: record.mime });
      record.savedAssetId = await uploadCopy(cred, original, image, record.mime, `ai-edit-${id.slice(0, 8)}`);
      await updateEdit(record);
    }
    await placeWithOriginal(cred, record.savedAssetId, original);
    return record.savedAssetId;
  });
  record.saved = true;
  await updateEdit(record);
  log({ event: "saved", edit: id, user: user.id, asset: record.assetId, newAsset: savedAssetId });
  return savedAssetId;
}

// An edit of a highlighted area: the app pastes that area of the result onto the original at full size and sends the photo, which `receive` streams to a file. Saved like saveEdit's; safe to retry.
export async function saveAreaEdit(
  user: User, cred: Credential, id: string, mime: ImageMime, receive: (path: string) => Promise<void>,
): Promise<string> {
  const record = await ownEdit(id, user.id);
  if (!record.area) throw new HttpError(400, "This isn't an edit of a highlighted area: save it with /save.");
  if (record.saved && record.savedAssetId) return record.savedAssetId;
  const original = await getAsset(cred, record.assetId);
  if (original.ownerId !== user.id) throw new HttpError(403, "You can only save edits of your own photos.");

  const savedAssetId = await withSaveSlot(async (path) => {
    if (!record.savedAssetId) {
      await receive(path);
      const size = await imageFileSize(path, mime);
      if (!size || !isFullSize(size, original)) throw new HttpError(400, "That isn't this photo at its full size.");
      record.savedAssetId = await uploadCopy(cred, original, await openAsBlob(path, { type: mime }), mime, `ai-edit-${id.slice(0, 8)}`);
      await updateEdit(record);
    }
    await placeWithOriginal(cred, record.savedAssetId, original);
    return record.savedAssetId;
  });
  record.saved = true;
  await updateEdit(record);
  log({ event: "saved", edit: id, user: user.id, asset: record.assetId, newAsset: savedAssetId, pasted: true });
  return savedAssetId;
}

// The original with an area pasted on, at full size: the photo's size as shown or, when Immich doesn't say, the original's either way round.
function isFullSize(size: { width: number; height: number }, original: Asset): boolean {
  if (original.shownWidth !== null && original.shownHeight !== null) return fitsFullSize(size, original.shownWidth, original.shownHeight);
  if (original.width === null || original.height === null) return true;
  return fitsFullSize(size, original.width, original.height) || fitsFullSize(size, original.height, original.width);
}

// Each side at least FULL_SIZE_MIN_SHARE of the full size and not larger, the same orientation,
// and the same shape within FULL_SIZE_SHAPE_TOLERANCE.
function fitsFullSize({ width, height }: { width: number; height: number }, fullWidth: number, fullHeight: number): boolean {
  if (width > fullWidth || height > fullHeight) return false;
  if (width < fullWidth * FULL_SIZE_MIN_SHARE || height < fullHeight * FULL_SIZE_MIN_SHARE) return false;
  if ((width > height && fullWidth < fullHeight) || (width < height && fullWidth > fullHeight)) return false;
  return Math.abs(width / height / (fullWidth / fullHeight) - 1) <= FULL_SIZE_SHAPE_TOLERANCE;
}

// How an app lined a highlighted edit's result up with the photo: logged, numbers only.
export async function logAlignment(user: User, id: string, report: AlignmentReport): Promise<void> {
  const record = await ownEdit(id, user.id);
  log({ event: "alignment", edit: id, user: user.id, size: record.size, ...report });
}

export async function discardEdit(user: User, id: string): Promise<void> {
  await ownEdit(id, user.id);
  await removeEdit(id);
}

// Results older than RESULT_TTL_MINUTES are deleted, saved or not. Returns how many went.
export async function removeExpiredEdits(): Promise<number> {
  const cutoff = Date.now() - config.resultTtlMinutes * 60_000;
  let removed = 0;
  for (const id of await editIds()) {
    const record = await getEdit(id);
    if (!record || Date.parse(record.createdAt) < cutoff) {
      await removeEdit(id);
      removed++;
    }
  }
  return removed;
}
