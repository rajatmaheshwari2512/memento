// The record of videos whose noise was reduced (noise_jobs: db/migrations.ts).

import { database } from "../../db/database.ts";
import type { NoiseJobRow } from "../../types/reduce-noise.types.ts";

const now = () => new Date().toISOString();

export function addNoiseJob(job: { id: string; userId: string; assetId: string; videoMs: number | null; videoBytes: number | null }): void {
  database().prepare(
    "INSERT INTO noise_jobs (id, user_id, asset_id, state, video_ms, video_bytes, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
  ).run(job.id, job.userId, job.assetId, job.videoMs, job.videoBytes, now());
}

export function noiseJobRow(id: string): NoiseJobRow | undefined {
  return database().prepare("SELECT * FROM noise_jobs WHERE id = ?").get(id) as NoiseJobRow | undefined;
}

export function startNoiseJob(id: string): void {
  database().prepare("UPDATE noise_jobs SET state = 'running', started_at = ? WHERE id = ?").run(now(), id);
}

export function finishNoiseJob(id: string, copyId: string): void {
  database().prepare("UPDATE noise_jobs SET state = 'done', copy_id = ?, finished_at = ? WHERE id = ?").run(copyId, now(), id);
}

export function failNoiseJob(id: string, error: string): void {
  database().prepare("UPDATE noise_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(error, now(), id);
}

export function failUnfinishedNoiseJobs(error: string): number {
  return Number(database().prepare(
    "UPDATE noise_jobs SET state = 'failed', error = ?, finished_at = ? WHERE state IN ('queued', 'running')",
  ).run(error, now()).changes);
}
