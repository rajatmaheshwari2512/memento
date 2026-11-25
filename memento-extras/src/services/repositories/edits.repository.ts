// Edit results waiting to be saved or discarded, on disk in <DATA_DIR>/edits/:
//   <id>.bin   the image
//   <id>.json  who it belongs to, which photo, its type, and whether it was saved
// How long they're kept: services/edits.service.ts (removeExpiredEdits).

import { mkdir, open, readdir, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.ts";
import type { EditRecord } from "../../types/edits.types.ts";
import { isUuid } from "../../utils/http-error.ts";

const dir = join(config.dataDir, "edits");

export async function initStore(): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

// A new result: its image is moved in from `imagePath` (a file under DATA_DIR, so the move is a
// rename), then its record written.
export async function putEdit(record: EditRecord, imagePath: string): Promise<void> {
  await rename(imagePath, editImagePath(record));
  await writeAtomic(join(dir, `${record.id}.json`), JSON.stringify(record));
}

export async function updateEdit(record: EditRecord): Promise<void> {
  await writeAtomic(join(dir, `${record.id}.json`), JSON.stringify(record));
}

export async function getEdit(id: string): Promise<EditRecord | null> {
  if (!isUuid(id)) return null;
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as EditRecord;
  } catch {
    return null;
  }
}

// Where the result's image is (for an upload from disk, or a copy).
export function editImagePath(record: EditRecord): string {
  return join(dir, `${record.id}.bin`);
}

// The result's image, opened (it stays readable if the result is removed meanwhile), and its
// size; null if it's gone.
export async function openEditImage(record: EditRecord): Promise<{ file: FileHandle; size: number } | null> {
  let file: FileHandle;
  try {
    file = await open(editImagePath(record), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return { file, size: (await file.stat()).size };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function removeEdit(id: string): Promise<void> {
  if (!isUuid(id)) return;
  await rm(join(dir, `${id}.bin`), { force: true });
  await rm(join(dir, `${id}.json`), { force: true });
}

// Every edit result on disk, by ID.
export async function editIds(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}
