// SelfPhotos Reduce noise for videos: the "Reduce noise" button in the video viewer. Memento's
// extras service cleans the video's sound on our own server (DeepFilterNet; memento-extras,
// POST /videos/:id/reduce-noise) and saves a copy stacked on top of the video; the picture isn't
// touched. The job is followed here, outside the viewer (GET /videos/jobs/:id every few
// seconds), so the person can keep browsing: a message when it starts, one with "Open" when it's
// done, a plain one if it fails. Not part of Immich.

import { AiEditError, errorMessage, request } from '#lib/ai-edit/ai-edit-api.ts';
import { isReduceNoiseEnabled, loadMementoFlags } from '#lib/ai-edit/flags.svelte.ts';
import { Route } from '#lib/route.ts';
import { toastManager, type ActionItem } from '@immich/ui';
import { mdiWaveform } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { goto } from '$app/navigation';

// What the service says about a job (memento-extras src/types/reduce-noise.types.ts).
export type ReduceNoiseJob = {
  jobId: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  assetId?: string; // the cleaned copy, once done
  error?: string; // why not, in words for the person
};

// The service's code for "cleaning other videos, try again in a few minutes".
const BUSY = 'busy';
const POLL_MS = 3000;
// The service unreachable this many times in a row (a minute): the job is given up on here (it
// carries on on the server; the copy still lands on top of the video).
const MAX_MISSES = 20;
// Followed for at most an hour in all (the server's longest wait and cleaning together), then
// given up on here with a plain message; the copy still lands on top of the video if it's made.
const GIVE_UP_MS = 60 * 60_000;

export const startReduceNoise = (assetId: string) =>
  request<ReduceNoiseJob>('POST', `/videos/${encodeURIComponent(assetId)}/reduce-noise`, {});

export const getReduceNoiseJob = (jobId: string) =>
  request<ReduceNoiseJob>('GET', `/videos/jobs/${encodeURIComponent(jobId)}`);

type Target = {
  id: string;
  isVideo: boolean;
  isTrashed: boolean;
  // Only your own videos (not in the locked folder or a shared link): the copy is saved into
  // your library, stacked on the original.
  isOwner: boolean;
};

// Whether Reduce noise can work on this video (the service checks the same, and its length and size).
export const canReduceNoise = (target: Target | undefined): target is Target =>
  isReduceNoiseEnabled() && !!target && target.isOwner && target.isVideo && !target.isTrashed;

// The videos being cleaned, followed from this tab: a second tap only says it's under way.
const following = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A refusal or failure, in the person's words where the service gave some.
const failure = ($t: MessageFormatter, error: unknown) => {
  if (error instanceof AiEditError && error.code === BUSY) {
    return $t('reduce_noise_busy');
  }
  return error instanceof AiEditError && error.fromService ? error.message : $t('reduce_noise_failed');
};

// Followed for too long: given up on here (it may still finish on the server).
class TooLong extends Error {}

// Asks about the job every `pollMs` until it's done or failed, for at most `giveUpMs` in all. A
// moment without the service is waited out.
async function follow(job: ReduceNoiseJob, pollMs: number, giveUpMs: number): Promise<ReduceNoiseJob> {
  const giveUpAt = Date.now() + giveUpMs;
  let misses = 0;
  while (job.state === 'queued' || job.state === 'running') {
    if (Date.now() >= giveUpAt) {
      throw new TooLong();
    }
    await sleep(pollMs);
    try {
      job = await getReduceNoiseJob(job.jobId);
      misses = 0;
    } catch (error) {
      if (error instanceof AiEditError && error.status === 0 && ++misses < MAX_MISSES) {
        continue;
      }
      throw error;
    }
  }
  return job;
}

// Starts cleaning the video's sound and follows it to the end, with a message at each step.
// `open` shows the cleaned copy (the viewer, by default); `pollMs`: how often it's asked about;
// `giveUpMs`: how long it's followed at most.
export async function reduceNoise(
  $t: MessageFormatter,
  assetId: string,
  { open = (copyId: string) => goto(Route.viewAsset({ id: copyId })), pollMs = POLL_MS, giveUpMs = GIVE_UP_MS } = {},
): Promise<void> {
  if (following.has(assetId)) {
    toastManager.info($t('reduce_noise_started'));
    return;
  }
  following.add(assetId);
  try {
    let job = await startReduceNoise(assetId);
    toastManager.info($t('reduce_noise_started'), { timeout: 5000 });
    job = await follow(job, pollMs, giveUpMs);
    const copyId = job.assetId;
    if (job.state === 'done' && copyId) {
      toastManager.success(
        {
          description: $t('reduce_noise_done'),
          button: (close) => ({
            label: $t('open'),
            onclick: () => {
              close();
              void open(copyId);
            },
          }),
        },
        { timeout: 10_000 },
      );
    } else {
      toastManager.danger(job.error ?? $t('reduce_noise_failed'));
    }
  } catch (error) {
    if (error instanceof TooLong) {
      toastManager.info($t('reduce_noise_too_long'));
      return;
    }
    console.warn('Reduce noise failed', errorMessage(error));
    toastManager.danger(failure($t, error));
  } finally {
    following.delete(assetId);
  }
}

// The button in the video viewer: your own videos only, while an admin has it switched on.
export const getReduceNoiseAction = ($t: MessageFormatter, target: Target | undefined): ActionItem => {
  void loadMementoFlags();
  return {
    title: $t('reduce_noise'),
    icon: mdiWaveform,
    $if: () => canReduceNoise(target),
    onAction: () => {
      if (target) {
        void reduceNoise($t, target.id);
      }
    },
  };
};
