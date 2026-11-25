import MarkupLayer from '#lib/ai-edit/adjust/MarkupLayer.svelte';
import { MarkupEditor } from '#lib/ai-edit/adjust/markup-editor.svelte.ts';
import type { MarkupLine, MarkupText } from '#lib/ai-edit/adjust/markup.ts';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';

// The layer on a 400×300 photo box, on the Markup tab; `finger(type, id, x, y)` sends a finger's
// event (`id`) at x, y on the box, to the layer or to `on`.
async function renderLayer(editor: MarkupEditor) {
  const box = document.createElement('div');
  box.style.cssText = 'position: relative; width: 400px; height: 300px';
  document.body.append(box);
  const { rerender } = await render(MarkupLayer, { target: box, props: { editor, active: true, hidden: false } });
  const canvas = box.querySelector('canvas')!;
  // The tests run without the app's styles: the layer fills the box as its classes say.
  canvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%';
  // Only a real finger can be captured.
  const capture = vi.spyOn(canvas, 'setPointerCapture').mockImplementation(() => {});
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await tick();
  const { left, top } = canvas.getBoundingClientRect();
  const finger = (type: string, id: number, x: number, y: number, on: Element = canvas) =>
    on.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        pointerType: 'touch',
        isPrimary: id === 1,
        clientX: left + x,
        clientY: top + y,
        bubbles: true,
        cancelable: true,
      }),
    );
  return { finger, box, capture, rerender };
}

const line = (points: [number, number][]): MarkupLine => ({ kind: 'pen', colour: '#000000', width: 0.01, points });

describe('MarkupLayer', () => {
  it('draws with the first finger only: a second one adds nothing to the line', async () => {
    const editor = new MarkupEditor();
    const { finger } = await renderLayer(editor);
    finger('pointerdown', 1, 100, 150);
    finger('pointermove', 1, 120, 150);
    finger('pointerdown', 2, 300, 60);
    finger('pointermove', 2, 310, 70);
    finger('pointermove', 1, 140, 150);
    finger('pointerup', 2, 310, 70);
    // The browser lets go of a finger after it lifts: only that finger's.
    finger('lostpointercapture', 2, 310, 70);
    finger('pointermove', 1, 160, 150);
    finger('pointerup', 1, 160, 150);
    expect(editor.items).toHaveLength(1);
    const drawn = editor.items[0] as MarkupLine;
    expect(drawn.points.map(([x, y]) => [Math.round(x * 400), Math.round(y * 300)])).toEqual([
      [100, 150],
      [120, 150],
      [140, 150],
      [160, 150],
    ]);
  });

  it('ends the line when Undo (another finger) takes it away, leaving the line before it as it was', async () => {
    const editor = new MarkupEditor();
    const before = line([
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    editor.commit([before]);
    const { finger } = await renderLayer(editor);
    finger('pointerdown', 1, 200, 150);
    expect(editor.items).toHaveLength(2);
    editor.undo();
    finger('pointermove', 1, 220, 160);
    finger('pointermove', 1, 240, 170);
    finger('pointerup', 1, 240, 170);
    expect(editor.items).toHaveLength(1);
    expect(editor.items[0]).toBe(before);
  });

  it('ends a shape the same way after Clear', async () => {
    const editor = new MarkupEditor();
    editor.tool = 'shapes';
    const { finger } = await renderLayer(editor);
    finger('pointerdown', 1, 100, 100);
    finger('pointermove', 1, 150, 150);
    expect(editor.items).toHaveLength(1);
    editor.clear();
    finger('pointermove', 1, 200, 200);
    finger('pointerup', 1, 200, 200);
    expect(editor.items).toEqual([]);
  });

  it('pinches the text being edited with two fingers, also from outside it; lifting one then does nothing', async () => {
    const editor = new MarkupEditor();
    editor.setTool('text');
    editor.addText([0.5, 0.5]);
    editor.setText('Hi');
    const before = editor.selectedText!;
    const { finger } = await renderLayer(editor);
    // Both fingers well outside the text, either side of it.
    finger('pointerdown', 1, 40, 150);
    finger('pointerdown', 2, 360, 150);
    finger('pointermove', 1, 20, 150);
    finger('pointermove', 2, 380, 150);
    finger('pointerup', 2, 380, 150);
    const pinched = editor.selectedText!;
    expect(pinched.fontSize).toBeCloseTo((before.fontSize * 360) / 320);
    expect(pinched.at).toEqual(before.at);
    finger('pointermove', 1, 100, 250);
    finger('pointerup', 1, 100, 250);
    expect(editor.selectedText).toBe(pinched);
    editor.undo();
    expect(editor.selectedText).toBeNull();
    expect((editor.items[0] as MarkupText).fontSize).toBe(before.fontSize);
  });

  it('stops editing a text when a press off it ends, not when it starts', async () => {
    const editor = new MarkupEditor();
    editor.setTool('text');
    editor.addText([0.5, 0.5]);
    editor.setText('Hi');
    const { finger } = await renderLayer(editor);
    finger('pointerdown', 1, 40, 40);
    expect(editor.selected).toBe(0);
    finger('pointerup', 1, 40, 40);
    expect(editor.selected).toBeNull();
  });

  it('moves a text with one finger, as one undoable step', async () => {
    const editor = new MarkupEditor();
    editor.setTool('text');
    editor.addText([0.5, 0.5]);
    editor.setText('Hi');
    const { finger } = await renderLayer(editor);
    finger('pointerdown', 1, 200, 150);
    finger('pointermove', 1, 220, 150);
    finger('pointermove', 1, 240, 180);
    finger('pointerup', 1, 240, 180);
    const [x, y] = editor.selectedText!.at;
    expect([x, y].map((value) => value.toFixed(6))).toEqual(['0.600000', '0.600000']);
    editor.undo();
    expect((editor.items[0] as MarkupText).at).toEqual([0.5, 0.5]);
  });

  it("resizes a text by its corner handle, by the finger's distance from its middle, as one undoable step", async () => {
    const editor = new MarkupEditor();
    editor.setTool('text');
    editor.addText([0.5, 0.5]);
    editor.setText('Hi');
    const before = editor.selectedText!;
    const { finger, box, capture } = await renderLayer(editor);
    // The handle shows once the font is ready.
    await expect.poll(() => box.querySelector('.cursor-nwse-resize')).toBeTruthy();
    const handle = box.querySelector('.cursor-nwse-resize')!;
    // The text's middle is at 200, 150: the finger goes from 40, 20 off it to twice as far.
    finger('pointerdown', 1, 240, 170, handle);
    expect(capture).toHaveBeenCalledWith(1); // the layer takes the finger's moves
    finger('pointermove', 1, 260, 180);
    finger('pointermove', 1, 280, 190);
    finger('pointerup', 1, 280, 190);
    const resized = editor.selectedText!;
    expect(resized.fontSize).toBeCloseTo(before.fontSize * 2);
    expect(resized.at).toEqual(before.at);
    expect(editor.items).toHaveLength(1);
    editor.undo();
    expect((editor.items[0] as MarkupText).fontSize).toBe(before.fontSize);
  });

  it('stops a stroke when the tab is left or Save starts mid-stroke: it stays, and the pen draws anew after', async () => {
    const editor = new MarkupEditor();
    const { finger, rerender } = await renderLayer(editor);
    finger('pointerdown', 1, 100, 100);
    finger('pointermove', 1, 150, 100);
    await rerender({ active: false });
    // The finger, still captured, goes on moving: the line doesn't grow.
    finger('pointermove', 1, 200, 100);
    finger('pointermove', 1, 250, 100);
    await rerender({ active: true });
    finger('pointermove', 1, 300, 100);
    finger('pointerup', 1, 300, 100);
    expect(editor.items).toHaveLength(1);
    expect((editor.items[0] as MarkupLine).points).toHaveLength(2);

    finger('pointerdown', 2, 100, 200);
    finger('pointermove', 2, 150, 200);
    finger('pointerup', 2, 150, 200);
    expect(editor.items).toHaveLength(2);
    expect((editor.items[1] as MarkupLine).points).toHaveLength(2);
  });

  it('draws again after the layer loses a finger whose lift never comes', async () => {
    const editor = new MarkupEditor();
    const { finger } = await renderLayer(editor);
    finger('pointerdown', 1, 100, 100);
    finger('pointermove', 1, 150, 100);
    finger('lostpointercapture', 1, 150, 100);
    // Not taken for a second finger: a line of its own.
    finger('pointerdown', 2, 100, 200);
    finger('pointermove', 2, 150, 200);
    finger('pointerup', 2, 150, 200);
    expect(editor.items).toHaveLength(2);
    expect((editor.items[0] as MarkupLine).points).toHaveLength(2);
    expect((editor.items[1] as MarkupLine).points).toHaveLength(2);
  });
});
