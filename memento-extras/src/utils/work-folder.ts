// The folder shared with the creations container (config.creationsWorkDir). Each creations job has its own folder, named by a UUID, removed when the job ends. Anything else found there at start is a leftover.

import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "../config.ts";
import { MIN_FREE_BYTES } from "../constants/creations.constants.ts";

export async function enoughSpace(): Promise<void> {
  const space = await statfs(config.creationsWorkDir);
  if (space.bavail * space.bsize < MIN_FREE_BYTES) throw new Error("not enough free disk space for creations");
}

// Runs `work` in a folder of its own, removed afterwards whatever happens.
export async function inWorkFolder<T>(work: (id: string, dir: string) => Promise<T>): Promise<T> {
  await enoughSpace();
  const id = randomUUID();
  const dir = join(config.creationsWorkDir, id);
  await mkdir(dir, { mode: 0o700 });
  try {
    return await work(id, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function jobFolder(workId: string): string {
  return join(config.creationsWorkDir, workId);
}

// The job's folder, emptied, for a fresh start.
export async function freshJobFolder(workId: string): Promise<string> {
  const dir = jobFolder(workId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

// Where to download `name` into the work folder `dir`, once `dir` is checked to be a real folder.
export async function inFolder(dir: string, name: string): Promise<string> {
  if (!(await lstat(dir)).isDirectory()) throw new Error("a work folder isn't a plain folder");
  return join(dir, name);
}

export async function removeJobFolder(workId: string | null): Promise<void> {
  if (workId) await rm(jobFolder(workId), { recursive: true, force: true });
}

const outgoing = () => join(config.dataDir, "outgoing");

// Removes every entry of `dir` not in `keep`, one at a time. Returns how many went.
async function clearOut(dir: string, keep: Set<string>, onError: (name: string, error: unknown) => void): Promise<number> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries.filter((n) => !keep.has(n))) {
    try {
      await rm(join(dir, name), { recursive: true, force: true });
      removed++;
    } catch (error) {
      onError(name, error);
    }
  }
  return removed;
}

// At start: everything but the folders of jobs still to finish, and any copy left half-uploaded.
export async function clearWorkFolder(keep: Set<string>, onError: (name: string, error: unknown) => void): Promise<number> {
  const removed = await clearOut(config.creationsWorkDir, keep, onError);
  return removed + await clearOut(outgoing(), new Set(), onError);
}

// A job's finished file, opened for reading, and its size, or null if it isn't there as a plain file of at most `maxBytes`. The caller closes it.
export async function openOutput(workId: string, name: string, maxBytes: number): Promise<{ handle: FileHandle; size: number } | null> {
  let handle: FileHandle;
  try {
    handle = await open(await inFolder(jobFolder(workId), name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (info.isFile() && info.size > 0 && info.size <= maxBytes) return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}

// A job's finished file (openOutput), copied out to a private folder. The caller removes the copy.
export async function takeOutput(workId: string, name: string, maxBytes: number): Promise<string | null> {
  const file = await openOutput(workId, name, maxBytes);
  if (!file) return null;
  try {
    await mkdir(outgoing(), { recursive: true, mode: 0o700 });
    const copy = join(outgoing(), `${workId}-${name}`);
    try {
      await pipeline(file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false }), createWriteStream(copy, { mode: 0o600 }));
    } catch (error) {
      await rm(copy, { force: true });
      throw error;
    }
    return copy;
  } finally {
    await file.handle.close();
  }
}
