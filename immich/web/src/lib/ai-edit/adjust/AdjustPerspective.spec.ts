import AdjustPerspective from '#lib/ai-edit/adjust/AdjustPerspective.svelte';
import type { Quad } from '#lib/ai-edit/adjust/adjust-geometry.ts';
import { render } from 'vitest-browser-svelte';

async function renderCorners(corners: Quad | null) {
  const onChange = vi.fn<(corners: Quad) => void>();
  const box = document.createElement('div');
  box.style.cssText = 'position: relative; width: 400px; height: 300px';
  document.body.append(box);
  const { baseElement } = await render(AdjustPerspective, {
    target: box,
    props: { corners, disabled: false, onChange },
  });
  const handles = [...baseElement.querySelectorAll<HTMLButtonElement>('button')];
  handles[0].parentElement!.style.cssText = 'position: absolute; inset: 0';
  return { onChange, handles };
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true });

describe('AdjustPerspective', () => {
  it('refuses corners brought too close together, with the hint, which goes a moment later', async () => {
    vi.useFakeTimers();
    try {
      const corners: Quad = [
        [0.45, 0.45],
        [0.55, 0.45],
        [0.55, 0.55],
        [0.45, 0.55],
      ];
      const { onChange, handles } = await renderCorners(corners);
      const hint = handles[0].parentElement!.querySelector('[role="status"]')!;
      handles[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(onChange).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(hint.textContent!.trim()).toBe('editor_perspective_too_small'));
      await vi.advanceTimersByTimeAsync(3000);
      expect(hint.textContent!.trim()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts at the photo's corners, one handle each", async () => {
    const { handles } = await renderCorners(null);
    expect(handles).toHaveLength(4);
    expect(handles.map((handle) => [handle.style.left, handle.style.top])).toEqual([
      ['0%', '0%'],
      ['100%', '0%'],
      ['100%', '100%'],
      ['0%', '100%'],
    ]);
  });

  it('moves a dragged corner with the pointer, kept inside the photo', async () => {
    const { onChange, handles } = await renderCorners(null);
    const box = handles[0].parentElement!.getBoundingClientRect();
    handles[0].dispatchEvent(pointer('pointerdown', box.left, box.top));
    handles[0].dispatchEvent(pointer('pointermove', box.left + 80, box.top + 30));
    expect(onChange).toHaveBeenLastCalledWith([
      [0.2, 0.1],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    handles[0].dispatchEvent(pointer('pointermove', box.left - 50, box.top - 50));
    expect(onChange.mock.lastCall![0][0]).toEqual([0, 0]);
  });

  it('refuses a move that would cross the corners over, with a hint, and moves one with the arrow keys', async () => {
    const corners: Quad = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const { onChange, handles } = await renderCorners(corners);
    const box = handles[0].parentElement!.getBoundingClientRect();
    handles[0].dispatchEvent(pointer('pointerdown', box.left, box.top));
    const hint = handles[0].parentElement!.querySelector('[role="status"]')!;
    expect(hint.textContent!.trim()).toBe('');
    handles[0].dispatchEvent(pointer('pointermove', box.right, box.bottom));
    expect(onChange).not.toHaveBeenCalled();
    await expect.poll(() => hint.textContent!.trim()).toBe('editor_perspective_too_small');
    handles[0].dispatchEvent(pointer('pointerup', box.right, box.bottom));

    handles[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith([
      [0, 0],
      [0.995, 0],
      [1, 1],
      [0, 1],
    ]);
  });
});
