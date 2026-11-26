import type * as AiArea from '#lib/ai-edit/ai/ai-area.ts';
import type { MockData } from '#test/common/data.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import type { MockRouter } from '#test/unit/mocks/router.ts';
import { cleanup } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import Page from './+page.svelte';
import { load } from './+page.ts';

vi.mock('#lib/ai-edit/adjust/save-copy.ts', () => ({
  saveCopy: async (save: () => Promise<{ assetId: string }>) => {
    const { assetId } = await save();
    return assetId;
  },
}));

const area = vi.hoisted(() => ({
  held: { align: Promise.resolve(), pasted: Promise.resolve() },
  reached: { align: 0, pasted: 0 },
}));
vi.mock('#lib/ai-edit/ai/ai-area.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AiArea>();
  return {
    ...actual,
    alignFor: async (...args: Parameters<typeof actual.alignFor>) => {
      area.reached.align++;
      await area.held.align;
      return actual.alignFor(...args);
    },
    pasteOnto: async (...args: Parameters<typeof actual.pasteOnto>) => {
      const paste = await actual.pasteOnto(...args);
      area.reached.pasted++;
      await area.held.pasted;
      return paste;
    },
  };
});

beforeEach(() => {
  area.held = { align: Promise.resolve(), pasted: Promise.resolve() };
  area.reached = { align: 0, pasted: 0 };
});

const gate = () => {
  let go = () => {};
  const promise = new Promise<void>((resolve) => (go = resolve));
  return { promise, go };
};

const holdArea = (step: keyof typeof area.held) => {
  const { promise, go } = gate();
  area.held[step] = promise;
  return go;
};

type Answer = (request: Request) => Response | Promise<Response>;

const usage = { today: { used: 3, limit: 20 }, thisMonth: { used: 100, limit: 500, estimatedCostUsd: 1 } };
const json = (body: unknown, status = 200) => Response.json(body, { status });

const png = async (colour: string, width = 400, height = 300) => {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  context.fillStyle = colour;
  context.fillRect(0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/png' });
};

async function standIn(answers: Record<string, Answer> = {}) {
  const passOn = fetch;
  const photo = await png('#808080');
  const smaller = await png('#808080', 200, 150);
  const edited = await png('#20c060');
  const pictures = { readable: true, small: false, held: Promise.resolve(), asked: 0 };
  const calls: { call: string; body: unknown }[] = [];
  const make: Answer = async (request) => {
    const { fromEditId } = (await request.json()) as { fromEditId?: string };
    return json({ editId: fromEditId ? 'edit-2' : 'edit-1', imageUrl: '', usage });
  };
  const service: Record<string, Answer> = {
    'GET /extras/flags': () => new Response(null, { status: 503 }),
    'GET /extras/limits': () => json(usage),
    'POST /extras/edits': make,
    'POST /extras/edits/area': make,
    'GET /extras/edits/edit-1/image': () => new Response(edited),
    'GET /extras/edits/edit-2/image': () => new Response(edited),
    'POST /extras/edits/edit-1/alignment': () => new Response(null, { status: 204 }),
    'POST /extras/edits/edit-2/alignment': () => new Response(null, { status: 204 }),
    'POST /extras/edits/edit-1/save': () => json({ assetId: 'copy' }),
    'POST /extras/edits/edit-1/save-area': () => json({ assetId: 'copy' }),
    'DELETE /extras/edits/edit-1': () => new Response(null, { status: 204 }),
    'DELETE /extras/edits/edit-2': () => new Response(null, { status: 204 }),
    ...answers,
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (/^\/api\/assets\/[^/]+\/(thumbnail|original)$/.test(pathname)) {
      pictures.asked++;
      await pictures.held;
      if (!pictures.readable) {
        return new Response(null, { status: 404 });
      }
      return new Response(pictures.small ? smaller : photo);
    }
    if (!pathname.startsWith('/extras/')) {
      return passOn(input, init);
    }
    const call = `${request.method} ${pathname}`;
    const type = request.headers.get('content-type') ?? '';
    calls.push({ call, body: type === 'application/json' ? await request.clone().json() : type });
    const answer = service[call];
    if (!answer) {
      throw new Error(`No answer for ${call}`);
    }
    return answer(request);
  });
  const hold = () => {
    let letGo = () => {};
    pictures.held = new Promise((resolve) => (letGo = resolve));
    return letGo;
  };
  return { pictures, hold, made: (call: string) => calls.filter((made) => made.call === call) };
}

const button = (name: string) => page.getByRole('button', { name, exact: true });

async function open({ data, router }: { data: MockData; router: MockRouter }) {
  const asset = factory.asset({ ownerId: data.user.id, width: 400, height: 300, originalFileName: 'photo.jpg' });
  data.addAssets(asset);
  await router.goto(`/photos/edit/${asset.id}`, { id: asset.id });
  return asset;
}

async function typeWords() {
  await expect.poll(() => document.querySelector('canvas.cursor-crosshair')).toBeTruthy();
  await page.getByRole('textbox').fill('brighter');
}

async function makeHighlightedEdit() {
  await typeWords();
  await userEvent.click(document.querySelector('canvas.cursor-crosshair')!);
  await button('editor_ai_generate').click();
  await expect.element(button('editor_ai_edit_more')).toBeVisible();
  await expect.element(page.getByText('editor_ai_area_note')).toBeVisible();
}

test('a paste that fails at full size at Save keeps the result: used whole, it saves the whole result', async ({
  data,
  render,
  logger,
  router,
}) => {
  await open({ data, router });
  const service = await standIn();
  await render(Page, load);
  await makeHighlightedEdit();
  expect(service.made('POST /extras/edits/area')).toHaveLength(1);

  service.pictures.readable = false;
  await button('editor_save_copy').click();

  await expect.element(page.getByText('editor_ai_save_paste_failed')).toBeVisible();
  await expect.element(page.getByText('editor_ai_paste_failed')).not.toBeInTheDocument();
  await expect.element(button('editor_ai_use_whole')).toBeVisible();
  await expect.element(button('editor_ai_try_again')).toBeVisible();
  expect(service.made('POST /extras/edits/edit-1/save-area')).toEqual([]);
  expect(service.made('DELETE /extras/edits/edit-1')).toEqual([]);
  expect(logger.error).toHaveBeenCalledWith(/pasting the highlighted area at full size failed/);

  await button('editor_ai_use_whole').click();
  await expect.element(page.getByText('editor_ai_whole_note')).toBeVisible();
  await button('editor_save_copy').click();
  await expect.poll(() => router.url.pathname, { timeout: 10_000 }).toBe('/photos/copy');
  expect(service.made('POST /extras/edits/edit-1/save')).toEqual([
    { call: 'POST /extras/edits/edit-1/save', body: { whole: true } },
  ]);
  expect(service.made('POST /extras/edits/area')).toHaveLength(1);
});

test('a paste that fails at full size at Save can be tried again: saved again, no new edit', async ({
  data,
  render,
  logger,
  router,
}) => {
  await open({ data, router });
  const service = await standIn();
  await render(Page, load);
  await makeHighlightedEdit();

  service.pictures.readable = false;
  await button('editor_save_copy').click();
  await expect.element(button('editor_ai_try_again')).toBeVisible();
  expect(logger.error).toHaveBeenCalledWith(/pasting the highlighted area at full size failed/);

  service.pictures.readable = true;
  await button('editor_ai_try_again').click();
  await expect.poll(() => router.url.pathname, { timeout: 10_000 }).toBe('/photos/copy');
  expect(service.made('POST /extras/edits/edit-1/save-area')).toEqual([
    { call: 'POST /extras/edits/edit-1/save-area', body: 'image/jpeg' },
  ]);
  expect(service.made('POST /extras/edits/area')).toHaveLength(1);
  expect(service.made('DELETE /extras/edits/edit-1')).toEqual([]);
});

test('the service refusing the pasted copy is said in its words, and the result stays as it was', async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const refusal = "That isn't this photo at its full size.";
  const service = await standIn({
    'POST /extras/edits/edit-1/save-area': () => json({ error: refusal }, 400),
  });
  await render(Page, load);
  await makeHighlightedEdit();

  await button('editor_save_copy').click();
  await expect.element(page.getByText('editor_ai_failed')).toBeVisible();
  await expect.element(button('editor_ai_edit_more')).toBeVisible();
  await expect.element(page.getByText('editor_ai_save_paste_failed')).not.toBeInTheDocument();
  expect(service.made('POST /extras/edits/edit-1/save-area')).toHaveLength(1);
  expect(logger.error).toHaveBeenCalledWith(/saving the edit failed/);
});

test("an edit whose picture didn't load is kept, and loads again without a new edit", async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  let loads = 0;
  const edited = await png('#20c060');
  const service = await standIn({
    'GET /extras/edits/edit-1/image': () => (++loads === 1 ? json({ error: 'Not ready.' }, 500) : new Response(edited)),
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();

  await expect.element(page.getByText('editor_ai_load_failed')).toBeVisible();
  await expect.element(button('editor_ai_generate')).toBeDisabled();
  expect(service.made('DELETE /extras/edits/edit-1')).toEqual([]);
  expect(logger.error).toHaveBeenCalledWith(/loading the edit’s picture failed/);

  await button('editor_ai_load_again').click();
  await expect.element(button('editor_ai_edit_more')).toBeVisible();
  await expect.element(page.getByText('editor_ai_load_failed')).not.toBeInTheDocument();
  expect(service.made('POST /extras/edits')).toHaveLength(1);
  expect(service.made('DELETE /extras/edits/edit-1')).toEqual([]);
});

test("leaving with an edit whose picture didn't load discards it, as before", async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const service = await standIn({
    'GET /extras/edits/edit-1/image': () => json({ error: 'Not ready.' }, 500),
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.element(button('editor_ai_load_again')).toBeVisible();
  expect(logger.error).toHaveBeenCalledWith(/loading the edit’s picture failed/);

  cleanup();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
});

test('a photo that can only be read smaller than full size at Save keeps the result, with the note for Save', async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const service = await standIn();
  await render(Page, load);
  await makeHighlightedEdit();

  service.pictures.small = true;
  await button('editor_save_copy').click();

  await expect.element(page.getByText('editor_ai_save_paste_failed')).toBeVisible();
  await expect.element(button('editor_ai_use_whole')).toBeVisible();
  await expect.element(button('editor_ai_try_again')).toBeVisible();
  await expect.element(page.getByText('editor_ai_failed')).not.toBeInTheDocument();
  expect(service.made('POST /extras/edits/edit-1/save-area')).toEqual([]);
  expect(service.made('DELETE /extras/edits/edit-1')).toEqual([]);
  expect(logger.error).toHaveBeenCalledWith(/pasting the highlighted area at full size failed/);
});

test('while Save pastes the result, a kept Edit more try waits; a failed paste keeps both, with the error', async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const portrait = await png('#c02060', 300, 400);
  const service = await standIn({ 'GET /extras/edits/edit-2/image': () => new Response(portrait) });
  await render(Page, load);
  await makeHighlightedEdit();
  await button('editor_ai_edit_more').click();
  await typeWords();
  await userEvent.click(document.querySelector('canvas.cursor-crosshair')!);
  await button('editor_ai_edit_result').click();
  await expect.element(page.getByText('editor_ai_shape_note')).toBeVisible();
  expect(service.made('POST /extras/edits/area')).toHaveLength(2);
  expect(logger.error).toHaveBeenCalledWith(/pasting the highlighted area failed/);

  const letGo = service.hold();
  await button('editor_save_copy').click();
  await expect.element(page.getByText('editor_copy_saving')).toBeVisible();
  await expect.element(button('editor_ai_use_whole')).toBeDisabled();
  await expect.element(button('editor_ai_try_again')).toBeDisabled();

  service.pictures.readable = false;
  letGo();
  await expect.element(page.getByText('editor_ai_failed')).toBeVisible();
  await expect.element(page.getByText('editor_ai_shape_note')).toBeVisible();
  await expect.element(page.getByText('editor_ai_save_paste_failed')).not.toBeInTheDocument();
  await expect.element(button('editor_ai_use_whole')).toBeEnabled();
  await expect.element(button('editor_ai_try_again')).toBeEnabled();
  expect(service.made('POST /extras/edits/edit-1/save-area')).toEqual([]);
  expect(service.made('DELETE /extras/edits/edit-1')).toEqual([]);
  expect(service.made('DELETE /extras/edits/edit-2')).toEqual([]);
  expect(logger.error).toHaveBeenCalledWith(/pasting the highlighted area at full size failed/);

  await button('editor_ai_use_whole').click();
  await expect.element(page.getByText('editor_ai_whole_note')).toBeVisible();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
  expect(service.made('DELETE /extras/edits/edit-2')).toEqual([]);
});

test("an edit whose picture didn't load: failing to load it again has its own note, and Discard drops it", async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const service = await standIn({
    'GET /extras/edits/edit-1/image': () => json({ error: 'Not ready.' }, 500),
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.element(page.getByText('editor_ai_load_failed')).toBeVisible();
  await expect.element(page.getByText('editor_ai_failed')).not.toBeInTheDocument();
  expect(logger.error).toHaveBeenCalledWith(/loading the edit’s picture failed/);

  await button('editor_ai_load_again').click();
  await expect.element(page.getByText('editor_ai_load_failed_again')).toBeVisible();
  await expect.element(page.getByText('editor_ai_load_failed', { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText('editor_ai_failed')).not.toBeInTheDocument();
  expect(service.made('GET /extras/edits/edit-1/image')).toHaveLength(2);
  expect(logger.error).toHaveBeenCalledWith(/loading the edit’s picture failed/);
  expect(logger.error.calls.filter((line) => /loading the edit’s picture failed/.test(line))).toHaveLength(2);

  await button('editor_ai_discard').click();
  await expect.element(page.getByText('editor_ai_load_failed')).not.toBeInTheDocument();
  await expect.element(page.getByText('editor_ai_failed')).not.toBeInTheDocument();
  await expect.element(page.getByRole('textbox')).toBeEnabled();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
  expect(service.made('POST /extras/edits')).toHaveLength(1);
});

test('an edit that arrives after the page was left is discarded', async ({ data, router, render }) => {
  await open({ data, router });
  const edited = await png('#20c060');
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const service = await standIn({
    'GET /extras/edits/edit-1/image': async () => {
      await arrived;
      return new Response(edited);
    },
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.poll(() => service.made('GET /extras/edits/edit-1/image')).toHaveLength(1);

  cleanup();
  arrive();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
});

test('an edit whose picture fails to load after the page was left is discarded, not kept', async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const failing = gate();
  const service = await standIn({
    'GET /extras/edits/edit-1/image': async () => {
      await failing.promise;
      return json({ error: 'Not ready.' }, 500);
    },
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.poll(() => service.made('GET /extras/edits/edit-1/image')).toHaveLength(1);

  cleanup();
  failing.go();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
  expect(logger.error).toHaveBeenCalledWith(/loading the edit’s picture failed/);
});

test('a highlighted edit whose area is refused after the page was left is discarded, not kept', async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const portrait = await png('#c02060', 300, 400);
  const service = await standIn({ 'GET /extras/edits/edit-1/image': () => new Response(portrait) });
  await render(Page, load);
  await typeWords();
  await userEvent.click(document.querySelector('canvas.cursor-crosshair')!);
  const letGo = holdArea('align');
  await button('editor_ai_generate').click();
  await expect.poll(() => area.reached.align).toBe(1);

  cleanup();
  letGo();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
  expect(logger.error).toHaveBeenCalledWith(/pasting the highlighted area failed/);
});

test('a highlighted edit whose area is pasted after the page was left is discarded', async ({
  data,
  router,
  render,
}) => {
  await open({ data, router });
  const service = await standIn();
  await render(Page, load);
  await typeWords();
  await userEvent.click(document.querySelector('canvas.cursor-crosshair')!);
  const letGo = holdArea('pasted');
  await button('editor_ai_generate').click();
  await expect.poll(() => area.reached.pasted).toBe(1);

  cleanup();
  letGo();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
});

test('leaving while the full-size photo is still being read sends no edit, so nothing is paid for', async ({
  data,
  router,
  render,
}) => {
  await open({ data, router });
  const service = await standIn();
  await render(Page, load);
  await typeWords();
  await userEvent.click(document.querySelector('canvas.cursor-crosshair')!);

  const letGo = service.hold();
  const asked = service.pictures.asked;
  await button('editor_ai_generate').click();
  await expect.poll(() => service.pictures.asked).toBeGreaterThan(asked);
  cleanup();
  letGo();

  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(service.made('POST /extras/edits/area')).toEqual([]);
});

test('an edit made after the page was left is discarded without downloading its picture', async ({
  data,
  router,
  render,
}) => {
  await open({ data, router });
  const answering = gate();
  const service = await standIn({
    'POST /extras/edits': async () => {
      await answering.promise;
      return json({ editId: 'edit-1', imageUrl: '', usage });
    },
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.poll(() => service.made('POST /extras/edits')).toHaveLength(1);

  cleanup();
  answering.go();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
  expect(service.made('GET /extras/edits/edit-1/image')).toEqual([]);
});

test('leaving while an edit is being made asks first; once left, the edit that arrives is discarded', async ({
  data,
  router,
  render,
}) => {
  const asset = await open({ data, router });
  const edited = await png('#20c060');
  const arriving = gate();
  const service = await standIn({
    'GET /extras/edits/edit-1/image': async () => {
      await arriving.promise;
      return new Response(edited);
    },
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.poll(() => service.made('GET /extras/edits/edit-1/image')).toHaveLength(1);

  await button('close').click();
  const question = page.getByText('editor_discard_edits_title');
  await expect.element(question).toBeVisible();
  await button('cancel').click();
  await expect.element(question).not.toBeInTheDocument();
  expect(router.url.pathname).toBe(`/photos/edit/${asset.id}`);

  await button('close').click();
  await button('editor_discard_edits_confirm').click();
  await expect.poll(() => router.url.pathname).toBe(`/photos/${asset.id}`);
  cleanup();
  arriving.go();
  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
});

test('leaving by the browser’s Back while Save pastes the result: the paste failing then discards it', async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const service = await standIn();
  await render(Page, load);
  await makeHighlightedEdit();

  const letGo = service.hold();
  await button('editor_save_copy').click();
  await expect.element(page.getByText('editor_copy_saving')).toBeVisible();
  cleanup();
  service.pictures.readable = false;
  letGo();

  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
  expect(service.made('POST /extras/edits/edit-1/save-area')).toEqual([]);
  expect(logger.error).toHaveBeenCalledWith(/pasting the highlighted area at full size failed/);
});

test('leaving by the browser’s Back while Save sends the result: saving failing then discards it', async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const answering = gate();
  const service = await standIn({
    'POST /extras/edits/edit-1/save': async () => {
      await answering.promise;
      return json({ error: 'Saving failed.' }, 500);
    },
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.element(button('editor_ai_edit_more')).toBeVisible();

  await button('editor_save_copy').click();
  await expect.poll(() => service.made('POST /extras/edits/edit-1/save')).toHaveLength(1);
  cleanup();
  answering.go();

  await expect.poll(() => service.made('DELETE /extras/edits/edit-1')).toHaveLength(1);
  expect(logger.error).toHaveBeenCalledWith(/saving the edit failed/);
});

test("while Save runs, an Edit more whose picture didn't load waits: Load again and Discard are off", async ({
  data,
  router,
  render,
  logger,
}) => {
  await open({ data, router });
  const answering = gate();
  const service = await standIn({
    'GET /extras/edits/edit-2/image': () => json({ error: 'Not ready.' }, 500),
    'POST /extras/edits/edit-1/save': async () => {
      await answering.promise;
      return json({ assetId: 'copy' });
    },
  });
  await render(Page, load);
  await typeWords();
  await button('editor_ai_generate').click();
  await expect.element(button('editor_ai_edit_more')).toBeVisible();
  await button('editor_ai_edit_more').click();
  await typeWords();
  await button('editor_ai_edit_result').click();
  await expect.element(button('editor_ai_load_again')).toBeVisible();
  expect(logger.error).toHaveBeenCalledWith(/loading the edit’s picture failed/);

  await button('editor_save_copy').click();
  await expect.element(page.getByText('editor_copy_saving')).toBeVisible();
  await expect.element(button('editor_ai_load_again')).toBeDisabled();
  await expect.element(button('editor_ai_discard')).toBeDisabled();

  answering.go();
  await expect.poll(() => router.url.pathname, { timeout: 10_000 }).toBe('/photos/copy');
  expect(service.made('GET /extras/edits/edit-2/image')).toHaveLength(1);
});
