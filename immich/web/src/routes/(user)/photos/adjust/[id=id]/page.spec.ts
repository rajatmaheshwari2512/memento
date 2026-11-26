import { autoAdjust } from '#lib/ai-edit/adjust/adjust-auto.ts';
import { outputSize, photoCorners, type Quad } from '#lib/ai-edit/adjust/adjust-geometry.ts';
import type { MockData } from '#test/common/data.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import type { Mock } from '#test/unit/mocks/mock.ts';
import type { MockRouter } from '#test/unit/mocks/router.ts';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import { load } from './+page.ts';

vi.mock('#lib/ai-edit/adjust/save-copy.ts', () => ({
  saveCopy: async (save: () => Promise<{ assetId: string }>) => {
    const { assetId } = await save();
    return assetId;
  },
}));

const PHOTO = { width: 400, height: 300 };

const photo = () => {
  const canvas = new OffscreenCanvas(PHOTO.width, PHOTO.height);
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, PHOTO.width, PHOTO.height);
  gradient.addColorStop(0, '#2a3038');
  gradient.addColorStop(1, '#7a8088');
  context.fillStyle = gradient;
  context.fillRect(0, 0, PHOTO.width, PHOTO.height);
  return canvas.convertToBlob({ type: 'image/png' });
};

async function standIn() {
  const passOn = fetch;
  const picture = await photo();
  const saved: Blob[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (/^\/api\/assets\/[^/]+\/(thumbnail|original)$/.test(pathname)) {
      return new Response(picture);
    }
    if (pathname === '/extras/flags') {
      return new Response(null, { status: 503 });
    }
    if (/^\/extras\/adjust\/[^/]+\/save$/.test(pathname) && request.method === 'POST') {
      saved.push(await request.blob());
      return Response.json({ assetId: 'copy' });
    }
    if (pathname.startsWith('/extras/')) {
      throw new Error(`No answer for ${request.method} ${pathname}`);
    }
    return passOn(input, init);
  });
  return { picture, saved };
}

async function open(
  { data, router, render }: { data: MockData; router: MockRouter; render: Mock['render'] },
  tab: string,
) {
  const asset = factory.asset({ ownerId: data.user.id, ...PHOTO, originalFileName: 'photo.jpg' });
  data.addAssets(asset);
  await router.goto(`/photos/adjust/${asset.id}?tab=${tab}`, { id: asset.id });
  const pictures = await standIn();
  await render(Page, load);
  await expect.poll(() => document.querySelector('[role="img"][aria-label="photo.jpg"] canvas')).toBeTruthy();
  const space = document.querySelector('[role="img"][aria-label="photo.jpg"]')!.parentElement!;
  space.style.cssText = 'display: flex; align-items: center; justify-content: center; width: 800px; height: 600px';
  return pictures;
}

const slider = (label: string) => page.getByRole('slider', { name: label, exact: true });
const corners = () => page.getByRole('button', { name: 'editor_handle_corner' });

const nudge = (index: number, key: string) => {
  for (let i = 0; i < 4; i++) {
    corners()
      .nth(index)
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }));
  }
};

const pulledIn = (): Quad => {
  const quad = photoCorners();
  for (let i = 0; i < 4; i++) {
    quad[0] = [quad[0][0] + 0.02, quad[0][1]];
    quad[1] = [quad[1][0] - 0.02, quad[1][1]];
  }
  return quad;
};

const shownShape = () => {
  const { width, height } = document.querySelector('[role="img"][aria-label="photo.jpg"]')!.getBoundingClientRect();
  return width / height;
};

test('Auto sets the light and colour sliders from the photo, and leaves the others', async ({
  data,
  router,
  render,
}) => {
  const { picture } = await open({ data, router, render }, 'adjust');
  const tint = slider('editor_tint').element() as HTMLInputElement;
  tint.value = '30';
  tint.dispatchEvent(new Event('input', { bubbles: true }));
  await expect.element(slider('editor_tint')).toHaveValue('30');

  const image = await createImageBitmap(picture, { premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  const { data: pixels } = canvas.getContext('2d')!.getImageData(0, 0, image.width, image.height);
  const expected = autoAdjust(pixels, image.width, image.height);
  expect(expected.exposure).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'editor_auto' }).click();
  for (const [key, value] of Object.entries(expected)) {
    await expect.element(slider(`editor_${key}`)).toHaveValue(String(Math.round(value * 100)));
  }
  await expect.element(slider('editor_tint')).toHaveValue('30');
  await expect.element(slider('editor_vignette')).toHaveValue('0');
  await expect.element(page.getByRole('button', { name: 'editor_save_copy' })).toBeEnabled();
});

test("Straighten's modes: Perspective swaps the angle for the corners, and back in Straighten the box takes the crop's shape", async ({
  data,
  router,
  render,
}) => {
  await open({ data, router, render }, 'straighten');
  await expect.element(slider('editor_straighten')).toBeVisible();
  expect(corners().elements()).toHaveLength(0);
  await expect.poll(() => shownShape()).toBeCloseTo(4 / 3, 2);

  await page.getByRole('radio', { name: 'editor_perspective' }).click();
  await expect.element(corners().first()).toBeVisible();
  expect(corners().elements()).toHaveLength(4);
  await expect.element(slider('editor_straighten')).not.toBeInTheDocument();
  nudge(0, 'ArrowRight');
  nudge(1, 'ArrowLeft');
  expect(shownShape()).toBeCloseTo(4 / 3, 2);

  await page.getByRole('radio', { name: 'editor_straighten' }).click();
  await expect.element(slider('editor_straighten')).toBeVisible();
  expect(corners().elements()).toHaveLength(0);
  const crop = outputSize(0, PHOTO, pulledIn());
  await expect.poll(() => shownShape()).toBeCloseTo(crop.width / crop.height, 1);
  expect(crop.width / crop.height).toBeLessThan(1.25);
});

test('Save makes the copy with perspective, at the size its crop gives', async ({ data, router, render }) => {
  const { saved } = await open({ data, router, render }, 'straighten');
  await page.getByRole('radio', { name: 'editor_perspective' }).click();
  await expect.element(corners().first()).toBeVisible();
  nudge(0, 'ArrowRight');
  nudge(1, 'ArrowLeft');

  await page.getByRole('button', { name: 'editor_save_copy' }).click();
  await expect.poll(() => router.url.pathname, { timeout: 10_000 }).toBe('/photos/copy');
  expect(saved).toHaveLength(1);
  expect(saved[0].type).toBe('image/jpeg');
  const copy = await createImageBitmap(saved[0]);
  expect({ width: copy.width, height: copy.height }).toEqual(outputSize(0, PHOTO, pulledIn()));
  expect(copy.width / copy.height).not.toBeCloseTo(4 / 3, 1);
});
