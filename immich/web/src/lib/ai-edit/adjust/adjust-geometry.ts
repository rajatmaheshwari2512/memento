// SelfPhotos Adjust: straighten's and perspective's crop, and the tiles of a full-size render.
// Not part of Immich. Android has the same maths in
// mobile/lib/selfphotos/adjust/adjust_geometry.dart; adjust-geometry-parity.json holds values
// both are checked against.

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Point = [number, number];

// Perspective: four points the person drags onto lines that should be straight (a building's
// edges), clockwise from the top left, as shares of the photo's width and height (0..1).
export type Quad = [Point, Point, Point, Point];

// A 3×3 matrix, row by row, for positions [x, y, 1].
export type Matrix = [number, number, number, number, number, number, number, number, number];

// Turning a w×h photo by `degrees` leaves empty corners. The largest centred rectangle of
// the same shape that fits inside the turned photo is this share of its width and height:
// 1 / (cos + max(w/h, h/w)·sin). 1 at 0°; for a square at 45°, 0.7071.
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

// The corners as positions in the photo, in pixels.
const inPixels = (quad: Quad, { width, height }: Size) => quad.map(([x, y]) => [x * width, y * height] as Point);

// The four corners' rectangle once straightened: its sides as long as theirs, on average (pixels).
function markedSize(quad: Quad, source: Size): Size {
  const [p0, p1, p2, p3] = inPixels(quad, source);
  return {
    width: (distance(p0, p1) + distance(p3, p2)) / 2,
    height: (distance(p0, p3) + distance(p1, p2)) / 2,
  };
}

// Perspective's warp, the other way round: from a position in the straightened picture (the
// four corners' rectangle, markedSize, its top left at 0, 0) to the photo (pixels). The unit
// square to the corners (Heckbert's formula), after scaling the rectangle down to it.
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

// How sharply each corner must turn (the cross product of its two sides, in shares of the
// photo): keeps the corners a real four-sided shape, not a sliver or a bow tie.
const MIN_TURN = 0.01;
// How far the warp may stretch one side of the photo against the other: 10 times.
const MIN_DEPTH = 0.1;

// Whether the corners make a warp the photo survives: inside the photo, in order and turning
// the same way (a convex shape of some size), and with the whole photo still in front after the
// warp (none of it stretched to infinity), so its corners can be cropped to a rectangle.
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

// Where each output pixel comes from: the crop's width and height (each a share of the source's),
// its centre and turn, and perspective's warp to the photo (none without it). The shader's
// uCropScale, uCropCentre, uRotation and uPerspective rows.
export type Framing = {
  scale: [number, number];
  centre: Point;
  rotation: [number, number];
  toPhoto: Matrix | null;
};

export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Without perspective, straighten's centred crop, the photo's own shape. With it, a rectangle
// that keeps everything inside the four corners and has no empty corners, in the photo's own
// shape where one can, else in the shape closest to it (perspectiveCrop).
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

// A rectangle in the crop's own frame (the straightened picture, turned with the angle): its top
// left, width and height. A condition on one: a·(x, y, width, height) ≤ limit, as [...a, limit].
type Box = [number, number, number, number];
type Condition = [number, number, number, number, number];

const det3 = (c0: number[], c1: number[], c2: number[]) =>
  c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
  c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
  c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);

// Of four rows of four.
function det4(rows: number[][]) {
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const minor = rows.slice(1).map((row) => row.filter((_, k) => k !== j));
    sum += (j % 2 === 0 ? 1 : -1) * rows[0][j] * det3(minor[0], minor[1], minor[2]);
  }
  return sum;
}

// Perspective's crop. In the crop's frame the photo, warped, is a four-sided shape, and the four
// corners' rectangle (`marked`, straightened) is inside it. The crop is a rectangle inside the
// shape (no empty corners) and around the marked rectangle (nothing of it cut off): the largest of
// those with the photo's own shape; if none has it, the largest of those closest to it. Turned
// with the angle, the marked rectangle may reach past the photo's edges (when corners are on
// them): then the crop goes around as much of it as fits, kept centred.
function perspectiveCrop(toPhoto: Matrix, degrees: number, source: Size, marked: Size) {
  const { conditions, fallback } = cropConditions(toPhoto, degrees, source, marked);
  const [x, y, width, height] = bestCrop(conditions, fallback, source);
  // Its centre turned back, into the straightened picture.
  const [cos, sin] = rotation(degrees);
  return {
    scale: [width / source.width, height / source.height] as [number, number],
    centre: [cos * x + sin * y, -sin * x + cos * y] as Point,
    rotation: [cos, sin] as [number, number],
  };
}

// What a crop box must keep to, in the crop's frame: for each side of the warped photo (its
// outward direction n, of length 1), the box's corner farthest along n stays inside it; and the
// box goes around the marked rectangle's bounds, shrunk about their centre (by `fit`, at most 1)
// until they're inside the photo. `fallback`: those bounds, a box that keeps to all of it.
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

// The corners of what's allowed: boxes where four conditions meet, keeping to every condition.
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

// The boxes of one shape (width ratio·height) that could be the tallest: where three conditions
// meet, with the width written as ratio·height, keeping to every condition.
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

// The winner. What's allowed is convex, so the shapes it allows run from the narrowest of its
// corners to the widest, every one between them included: the photo's own shape if it's between,
// else the nearer end (there, only corners have that shape). Of that shape, the tallest (so the
// largest); of those (the same box, able to slide), the one in the middle. Returns its centre,
// width and height.
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
// source (perspective's crop may be another shape, so it may be longer on one side).
export function outputSize(degrees: number, source: Size, perspective?: Quad | null): Size {
  const [sx, sy] = framing(degrees, source, perspective).scale;
  const shrink = Math.min(1, 1 / Math.sqrt(sx * sy));
  return {
    width: Math.max(1, Math.round(source.width * sx * shrink)),
    height: Math.max(1, Math.round(source.height * sy * shrink)),
  };
}

// Where an output position (pixels) is in the source (pixels): adjust-core.glsl's
// sourcePosition, for working out which part of the source each tile needs.
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

// The part of the source a tile shows: the box around its turned (and warped) corners, plus
// `pad` pixels for smooth sampling, inside the source, on whole pixels. Perspective keeps
// straight lines straight, so the corners are enough.
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

// The biggest tile whose source part still fits in one GPU texture: a turned tile needs up
// to √2 times its size of the source, plus the padding.
export const tileSizeFor = (maxTextureSize: number) => Math.max(256, Math.min(2048, Math.floor(maxTextureSize / 1.5)));

// Perspective can make a tile's part of the source larger still (where the warp shrinks the
// photo): the tile size halved until every tile's part is at most `limit` on a side.
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
