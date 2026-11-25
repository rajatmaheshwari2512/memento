import AiPhoto from '#lib/ai-edit/ai/AiPhoto.svelte';
import type { Stroke } from '#lib/ai-edit/ai/ai-area.ts';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';

describe('AiPhoto', () => {
  it("brushes a stroke along a finger's path, from where it pressed; the mouse's other buttons don't brush", async () => {
    const box = document.createElement('div');
    box.style.cssText = 'width: 400px; height: 300px';
    document.body.append(box);
    let strokes: Stroke[] = [];
    await render(AiPhoto, {
      target: box,
      props: {
        src: '',
        width: 400,
        height: 300,
        get strokes() {
          return strokes;
        },
        set strokes(value) {
          strokes = value;
        },
        brushRadius: 0.05,
        brushing: true,
        working: false,
        alt: '',
      },
    });
    const canvas = box.querySelector('canvas')!;
    // The tests run without the app's styles: the brush's layer over the photo, 400×300.
    canvas.style.cssText = 'position: absolute; left: 0; top: 0; width: 400px; height: 300px';
    // Only a real finger can be captured.
    const capture = vi.spyOn(canvas, 'setPointerCapture').mockImplementation(() => {});
    await tick();
    const { left, top } = canvas.getBoundingClientRect();
    const send = (type: string, x: number, y: number, button = 0) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: button === 0 ? 'touch' : 'mouse',
          button,
          clientX: left + x,
          clientY: top + y,
          bubbles: true,
        }),
      );

    send('pointerdown', 100, 150);
    expect(capture).toHaveBeenCalledWith(1);
    send('pointermove', 200, 150);
    send('pointermove', 300, 225);
    send('pointerup', 300, 225);
    // Moves after the finger lifted brush nothing.
    send('pointermove', 350, 50);
    expect(strokes).toEqual([
      {
        points: [
          [0.25, 0.5],
          [0.5, 0.5],
          [0.75, 0.75],
        ],
        radius: 0.05,
      },
    ]);

    send('pointerdown', 50, 50, 2);
    send('pointermove', 100, 50);
    send('pointerup', 100, 50);
    expect(strokes).toHaveLength(1);
  });
});
