// Collage layouts: grid templates for 2, 3, 4 or 6 photos, which photo goes in which cell, and
// a crop of each photo that keeps its faces. Pure geometry, no images: the tests feed it sizes.

export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Box = [number, number, number, number]; // a face: x1, y1, x2, y2 as fractions of the photo

// Cells as fractions of the canvas, before gutters.
const TEMPLATES: Record<number, Rect[][]> = {
  2: [
    [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }], // side by side
    [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }], // one above the other
  ],
  3: [
    [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }], // one big on the left
    [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }], // one big on top
  ],
  4: [grid(2, 2)],
  6: [grid(3, 2), grid(2, 3)],
};

function grid(cols: number, rows: number): Rect[] {
  const cells: Rect[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
  return cells;
}

export const CANVASES: Size[] = [{ w: 2400, h: 1800 }, { w: 1800, h: 2400 }];
export const GUTTER = 16;

// A template's cells in pixels: equal gutters between cells and round the edge.
function place(cells: Rect[], canvas: Size): Rect[] {
  return cells.map((c) => {
    const x = Math.round(GUTTER + c.x * (canvas.w - GUTTER));
    const y = Math.round(GUTTER + c.y * (canvas.h - GUTTER));
    const right = Math.round(GUTTER + (c.x + c.w) * (canvas.w - GUTTER)) - GUTTER;
    const bottom = Math.round(GUTTER + (c.y + c.h) * (canvas.h - GUTTER)) - GUTTER;
    return { x, y, w: right - x, h: bottom - y };
  });
}

// How much of a photo a cell's shape cuts away (0: none).
function loss(photo: Size, cell: Rect): number {
  const a = photo.w / photo.h;
  const b = cell.w / cell.h;
  return 1 - Math.min(a, b) / Math.max(a, b);
}

export type Layout = { canvas: Size; cells: Rect[]; order: number[] }; // order[i]: the photo in cells[i]

// The template, canvas and placing that crop the photos least: the widest photo in the widest
// cell, and so on.
export function chooseLayout(photos: Size[]): Layout {
  const options = TEMPLATES[photos.length];
  if (!options) throw new Error(`a collage takes 2, 3, 4 or 6 photos, not ${photos.length}`);
  const byShape = photos.map((p, i) => ({ i, r: p.w / p.h })).sort((a, b) => a.r - b.r || a.i - b.i);
  let best: (Layout & { loss: number }) | undefined;
  for (const canvas of CANVASES) {
    for (const template of options) {
      const cells = place(template, canvas);
      const cellOrder = cells.map((c, i) => ({ i, r: c.w / c.h })).sort((a, b) => a.r - b.r || a.i - b.i);
      const order = new Array<number>(cells.length);
      cellOrder.forEach((c, k) => (order[c.i] = byShape[k]!.i));
      const total = cells.reduce((sum, cell, i) => sum + loss(photos[order[i]!]!, cell), 0);
      if (!best || total < best.loss - 1e-9) best = { canvas, cells, order, loss: total };
    }
  }
  return { canvas: best!.canvas, cells: best!.cells, order: best!.order };
}

// The largest part of the photo with the cell's shape, placed to keep faces in: around all of
// them if they fit, else around the biggest. Faces sit a little above the middle; without
// faces, the middle.
export function cropFor(photo: Size, faces: Box[], cell: Rect): Rect {
  const aspect = cell.w / cell.h;
  const w = Math.min(photo.w, photo.h * aspect);
  const h = w / aspect;
  let cx = photo.w / 2;
  let cy = photo.h / 2;
  if (faces.length > 0) {
    const px = faces.map(([x1, y1, x2, y2]) => [x1 * photo.w, y1 * photo.h, x2 * photo.w, y2 * photo.h] as const);
    const all = px.reduce((u, f) => [Math.min(u[0], f[0]), Math.min(u[1], f[1]), Math.max(u[2], f[2]), Math.max(u[3], f[3])] as const);
    const target = all[2] - all[0] <= w && all[3] - all[1] <= h
      ? all
      : px.reduce((big, f) => ((f[2] - f[0]) * (f[3] - f[1]) > (big[2] - big[0]) * (big[3] - big[1]) ? f : big));
    cx = (target[0] + target[2]) / 2;
    cy = Math.min((target[1] + target[3]) / 2 + h * 0.1, target[1] + h / 2); // headroom, without cutting the top of a head
  }
  const x = Math.round(Math.min(Math.max(cx - w / 2, 0), photo.w - w));
  const y = Math.round(Math.min(Math.max(cy - h / 2, 0), photo.h - h));
  return { x, y, w: Math.min(Math.round(w), photo.w - x), h: Math.min(Math.round(h), photo.h - y) };
}
