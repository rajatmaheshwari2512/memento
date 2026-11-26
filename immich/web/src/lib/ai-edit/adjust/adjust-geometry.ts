// SelfPhotos Adjust: straighten's and perspective's crop, and the tiles of a full-size render.

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Point = [number, number];

// Perspective: four points the person drags onto lines that should be straight (a building's
// edges), clockwise from the top left.
export type Quad = [Point, Point, Point, Point];

// A 3×3 matrix, row by row, for positions [x, y, 1].
export type Matrix = [number, number, number, number, number, number, number, number, number];

// Turning a w×h photo by `degrees` leaves empty corners.
export function cropScale(degrees: number, { width, height }: Size): number {
  const radians = (Math.abs(degrees) * Math.PI) / 180;
  const ratio = Math.max(width / height, height / width);
  return 1 / (Math.cos(radians) + ratio * Math.sin(radians));
}

// (cos, sin) of the angle, for the shader's uRotation.
export function rotation(degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

// The corners that change nothing: the photo's own.
export const photoCorners = (): Quad => [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export const project = (m: Matrix, [x, y]: Point): Point => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

const inPixels = (quad: Quad, { width, height }: Size) => quad.map(([x, y]) => [x * width, y * height] as Point);

function markedSize(quad: Quad, source: Size): Size {
  const [p0, p1, p2, p3] = inPixels(quad, source);
  return {
    width: (distance(p0, p1) + distance(p3, p2)) / 2,
    height: (distance(p0, p3) + distance(p1, p2)) / 2,
  };
}

// Perspective's warp, the other way round.
export function perspectiveMatrix(quad: Quad, source: Size): Matrix {
  const [p0, p1, p2, p3] = inPixels(quad, source);
  const { width, height } = markedSize(quad, source);
  const sx = p0[0] - p1[0] + p2[0] - p3[0];
  const sy = p0[1] - p1[1] + p2[1] - p3[1];
  const dx1 = p1[0] - p2[0];
  const dx2 = p3[0] - p2[0];
  const dy1 = p1[1] - p2[1];
  const dy2 = p3[1] - p2[1];
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [
    (p1[0] - p0[0] + g * p1[0]) / width,
    (p3[0] - p0[0] + h * p3[0]) / height,
    p0[0],
    (p1[1] - p0[1] + g * p1[1]) / width,
    (p3[1] - p0[1] + h * p3[1]) / height,
    p0[1],
    g / width,
    h / height,
    1,
  ];
}

const MIN_TURN = 0.01;
const MIN_DEPTH = 0.1;

// Whether the corners make a warp the photo survives.
export function isValidPerspective(quad: Quad): boolean {
  if (quad.some(([x, y]) => !(x >= 0 && x <= 1 && y >= 0 && y <= 1))) {
    return false;
  }
  for (let i = 0; i < 4; i++) {
    if (!(cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) >= MIN_TURN)) {
      return false;
    }
  }
  const fromPhoto = invert(perspectiveMatrix(quad, { width: 1, height: 1 }));
  const depths = photoCorners().map(([x, y]) => fromPhoto[6] * x + fromPhoto[7] * y + fromPhoto[8]);
  const nearest = Math.min(...depths.map((depth) => Math.abs(depth)));
  const farthest = Math.max(...depths.map((depth) => Math.abs(depth)));
  return depths.every((depth) => Math.sign(depth) === Math.sign(depths[0])) && nearest >= MIN_DEPTH * farthest;
}

export const isPhotoCorners = (quad: Quad) => photoCorners().every(([x, y], i) => quad[i][0] === x && quad[i][1] === y);

// Where each output pixel comes from.
export type Framing = {
  scale: [number, number];
  centre: Point;
  rotation: [number, number];
  toPhoto: Matrix | null;
};

export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Without perspective, straighten's centred crop, the photo's own shape.
export function framing(degrees: number, source: Size, perspective?: Quad | null): Framing {
  const scale = cropScale(degrees, source);
  const plain: Framing = {
    scale: [scale, scale],
    centre: [source.width / 2, source.height / 2],
    rotation: rotation(degrees),
    toPhoto: null,
  };
  if (!perspective || isPhotoCorners(perspective) || !isValidPerspective(perspective)) {
    return plain;
  }
  const toPhoto = perspectiveMatrix(perspective, source);
  return { ...perspectiveCrop(toPhoto, degrees, source, markedSize(perspective, source)), toPhoto };
}

type Box = [number, number, number, number];
type Condition = [number, number, number, number, number];

const det3 = (c0: number[], c1: number[], c2: number[]) =>
  c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
  c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
  c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);

function det4(rows: number[][]) {
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const minor = rows.slice(1).map((row) => row.filter((_, k) => k !== j));
    sum += (j % 2 === 0 ? 1 : -1) * rows[0][j] * det3(minor[0], minor[1], minor[2]);
  }
  return sum;
}

function perspectiveCrop(toPhoto: Matrix, degrees: number, source: Size, marked: Size) {
  const { conditions, fallback } = cropConditions(toPhoto, degrees, source, marked);
  const [x, y, width, height] = bestCrop(conditions, fallback, source);
  const [cos, sin] = rotation(degrees);
  return {
    scale: [width / source.width, height / source.height] as [number, number],
    centre: [cos * x + sin * y, -sin * x + cos * y] as Point,
    rotation: [cos, sin] as [number, number],
  };
}

function cropConditions(toPhoto: Matrix, degrees: number, source: Size, marked: Size) {
  const fromPhoto = invert(toPhoto);
  const [cos, sin] = rotation(degrees);
  const turn = ([x, y]: Point): Point => [cos * x - sin * y, sin * x + cos * y];
  const outline = photoCorners().map(([x, y]) => turn(project(fromPhoto, [x * source.width, y * source.height])));
  const corners = photoCorners().map(([x, y]) => turn([x * marked.width, y * marked.height]));
  const area = outline.reduce((sum, a, i) => sum + cross([0, 0], a, outline[(i + 1) % 4]), 0);
  const sides = outline.map((a, i) => {
    const b = outline[(i + 1) % 4];
    const length = distance(a, b) * (area > 0 ? 1 : -1);
    const n: Point = [(b[1] - a[1]) / length, (a[0] - b[0]) / length];
    return { n, d: n[0] * a[0] + n[1] * a[1] };
  });
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const hx = (Math.max(...xs) - Math.min(...xs)) / 2;
  const hy = (Math.max(...ys) - Math.min(...ys)) / 2;
  const fit = Math.min(
    1,
    ...sides.map(({ n, d }) => (d - n[0] * cx - n[1] * cy) / (Math.abs(n[0]) * hx + Math.abs(n[1]) * hy)),
  );
  const conditions: Condition[] = [
    ...sides.map(({ n, d }): Condition => [n[0], n[1], Math.max(n[0], 0), Math.max(n[1], 0), d]),
    [1, 0, 0, 0, cx - fit * hx],
    [-1, 0, -1, 0, -(cx + fit * hx)],
    [0, 1, 0, 0, cy - fit * hy],
    [0, -1, 0, -1, -(cy + fit * hy)],
  ];
  const fallback: Box = [cx - fit * hx, cy - fit * hy, 2 * fit * hx, 2 * fit * hy];
  return { conditions, fallback };
}

const keepsTo = (conditions: Condition[], tolerance: number) => (box: Box) =>
  conditions.every((c) => c[0] * box[0] + c[1] * box[1] + c[2] * box[2] + c[3] * box[3] <= c[4] + tolerance);

function cropCorners(conditions: Condition[], tolerance: number): Box[] {
  const keeps = keepsTo(conditions, tolerance);
  const found: Box[] = [];
  const count = conditions.length;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      for (let k = j + 1; k < count; k++) {
        for (let l = k + 1; l < count; l++) {
          const four = [conditions[i], conditions[j], conditions[k], conditions[l]];
          const det = det4(four.map((c) => c.slice(0, 4)));
          if (Math.abs(det) < 1e-12) {
            continue;
          }
          const box = [0, 1, 2, 3].map(
            (column) => det4(four.map((c) => c.slice(0, 4).map((value, m) => (m === column ? c[4] : value)))) / det,
          ) as Box;
          if (box[2] > 0 && box[3] > 0 && keeps(box)) {
            found.push(box);
          }
        }
      }
    }
  }
  return found;
}

function cropsOfShape(conditions: Condition[], ratio: number, tolerance: number): Box[] {
  const keeps = keepsTo(conditions, tolerance);
  const found: Box[] = [];
  const count = conditions.length;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      for (let k = j + 1; k < count; k++) {
        const three = [conditions[i], conditions[j], conditions[k]];
        const column = (m: number) => three.map((c) => c[m]);
        const across = three.map((c) => c[2] * ratio + c[3]);
        const det = det3(column(0), column(1), across);
        if (Math.abs(det) < 1e-12) {
          continue;
        }
        const height = det3(column(0), column(1), column(4)) / det;
        const box: Box = [
          det3(column(4), column(1), across) / det,
          det3(column(0), column(4), across) / det,
          ratio * height,
          height,
        ];
        if (height > 0 && keeps(box)) {
          found.push(box);
        }
      }
    }
  }
  return found;
}

function bestCrop(conditions: Condition[], fallback: Box, source: Size): Box {
  const tolerance = 1e-9 * Math.max(source.width, source.height);
  const corners = cropCorners(conditions, tolerance);
  const found = corners.length > 0 ? corners : [fallback];
  const shape = source.width / source.height;
  const ratios = found.map((box) => box[2] / box[3]);
  let best =
    Math.min(...ratios) < shape && shape < Math.max(...ratios) ? cropsOfShape(conditions, shape, tolerance) : [];
  if (best.length === 0) {
    const offShape = (box: Box) => Math.abs(Math.log(box[2] / box[3] / shape));
    const closest = Math.min(...found.map((box) => offShape(box)));
    best = found.filter((box) => offShape(box) <= closest + 1e-9);
  }
  const tallest = Math.max(...best.map((box) => box[3]));
  best = best.filter((box) => box[3] >= tallest * (1 - 1e-9));
  const middle = (axis: 0 | 1) => {
    const centres = best.map((box) => box[axis] + box[axis + 2] / 2);
    return (Math.min(...centres) + Math.max(...centres)) / 2;
  };
  return [middle(0), middle(1), best[0][2], best[0][3]];
}

// The saved photo's size: the crop at the source's own resolution, never more pixels than the
// source.
export function outputSize(degrees: number, source: Size, perspective?: Quad | null): Size {
  const [sx, sy] = framing(degrees, source, perspective).scale;
  const shrink = Math.min(1, 1 / Math.sqrt(sx * sy));
  return {
    width: Math.max(1, Math.round(source.width * sx * shrink)),
    height: Math.max(1, Math.round(source.height * sy * shrink)),
  };
}

function sourcePosition(x: number, y: number, output: Size, source: Size, view: Framing): Point {
  const {
    scale: [sx, sy],
    centre,
    rotation: [cos, sin],
    toPhoto,
  } = view;
  const qx = (x / output.width - 0.5) * source.width * sx;
  const qy = (y / output.height - 0.5) * source.height * sy;
  const turned: Point = [centre[0] + qx * cos + qy * sin, centre[1] + qy * cos - qx * sin];
  return toPhoto ? project(toPhoto, turned) : turned;
}

export const toSource = (
  x: number,
  y: number,
  output: Size,
  source: Size,
  degrees: number,
  perspective?: Quad | null,
): Point => sourcePosition(x, y, output, source, framing(degrees, source, perspective));

// The output cut into tiles of at most `size`×`size`, row by row.
export function tiles(output: Size, size: number): Rect[] {
  const result: Rect[] = [];
  for (let y = 0; y < output.height; y += size) {
    for (let x = 0; x < output.width; x += size) {
      result.push({ x, y, width: Math.min(size, output.width - x), height: Math.min(size, output.height - y) });
    }
  }
  return result;
}

function partOf(tile: Rect, output: Size, source: Size, view: Framing, pad: number): Rect {
  const corners = [
    sourcePosition(tile.x, tile.y, output, source, view),
    sourcePosition(tile.x + tile.width, tile.y, output, source, view),
    sourcePosition(tile.x, tile.y + tile.height, output, source, view),
    sourcePosition(tile.x + tile.width, tile.y + tile.height, output, source, view),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const x1 = Math.min(source.width, Math.ceil(Math.max(...xs)) + pad);
  const y1 = Math.min(source.height, Math.ceil(Math.max(...ys)) + pad);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

export const sourceRect = (
  tile: Rect,
  output: Size,
  source: Size,
  degrees: number,
  perspective?: Quad | null,
  pad = 2,
): Rect => partOf(tile, output, source, framing(degrees, source, perspective), pad);

// The biggest tile whose source part still fits in one GPU texture.
export const tileSizeFor = (maxTextureSize: number) => Math.max(256, Math.min(2048, Math.floor(maxTextureSize / 1.5)));

// Perspective can make a tile's part of the source larger still (where the warp shrinks the
// photo).
export function tileSizeWithin(
  output: Size,
  source: Size,
  degrees: number,
  perspective: Quad | null | undefined,
  size: number,
  limit: number,
): number {
  const view = framing(degrees, source, perspective);
  const tooBig = (tile: Rect) => {
    const part = partOf(tile, output, source, view, 2);
    return part.width > limit || part.height > limit;
  };
  while (size > 64 && tiles(output, size).some((tile) => tooBig(tile))) {
    size = Math.floor(size / 2);
  }
  return size;
}
