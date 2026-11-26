import type { MementoFlags } from '#lib/ai-edit/ai-edit-api.ts';
import { mementoFlags } from '#lib/ai-edit/flags.svelte.ts';
import { canReduceNoise, getReduceNoiseAction, reduceNoise } from '#lib/ai-edit/reduce-noise.ts';
import { toastManager } from '@immich/ui';
import type { MessageFormatter } from 'svelte-i18n';

const video = { id: 'v1', isVideo: true, isTrashed: false, isOwner: true };
const flags = (enabled: boolean | undefined) =>
  ({ reduceNoise: enabled === undefined ? undefined : { enabled } }) as unknown as MementoFlags;
const $t = ((key: string) => key) as unknown as MessageFormatter;

const answers = (...bodies: Array<{ status?: number; body: unknown }>) => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const { status = 200, body } of bodies) {
    fetch.mockResolvedValueOnce(Response.json(body, { status }));
  }
  return fetch;
};

describe('Reduce noise', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let success: ReturnType<typeof vi.spyOn>;
  let danger: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    info = vi.spyOn(toastManager, 'info').mockImplementation(() => {});
    success = vi.spyOn(toastManager, 'success').mockImplementation(() => {});
    danger = vi.spyOn(toastManager, 'danger').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mementoFlags.value = null;
  });

  it('is for your own videos only, not photos or the trash, and follows the admin switch', () => {
    expect(canReduceNoise(video)).toBe(true);
    expect(canReduceNoise({ ...video, isOwner: false })).toBe(false);
    expect(canReduceNoise({ ...video, isVideo: false })).toBe(false);
    expect(canReduceNoise({ ...video, isTrashed: true })).toBe(false);
    expect(canReduceNoise(undefined)).toBe(false);
    mementoFlags.value = flags(false);
    expect(canReduceNoise(video)).toBe(false);
    mementoFlags.value = flags(undefined);
    expect(canReduceNoise(video)).toBe(false);
    mementoFlags.value = flags(true);
    expect(canReduceNoise(video)).toBe(true);
    expect(getReduceNoiseAction($t, video).title).toBe('reduce_noise');
  });

  it('says it started, follows the job while the person browses, and offers to open the copy', async () => {
    const fetch = answers(
      { status: 202, body: { jobId: 'j1', state: 'queued' } },
      { body: { jobId: 'j1', state: 'running' } },
      { body: { jobId: 'j1', state: 'done', assetId: 'copy-1' } },
    );
    const open = vi.fn();
    await reduceNoise($t, 'v1', { open, pollMs: 1 });
    expect(fetch.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      'POST /extras/videos/v1/reduce-noise',
      'GET /extras/videos/jobs/j1',
      'GET /extras/videos/jobs/j1',
    ]);
    expect(info).toHaveBeenCalledWith('reduce_noise_started', { timeout: 5000 });
    expect(danger).not.toHaveBeenCalled();
    const [toast, options] = success.mock.calls[0] as [
      { description: string; button: (close: () => void) => { label: string; onclick: () => void } },
      { timeout: number },
    ];
    expect(toast.description).toBe('reduce_noise_done');
    expect(options, 'as long as on Android').toEqual({ timeout: 10_000 });
    const close = vi.fn();
    const button = toast.button(close);
    expect(button.label).toBe('open');
    button.onclick();
    expect(close).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('copy-1');
  });

  it("a failure shows the service's own words; busy shows the app's", async () => {
    answers(
      { status: 202, body: { jobId: 'j2', state: 'queued' } },
      { body: { jobId: 'j2', state: 'failed', error: 'This video has no sound to clean up.' } },
    );
    await reduceNoise($t, 'v2', { pollMs: 1 });
    expect(danger).toHaveBeenLastCalledWith('This video has no sound to clean up.');

    answers({ status: 503, body: { error: 'Memento is cleaning other videos right now.', code: 'busy' } });
    await reduceNoise($t, 'v3');
    expect(danger).toHaveBeenLastCalledWith('reduce_noise_busy');

    answers({ status: 413, body: { error: 'Reduce noise works on videos up to 10 minutes long.' } });
    await reduceNoise($t, 'v4');
    expect(danger).toHaveBeenLastCalledWith('Reduce noise works on videos up to 10 minutes long.');
    expect(success).not.toHaveBeenCalled();
  });

  it('a second tap while it runs only says it is under way; a moment offline is waited out', async () => {
    const fetch = answers({ status: 202, body: { jobId: 'j5', state: 'queued' } });
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetch.mockResolvedValueOnce(Response.json({ jobId: 'j5', state: 'done', assetId: 'copy-5' }));
    const running = reduceNoise($t, 'v5', { open: vi.fn(), pollMs: 20 });
    await reduceNoise($t, 'v5');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenLastCalledWith('reduce_noise_started');
    await running;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(success).toHaveBeenCalledTimes(1);
    expect(danger).not.toHaveBeenCalled();
  });

  it('stops following after its time limit, with a plain "taking too long" message', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(Response.json({ jobId: 'j6', state: 'queued' }, { status: 202 }));
    fetch.mockImplementation(() => Promise.resolve(Response.json({ jobId: 'j6', state: 'running' })));
    await reduceNoise($t, 'v6', { pollMs: 5, giveUpMs: 40 });
    expect(info).toHaveBeenLastCalledWith('reduce_noise_too_long');
    expect(danger).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    const asked = fetch.mock.calls.length;
    expect(asked).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetch).toHaveBeenCalledTimes(asked);
    fetch.mockResolvedValueOnce(Response.json({ jobId: 'j6', state: 'done', assetId: 'copy-6' }, { status: 202 }));
    await reduceNoise($t, 'v6', { open: vi.fn() });
    expect(success).toHaveBeenCalledTimes(1);
  });
});
