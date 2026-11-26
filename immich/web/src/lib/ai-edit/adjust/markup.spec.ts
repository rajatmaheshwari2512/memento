import en from '#i18n/en.json';
import { renderImage } from '#lib/ai-edit/adjust/adjust-export.ts';
import { initialState } from '#lib/ai-edit/adjust/adjust-params.ts';
import { MarkupEditor } from '#lib/ai-edit/adjust/markup-editor.svelte.ts';
import parity from '#lib/ai-edit/adjust/markup-parity.json';
import {
  HIGHLIGHTER,
  MARKUP_COLOURS,
  MARKUP_SIZES,
  MarkupHistory,
  TEXT,
  arrowGeometry,
  markupFontReady,
  textBox,
  toPixels,
  type MarkupItem,
  type MarkupPoint,
} from '#lib/ai-edit/adjust/markup.ts';
import fontUrl from '#lib/assets/fonts/GoogleSans/GoogleSans.ttf?url';

const translations: Record<string, unknown> = en;
const size = (photo: number[]) => ({ width: photo[0], height: photo[1] });

describe('the markup settings, as the Android app works them out (markup-parity.json)', () => {
  it('gives each size the same line, highlighter and text sizes', () => {
    for (const { photo, size: index, pen, highlighter, text, textOutline } of parity.widths) {
      const { width, text: fontSize } = MARKUP_SIZES[index];
      expect(toPixels(width, size(photo))).toBeCloseTo(pen, 3);
      expect(toPixels(width * HIGHLIGHTER.widthScale, size(photo))).toBeCloseTo(highlighter, 3);
      expect(toPixels(fontSize, size(photo))).toBeCloseTo(text, 3);
      expect(toPixels(fontSize, size(photo)) * TEXT.outline).toBeCloseTo(textOutline, 3);
    }
  });

  it('gives arrows the same line end and head', () => {
    for (const arrow of parity.arrows) {
      const [width, height] = arrow.photo;
      const geometry = arrowGeometry(
        [arrow.from[0] * width, arrow.from[1] * height],
        [arrow.to[0] * width, arrow.to[1] * height],
        toPixels(MARKUP_SIZES[arrow.size].width, size(arrow.photo)),
      );
      for (const [actual, expected] of [
        [geometry.lineEnd, arrow.lineEnd],
        ...geometry.head.map((corner, i) => [corner, arrow.head[i]]),
      ]) {
        expect(actual[0]).toBeCloseTo(expected[0], 3);
        expect(actual[1]).toBeCloseTo(expected[1], 3);
      }
    }
  });

  it('gives a text the same box, centred on its place, in GoogleSans Bold', async () => {
    document.fonts.add(await new FontFace('GoogleSans', `url(${fontUrl})`, { weight: '100 900' }).load());
    await markupFontReady();
    const context = new OffscreenCanvas(1, 1).getContext('2d')!;
    for (const { photo, at, size: index, text, box: expected } of parity.texts) {
      const fontSize = MARKUP_SIZES[index].text;
      const box = textBox(
        context,
        { kind: 'text', colour: '#ffffff', fontSize, at: at as MarkupPoint, text },
        size(photo),
      );
      expect(Math.abs(box.width - expected.width), text).toBeLessThanOrEqual(0.1);
      expect(Math.abs(box.x - expected.x), text).toBeLessThanOrEqual(0.1);
      expect(Math.abs(box.height - expected.height), text).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y - expected.y), text).toBeLessThanOrEqual(0.5);
    }
  });

  it('has 6 to 8 colours, black and white among them, each with an outline', () => {
    const fills = MARKUP_COLOURS.map(({ fill }) => fill);
    expect(fills.length).toBeGreaterThanOrEqual(6);
    expect(fills.length).toBeLessThanOrEqual(8);
    expect(fills).toContain('#000000');
    expect(fills).toContain('#ffffff');
    expect(new Set(fills).size).toBe(fills.length);
    for (const { fill, outline } of MARKUP_COLOURS) {
      expect(fill).toMatch(/^#[\da-f]{6}$/);
      expect(outline).toMatch(/^#[\da-f]{6}$/);
    }
  });
});

const pen = (x: number): MarkupItem => ({ kind: 'pen', colour: '#000000', width: 0.01, points: [[x, x]] });

describe('MarkupHistory', () => {
  it('undoes and redoes each change, and a new change ends the redo', () => {
    const a = pen(0.1);
    const b = pen(0.2);
    let history = new MarkupHistory().commit([a]).commit([a, b]);
    history = history.undo();
    expect(history.items).toEqual([a]);
    history = history.redo();
    expect(history.items).toEqual([a, b]);
    history = history.undo().undo();
    expect(history.items).toEqual([]);
    expect(history.undo().items).toEqual([]);
    history = history.redo().commit([a, pen(0.3)]);
    expect(history.future).toEqual([]);
    expect(history.redo().items).toHaveLength(2);
  });

  it('keeps more of the last change with it, and forgets a change that came to nothing', () => {
    const a = pen(0.1);
    const grown = { ...pen(0.1), points: [[0.1, 0.1] as [number, number], [0.2, 0.2] as [number, number]] };
    let history = new MarkupHistory().commit([a]).amend([grown]);
    expect(history.past).toHaveLength(1);
    expect(history.undo().items).toEqual([]);
    history = history.commit([grown, pen(0.5)]).amend([grown]);
    expect(history.past).toHaveLength(1);
  });
});

describe('MarkupEditor', () => {
  it('drops a text left empty, with no undo step for it', () => {
    const editor = new MarkupEditor();
    editor.addText([0.5, 0.5]);
    expect(editor.items).toHaveLength(1);
    expect(editor.isEmpty).toBe(true);
    editor.setText('Hi');
    expect(editor.isEmpty).toBe(false);
    editor.setText(' ');
    editor.select(null);
    expect(editor.items).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  it('undoes typing, a move and a new colour each as one step', () => {
    const editor = new MarkupEditor();
    editor.addText([0.5, 0.5]);
    editor.setText('H');
    editor.setText('Hi');
    const typed = editor.selectedText!;
    editor.update(0, { ...typed, at: [0.2, 0.3] }, true);
    editor.setColour(MARKUP_COLOURS[6].fill);
    expect(editor.selectedText).toMatchObject({ text: 'Hi', at: [0.2, 0.3], colour: '#ffffff' });
    editor.undo();
    expect(editor.items[0]).toMatchObject({ text: 'Hi', at: [0.2, 0.3], colour: MARKUP_COLOURS[0].fill });
    editor.undo();
    expect(editor.items[0]).toMatchObject({ text: 'Hi', at: [0.5, 0.5] });
    editor.undo();
    expect(editor.items).toEqual([]);
    editor.redo();
    expect(editor.items[0]).toMatchObject({ text: 'Hi' });
  });

  it('undoes only a text placed but not typed, not the drawing before it', () => {
    const editor = new MarkupEditor();
    editor.commit([pen(0.1)]);
    editor.addText([0.5, 0.5]);
    editor.undo();
    expect(editor.items).toEqual([pen(0.1)]);
    expect(editor.canUndo).toBe(true);
  });

  it('keeps moving or resizing a text before anything is typed in the step that placed it', () => {
    const editor = new MarkupEditor();
    editor.commit([pen(0.1)]);
    editor.addText([0.5, 0.5]);
    editor.moveText(1, editor.selectedText!, [0.2, 0.2], true);
    editor.resizeText(1, editor.selectedText!, 0.1, true);
    expect(editor.selectedText).toMatchObject({ at: [0.2, 0.2], fontSize: 0.1 });
    editor.select(null);
    expect(editor.items).toEqual([pen(0.1)]);
    editor.undo();
    expect(editor.items).toEqual([]);
    expect(editor.canUndo).toBe(false);
  });

  it('keeps a text within its size limits, and clears in one undoable step', () => {
    const editor = new MarkupEditor();
    editor.addText([0.5, 0.5]);
    editor.setText('Big');
    editor.resizeText(0, editor.selectedText!, 5, true);
    expect(editor.selectedText!.fontSize).toBe(TEXT.maxSize);
    editor.resizeText(0, editor.selectedText!, 0, true);
    expect(editor.selectedText!.fontSize).toBe(TEXT.minSize);
    editor.clear();
    expect(editor.isEmpty).toBe(true);
    editor.undo();
    expect(editor.items).toHaveLength(1);
    editor.reset();
    expect(editor.isEmpty && !editor.canUndo && !editor.canRedo).toBe(true);
  });
});

describe('the saved copy', () => {
  async function save(items: MarkupItem[]) {
    const data = new Uint8ClampedArray(200 * 100 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data.set([128, 128, 128, 255], i);
    }
    const image = await createImageBitmap(new ImageData(data, 200, 100), { premultiplyAlpha: 'none' });
    const { blob } = await renderImage(image, initialState(), 'image/png', undefined, 64, items);
    const decoded = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(200, 100);
    const context = canvas.getContext('2d')!;
    context.drawImage(decoded, 0, 0);
    return (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
  }

  it('has the markup drawn on it at full size, the rest untouched', async () => {
    const at = await save([
      {
        kind: 'pen',
        colour: '#e53935',
        width: 0.02,
        points: [
          [0.1, 0.5],
          [0.5, 0.5],
        ],
      },
      {
        kind: 'highlighter',
        colour: '#ffffff',
        width: 0.08,
        points: [
          [0.6, 0.2],
          [0.9, 0.2],
        ],
      },
      { kind: 'box', colour: '#000000', width: 0.02, from: [0.6, 0.6], to: [0.9, 0.9] },
    ]);
    expect(at(60, 50)).toEqual([229, 57, 53, 255]);
    const [r] = at(150, 20);
    expect(r).toBeCloseTo(128 + (255 - 128) * HIGHLIGHTER.opacity, -1);
    expect(at(120, 60)).toEqual([0, 0, 0, 255]);
    expect(at(150, 75)).toEqual([128, 128, 128, 255]);
    expect(at(10, 10)).toEqual([128, 128, 128, 255]);
  });

  it('has the text drawn with its outline', async () => {
    const at = await save([{ kind: 'text', colour: '#ffffff', fontSize: 0.2, at: [0.5, 0.5], text: 'MMM' }]);
    let white = 0;
    let dark = 0;
    for (let x = 60; x < 140; x++) {
      const [r] = at(x, 50);
      white += r > 240 ? 1 : 0;
      dark += r < 40 ? 1 : 0;
    }
    expect(white).toBeGreaterThan(5);
    expect(dark).toBeGreaterThan(2);
  });
});

describe('the Markup texts', () => {
  it('are in the language file we ship (en)', () => {
    for (const key of [
      'editor_markup',
      'editor_markup_pen',
      'editor_markup_highlighter',
      'editor_markup_text',
      'editor_markup_shapes',
      'editor_markup_arrow',
      'editor_markup_box',
      'editor_markup_circle',
      'editor_markup_redo',
      'editor_markup_draw_description',
      'editor_markup_text_description',
      'editor_markup_text_placeholder',
      'color',
      'size',
      'undo',
      'clear',
      'delete',
    ]) {
      expect(translations[key], key).toBeTruthy();
    }
  });
});
