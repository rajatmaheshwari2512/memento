// SelfPhotos Adjust's Markup.

import type { Size } from '#lib/ai-edit/adjust/adjust-geometry.ts';
import data from '#lib/ai-edit/adjust/adjust-markup.json';

// A place on the picture: 0–1 of its width and height (top left is 0, 0).
export type MarkupPoint = [number, number];

// `width` and `fontSize` are shares of the picture's longer side; `colour` is a colour's fill.
export type MarkupLine = { kind: 'pen' | 'highlighter'; colour: string; width: number; points: MarkupPoint[] };
export type MarkupShape = {
  kind: 'arrow' | 'box' | 'circle';
  colour: string;
  width: number;
  from: MarkupPoint;
  to: MarkupPoint;
};
// `at`: the middle of the text.
export type MarkupText = { kind: 'text'; colour: string; fontSize: number; at: MarkupPoint; text: string };
export type MarkupItem = MarkupLine | MarkupShape | MarkupText;

export type MarkupColour = { fill: string; outline: string };

export const MARKUP_COLOURS: MarkupColour[] = data.colours;
// Small, medium and large: a line's width and a new text's size.
export const MARKUP_SIZES: { width: number; text: number }[] = data.sizes;
export const HIGHLIGHTER = data.highlighter;
export const ARROW = data.arrow;
export const TEXT = data.text;
// A line's points are kept only this far apart (a share of the picture).
export const MIN_STEP: number = data.minStep;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Pixel = [number, number];

const longerSide = ({ width, height }: Size) => Math.max(width, height);

// A width or text size (a share of the longer side) in pixels, on a picture of `size`.
export const toPixels = (share: number, size: Size) => share * longerSide(size);

const pixel = ([x, y]: MarkupPoint, size: Size): Pixel => [x * size.width, y * size.height];

// An arrow from `from` to `to` (pixels), its line `width` pixels wide.
export function arrowGeometry(from: Pixel, to: Pixel, width: number) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const [ux, uy] = length > 0 ? [(to[0] - from[0]) / length, (to[1] - from[1]) / length] : [1, 0];
  const head = Math.min(width * ARROW.headLength, length * ARROW.maxHeadShare);
  const angle = (ARROW.headAngle * Math.PI) / 180;
  const back = head * Math.cos(angle);
  const side = head * Math.sin(angle);
  const base: Pixel = [to[0] - ux * back, to[1] - uy * back];
  return {
    lineEnd: base,
    head: [to, [base[0] - uy * side, base[1] + ux * side], [base[0] + uy * side, base[1] - ux * side]] as Pixel[],
  };
}

export const textFont = (pixels: number) => `${TEXT.weight} ${pixels}px ${TEXT.font}`;

// The box a text takes on a picture of `size` (pixels), centred on its place.
export function textBox(context: Context2D, item: MarkupText, size: Size) {
  const pixels = toPixels(item.fontSize, size);
  context.save();
  context.font = textFont(pixels);
  const metrics = context.measureText(item.text);
  context.restore();
  const ascent = metrics.fontBoundingBoxAscent;
  const height = ascent + metrics.fontBoundingBoxDescent;
  const [x, y] = pixel(item.at, size);
  return {
    x: x - metrics.width / 2,
    y: y - height / 2,
    width: metrics.width,
    height,
    baseline: y - height / 2 + ascent,
  };
}

const outlineOf = (colour: string) => MARKUP_COLOURS.find(({ fill }) => fill === colour)?.outline ?? '#000000';

function linePath(points: Pixel[]) {
  const [first, ...rest] = points;
  const path = new Path2D();
  path.moveTo(...first);
  for (let i = 0; i < rest.length - 1; i++) {
    const [x, y] = rest[i];
    const [nx, ny] = rest[i + 1];
    path.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  path.lineTo(...(rest.at(-1) ?? first));
  return path;
}

export function drawMarkup(context: Context2D, items: MarkupItem[], size: Size) {
  for (const item of items) {
    context.save();
    context.strokeStyle = item.colour;
    context.fillStyle = item.colour;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    switch (item.kind) {
      case 'pen':
      case 'highlighter': {
        const width = toPixels(item.width, size);
        const points = item.points.map((point) => pixel(point, size));
        context.globalAlpha = item.kind === 'highlighter' ? HIGHLIGHTER.opacity : 1;
        if (points.length === 1) {
          const dot = new Path2D();
          dot.arc(...points[0], width / 2, 0, Math.PI * 2);
          context.fill(dot);
        } else {
          context.lineWidth = width;
          context.stroke(linePath(points));
        }
        break;
      }
      case 'arrow': {
        const from = pixel(item.from, size);
        const width = toPixels(item.width, size);
        const { lineEnd, head } = arrowGeometry(from, pixel(item.to, size), width);
        const line = new Path2D();
        line.moveTo(...from);
        line.lineTo(...lineEnd);
        context.lineWidth = width;
        context.stroke(line);
        const point = new Path2D();
        point.moveTo(...head[0]);
        point.lineTo(...head[1]);
        point.lineTo(...head[2]);
        point.closePath();
        context.fill(point);
        break;
      }
      case 'box':
      case 'circle': {
        const [x0, y0] = pixel(item.from, size);
        const [x1, y1] = pixel(item.to, size);
        const outline = new Path2D();
        if (item.kind === 'box') {
          context.lineJoin = 'miter';
          outline.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        } else {
          const [rx, ry] = [Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2];
          outline.ellipse((x0 + x1) / 2, (y0 + y1) / 2, rx, ry, 0, 0, Math.PI * 2);
        }
        context.lineWidth = toPixels(item.width, size);
        context.stroke(outline);
        break;
      }
      case 'text': {
        if (!item.text) {
          break;
        }
        const pixels = toPixels(item.fontSize, size);
        const box = textBox(context, item, size);
        context.font = textFont(pixels);
        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        context.strokeStyle = outlineOf(item.colour);
        context.lineWidth = pixels * TEXT.outline;
        context.strokeText(item.text, box.x, box.baseline);
        context.fillText(item.text, box.x, box.baseline);
        break;
      }
    }
    context.restore();
  }
}

// The text font, loaded (canvases draw with a fallback font until it is).
export const markupFontReady = () => document.fonts.load(textFont(16)).then(() => undefined);

export class MarkupHistory {
  constructor(
    readonly items: MarkupItem[] = [],
    readonly past: MarkupItem[][] = [],
    readonly future: MarkupItem[][] = [],
  ) {}

  commit(items: MarkupItem[]) {
    return new MarkupHistory(items, [...this.past, this.items], []);
  }

  amend(items: MarkupItem[]) {
    const before = this.past.at(-1);
    if (before && sameItems(before, items)) {
      return new MarkupHistory(items, this.past.slice(0, -1), this.future);
    }
    return new MarkupHistory(items, this.past, this.future);
  }

  undo() {
    const before = this.past.at(-1);
    return before ? new MarkupHistory(before, this.past.slice(0, -1), [this.items, ...this.future]) : this;
  }

  redo() {
    const [after, ...rest] = this.future;
    return after ? new MarkupHistory(after, [...this.past, this.items], rest) : this;
  }
}

const sameItems = (a: MarkupItem[], b: MarkupItem[]) => a.length === b.length && a.every((item, i) => item === b[i]);
