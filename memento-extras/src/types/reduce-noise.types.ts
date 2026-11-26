// Reduce noise for videos (services/reduce-noise.service.ts).

import type { VideoFormat } from "../../creations/src/job.ts";
import type { Credential, User } from "./immich.types.ts";

export type NoiseState = "queued" | "running" | "done" | "failed";
export type NoiseStep = "preparing" | "cleaning" | "saving";

// A row of noise_jobs (db/migrations.ts, step 12).
export type NoiseJobRow = {
  id: string; user_id: string; asset_id: string; state: NoiseState; step: NoiseStep | null; copy_id: string | null; error: string | null;
  video_ms: number | null; video_bytes: number | null; created_at: string; started_at: string | null; finished_at: string | null;
};

// A job in the line, in memory only.
export type QueuedNoiseJob = {
  id: string; user: User; cred: Credential; assetId: string; format: VideoFormat; mime: string; extension: string; queuedAt: number;
};

// What POST /videos/:assetId/reduce-noise and GET /videos/jobs/:id answer. `assetId`: the cleaned
// copy, once done. `error`: why not, in words for the person.
export type NoiseStatus = { jobId: string; state: NoiseState; assetId?: string; error?: string };
