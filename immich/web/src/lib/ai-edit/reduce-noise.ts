// SelfPhotos Reduce noise for videos: the "Reduce noise" button in the video viewer.

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
  assetId?: string;
  error?: string;
};

const BUSY = 'busy';
const POLL_MS = 3000;
const MAX_MISSES = 20;
const GIVE_UP_MS = 60 * 60_000;

export const startReduceNoise = (assetId: string) =>
  request<ReduceNoiseJob>('POST', `/videos/${encodeURIComponent(assetId)}/reduce-noise`, {});

export const getReduceNoiseJob = (jobId: string) =>
  request<ReduceNoiseJob>('GET', `/videos/jobs/${encodeURIComponent(jobId)}`);

type Target = {
  id: string;
  isVideo: boolean;
  isTrashed: boolean;
  isOwner: boolean;
};

// Whether Reduce noise can work on this video (the service checks the same, and its length and
// size).
export const canReduceNoise = (target: Target | undefined): target is Target =>
  isReduceNoiseEnabled() && !!target && target.isOwner && target.isVideo && !target.isTrashed;

const following = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const failure = ($t: MessageFormatter, error: unknown) => {
  if (error instanceof AiEditError && error.code === BUSY) {
    return $t('reduce_noise_busy');
  }
  return error instanceof AiEditError && error.fromService ? error.message : $t('reduce_noise_failed');
};

class TooLong extends Error {}

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
