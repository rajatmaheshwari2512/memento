import parity from '#lib/ai-edit/adjust/adjust-geometry-parity.json';
import {
  cropScale,
  framing,
  invert,
  isValidPerspective,
  outputSize,
  perspectiveMatrix,
  photoCorners,
  project,
  sourceRect,
  tileSizeFor,
  tileSizeWithin,
  tiles,
  toSource,
  type Point,
  type Quad,
  type Size,
} from '#lib/ai-edit/adjust/adjust-geometry.ts';

describe('cropScale', () => {
  it('keeps the whole photo when not turned', () => {
    expect(cropScale(0, { width: 4000, height: 3000 })).toBe(1);
  });

  it('matches the known values at 45°', () => {
    expect(cropScale(45, { width: 1000, height: 1000 })).toBeCloseTo(Math.SQRT1_2, 6);
    expect(cropScale(45, { width: 4000, height: 3000 })).toBeCloseTo(0.6061, 4);
    expect(cropScale(45, { width: 3000, height: 4000 })).toBeCloseTo(0.6061, 4);
  });

  it('is the same either way round', () => {
    expect(cropScale(-12.5, { width: 4080, height: 3072 })).toBeCloseTo(
      cropScale(12.5, { width: 4080, height: 3072 }),
      12,
    );
  });

  it('keeps every corner of the crop inside the turned photo, and is the largest that does', () => {
    for (const source of [
      { width: 4000, height: 3000 },
      { width: 3000, height: 4000 },
      { width: 1000, height: 1000 },
      { width: 8160, height: 6120 },
      { width: 1920, height: 400 },
    ]) {
      for (let degrees = -45; degrees <= 45; degrees += 0.7) {
        const output = outputSize(degrees, source);
        const corners = [
          toSource(0, 0, output, source, degrees),
          toSource(output.width, 0, output, source, degrees),
          toSource(0, output.height, output, source, degrees),
          toSource(output.width, output.height, output, source, degrees),
        ];
        const margin = 1e-6 * Math.max(source.width, source.height);
        let touches = 0;
        for (const [x, y] of corners) {
          expect(x).toBeGreaterThanOrEqual(-margin);
          expect(y).toBeGreaterThanOrEqual(-margin);
          expect(x).toBeLessThanOrEqual(source.width + margin);
          expect(y).toBeLessThanOrEqual(source.height + margin);
          if (Math.min(x, y, source.width - x, source.height - y) < 1e-6 * source.width + 1e-9) {
            touches++;
          }
        }
        expect(touches).toBeGreaterThan(0);
      }
    }
  });
});

describe('outputSize', () => {
  it('is the crop at the source resolution, the same shape as the source', () => {
    expect(outputSize(0, { width: 8160, height: 6120 })).toEqual({ width: 8160, height: 6120 });
    const turned = outputSize(10, { width: 4000, height: 3000 });
    expect(turned.width / turned.height).toBeCloseTo(4 / 3, 2);
    expect(turned.width).toBeLessThan(4000);
  });
});

describe('tiles', () => {
  it('cover the output exactly once', () => {
    const output = { width: 1000, height: 650 };
    const parts = tiles(output, 256);
    expect(parts).toHaveLength(4 * 3);
    const covered = new Uint8Array(output.width * output.height);
    for (const tile of parts) {
      for (let y = tile.y; y < tile.y + tile.height; y++) {
        for (let x = tile.x; x < tile.x + tile.width; x++) {
          covered[y * output.width + x]++;
        }
      }
    }
    expect(covered.every((count) => count === 1)).toBe(true);
  });

  it('fits a turned tile in the GPU texture limit', () => {
    expect(tileSizeFor(16_384)).toBe(2048);
    expect(tileSizeFor(4096)).toBe(2048);
    expect(tileSizeFor(2048)).toBe(1365);
    expect(tileSizeFor(2048) * Math.SQRT2 + 4).toBeLessThanOrEqual(2048);
  });
});

describe('sourceRect', () => {
  it('holds every source position the tile samples, and stays inside the source', () => {
    const source = { width: 3000, height: 2000 };
    for (const degrees of [0, 3.3, -17, 45]) {
      const output = outputSize(degrees, source);
      for (const tile of tiles(output, 512)) {
        const rect = sourceRect(tile, output, source, degrees);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(source.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(source.height);
        expect(rect.width).toBeLessThanOrEqual(Math.ceil(512 * Math.SQRT2) + 6);
        for (let y = tile.y + 0.5; y < tile.y + tile.height; y += 37) {
          for (let x = tile.x + 0.5; x < tile.x + tile.width; x += 37) {
            const [sx, sy] = toSource(x, y, output, source, degrees);
            expect(Math.max(0, sx - 1)).toBeGreaterThanOrEqual(rect.x - 1e-6);
            expect(Math.max(0, sy - 1)).toBeGreaterThanOrEqual(rect.y - 1e-6);
            expect(Math.min(source.width, sx + 1)).toBeLessThanOrEqual(rect.x + rect.width + 1e-6);
            expect(Math.min(source.height, sy + 1)).toBeLessThanOrEqual(rect.y + rect.height + 1e-6);
          }
        }
      }
    }
  });
});

const keystone: Quad = [
  [0.2, 0.05],
  [0.8, 0.05],
  [1, 0.95],
  [0, 0.95],
];

const corners = (output: Size): Point[] => [
  [0, 0],
  [output.width, 0],
  [output.width, output.height],
  [0, output.height],
];

function toOutput(point: Point, output: Size, source: Size, degrees: number, quad: Quad): Point {
  const {
    scale: [sx, sy],
    centre,
    rotation: [cos, sin],
  } = framing(degrees, source, quad);
  const [x, y] = project(invert(perspectiveMatrix(quad, source)), point);
  const [dx, dy] = [x - centre[0], y - centre[1]];
  const q = [cos * dx - sin * dy, sin * dx + cos * dy];
  return [(q[0] / (source.width * sx) + 0.5) * output.width, (q[1] / (source.height * sy) + 0.5) * output.height];
}

const markedCorners = (quad: Quad, source: Size, share = 0): Point[] => {
  const middle = [0, 1].map((axis) => quad.reduce((sum, corner) => sum + corner[axis], 0) / 4);
  return quad.map(([x, y]) => [
    (x + (middle[0] - x) * share) * source.width,
    (y + (middle[1] - y) * share) * source.height,
  ]);
};

function expectNoEmptyCorners(degrees: number, source: Size, quad: Quad) {
  const output = outputSize(degrees, source, quad);
  const margin = 1e-6 * Math.max(source.width, source.height);
  for (const [x, y] of corners(output)) {
    const [sx, sy] = toSource(x, y, output, source, degrees, quad);
    expect(sx).toBeGreaterThanOrEqual(-margin);
    expect(sy).toBeGreaterThanOrEqual(-margin);
    expect(sx).toBeLessThanOrEqual(source.width + margin);
    expect(sy).toBeLessThanOrEqual(source.height + margin);
  }
}

function expectShown(points: Point[], degrees: number, source: Size, quad: Quad) {
  const output = outputSize(degrees, source, quad);
  for (const point of points) {
    const [x, y] = toOutput(point, output, source, degrees, quad);
    expect(x).toBeGreaterThanOrEqual(-1e-6 * output.width);
    expect(y).toBeGreaterThanOrEqual(-1e-6 * output.height);
    expect(x).toBeLessThanOrEqual(output.width * (1 + 1e-6));
    expect(y).toBeLessThanOrEqual(output.height * (1 + 1e-6));
  }
}

const cropArea = (degrees: number, source: Size, quad: Quad) => {
  const [sx, sy] = framing(degrees, source, quad).scale;
  return source.width * sx * source.height * sy;
};

const cropShape = (degrees: number, source: Size, quad: Quad) => {
  const [sx, sy] = framing(degrees, source, quad).scale;
  return (source.width * sx) / (source.height * sy);
};

describe('perspective', () => {
  it('turns the four corners into a rectangle with their sides, on average', () => {
    const source = { width: 4000, height: 3000 };
    const fromPhoto = invert(perspectiveMatrix(keystone, source));
    const corners = keystone.map(([x, y]) => project(fromPhoto, [x * source.width, y * source.height]));
    const width = (2400 + 4000) / 2;
    const height = Math.hypot(800, 2700);
    const rectangle = [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ];
    for (const [i, [x, y]] of corners.entries()) {
      expect(x).toBeCloseTo(rectangle[i][0], 6);
      expect(y).toBeCloseTo(rectangle[i][1], 6);
    }
  });

  it("keeps the whole photo for a rectangle of corners, as without perspective; the photo's own corners are none", () => {
    const source = { width: 4032, height: 3024 };
    const rectangle: Quad = [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ];
    expect(outputSize(0, source, rectangle)).toEqual(source);
    for (const [x, y] of [
      [0, 0],
      [source.width, source.height],
      [123, 456],
    ]) {
      const [sx, sy] = toSource(x, y, source, source, 0, rectangle);
      expect(sx).toBeCloseTo(x, 6);
      expect(sy).toBeCloseTo(y, 6);
    }
    expect(framing(5, source, photoCorners())).toEqual(framing(5, source));
  });

  it("keeps everything inside the four corners, with no empty corners, in the photo's shape when it can", () => {
    for (const [degrees, source, quad] of [
      [0, { width: 4000, height: 3000 }, keystone],
      [
        0,
        { width: 3000, height: 4000 },
        [
          [0.05, 0.1],
          [0.95, 0],
          [0.95, 1],
          [0.05, 0.9],
        ],
      ],
      [
        0,
        { width: 4000, height: 3000 },
        [
          [0.32, 0.2],
          [0.68, 0.2],
          [0.82, 0.9],
          [0.18, 0.9],
        ],
      ],
      [
        3,
        { width: 4032, height: 3024 },
        [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
      ],
    ] as [number, Size, Quad][]) {
      expectNoEmptyCorners(degrees, source, quad);
      expectShown(markedCorners(quad, source), degrees, source, quad);
    }
    const building: Quad = [
      [0.32, 0.2],
      [0.68, 0.2],
      [0.82, 0.9],
      [0.18, 0.9],
    ];
    expect(cropShape(0, { width: 4000, height: 3000 }, building)).toBeCloseTo(4 / 3, 9);
    expect(cropShape(0, { width: 300, height: 400 }, building)).toBeCloseTo(3 / 4, 9);
    const wall: Quad = [
      [0.05, 0.1],
      [0.95, 0],
      [0.95, 1],
      [0.05, 0.9],
    ];
    const shape = cropShape(0, { width: 3000, height: 4000 }, wall);
    expect(shape).toBeGreaterThan(3 / 4 + 1e-6);
    expect(Math.log(shape / (3 / 4))).toBeLessThan(0.02);
    expectNoEmptyCorners(0, { width: 3000, height: 4000 }, wall);
    expectShown(markedCorners(wall, { width: 3000, height: 4000 }), 0, { width: 3000, height: 4000 }, wall);
  });

  it("is the photo's shape or the closest to it, and the largest of that shape: on a grid, no box of a closer shape fits and none of the same is larger", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const keystone: Quad = [
      [0.25, 0.1],
      [0.75, 0.1],
      [0.95, 0.9],
      [0.05, 0.9],
    ];
    const quads: [number, Size, Quad][] = [
      [
        2,
        { width: 3000, height: 4000 },
        [
          [0.3, 0.15],
          [0.7, 0.2],
          [0.85, 0.85],
          [0.2, 0.8],
        ],
      ],
      [0, { width: 3000, height: 4000 }, keystone],
      [0, { width: 1600, height: 1200 }, keystone],
      [3, { width: 1600, height: 1200 }, keystone],
    ];
    while (quads.length < 12) {
      const quad = photoCorners().map(([x, y]) => [
        0.05 + 0.4 * random() + 0.5 * x,
        0.05 + 0.4 * random() + 0.5 * y,
      ]) as Quad;
      if (isValidPerspective(quad)) {
        quads.push([0, { width: 1600, height: 1200 }, quad]);
      }
    }
    let ownShape = 0;
    for (const [degrees, source, quad] of quads) {
      const name = JSON.stringify([degrees, quad]);
      const area = cropArea(degrees, source, quad);
      const shape = cropShape(degrees, source, quad);
      const grid = largestByGrid(degrees, source, quad, shape);
      expect(grid, name).toBeLessThanOrEqual(area * (1 + 1e-6));
      const gap = Math.log(source.width / source.height / shape);
      if (Math.abs(gap) < 1e-9) {
        ownShape++;
        expect(grid, name).toBeGreaterThan(area * 0.85);
      } else {
        expect(largestByGrid(degrees, source, quad, shape / Math.exp(Math.sign(gap) * 0.02)), name).toBeGreaterThan(0);
        for (let step = 0.005; step < Math.abs(gap) + 0.005; step += 0.005) {
          const closer = shape * Math.exp(Math.sign(gap) * Math.min(step, Math.abs(gap)));
          expect(largestByGrid(degrees, source, quad, closer), `${name} at ${closer}`).toBe(0);
        }
      }
      expectNoEmptyCorners(degrees, source, quad);
      expectShown(markedCorners(quad, source), degrees, source, quad);
    }
    expect(ownShape).toBeGreaterThan(0);
    expect(ownShape).toBeLessThan(quads.length);
  });

  it('with straighten, goes around as much of the marked area as fits when it reaches the photo’s edges', () => {
    const source = { width: 4032, height: 3024 };
    const quad: Quad = [
      [0.15, 0],
      [0.85, 0],
      [1, 1],
      [0, 1],
    ];
    expect(outputSize(0, source, quad)).toEqual({ width: 3427, height: 3084 });
    for (const degrees of [4, -4]) {
      expectNoEmptyCorners(degrees, source, quad);
      expectShown(markedCorners(quad, source, 0.2), degrees, source, quad);
      expect(cropArea(degrees, source, quad)).toBeLessThan(cropArea(0, source, quad));
    }
  });

  it('accepts only corners in order, inside the photo, that keep the whole photo in front', () => {
    for (const quad of parity.valid) {
      expect(isValidPerspective(quad as Quad), JSON.stringify(quad)).toBe(true);
    }
    for (const { name, corners } of parity.invalid) {
      expect(isValidPerspective(corners as Quad), name).toBe(false);
    }
  });

  it('gives the values the Android app is checked against', () => {
    const close = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
    for (const { name, source, angle, corners, expected } of parity.cases) {
      const view = framing(angle, source, corners as Quad);
      expect(view.toPhoto, name).not.toBeNull();
      for (const [i, value] of view.toPhoto!.entries()) {
        close(value, expected.toPhoto[i]);
      }
      close(view.centre[0], expected.centre[0]);
      close(view.centre[1], expected.centre[1]);
      close(view.scale[0], expected.scale[0]);
      close(view.scale[1], expected.scale[1]);
      expect(outputSize(angle, source, corners as Quad), name).toEqual(expected.output);
      for (const { at, source: position } of expected.toSource) {
        const [x, y] = toSource(at[0], at[1], expected.output, source, angle, corners as Quad);
        close(x, position[0]);
        close(y, position[1]);
      }
    }
  });

  it("keeps each tile's part of the source within the GPU's limit", () => {
    const source = { width: 8000, height: 6000 };
    const steep: Quad = [
      [0.3, 0.3],
      [0.7, 0.3],
      [1, 1],
      [0, 1],
    ];
    const output = outputSize(0, source, steep);
    const size = tileSizeWithin(output, source, 0, steep, 2048, 2048);
    expect(size).toBeLessThan(2048);
    for (const tile of tiles(output, size)) {
      const part = sourceRect(tile, output, source, 0, steep);
      expect(Math.max(part.width, part.height)).toBeLessThanOrEqual(2048);
    }
    expect(tileSizeWithin(outputSize(45, source), source, 45, null, tileSizeFor(4096), 4096)).toBe(tileSizeFor(4096));
  });
});

function largestByGrid(degrees: number, source: Size, quad: Quad, shape: number) {
  const toPhoto = perspectiveMatrix(quad, source);
  const fromPhoto = invert(toPhoto);
  const radians = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
  const toFrame = ([x, y]: Point): Point => [cos * x - sin * y, sin * x + cos * y];
  const fromFrame = ([x, y]: Point): Point => [cos * x + sin * y, -sin * x + cos * y];
  const margin = 1e-9 * Math.max(source.width, source.height);
  const inside = (point: Point) => {
    const [x, y] = project(toPhoto, fromFrame(point));
    return x >= -margin && y >= -margin && x <= source.width + margin && y <= source.height + margin;
  };
  const held = markedCorners(quad, source).map((point) => toFrame(project(fromPhoto, point)));
  const [left, right] = [Math.min(...held.map(([x]) => x)), Math.max(...held.map(([x]) => x))];
  const [top, bottom] = [Math.min(...held.map(([, y]) => y)), Math.max(...held.map(([, y]) => y))];
  const outline = corners(source).map((point) => toFrame(project(fromPhoto, point)));
  const tallest = Math.max(...outline.map(([, y]) => y)) - Math.min(...outline.map(([, y]) => y)) + 1;
  const fits = (height: number, u: number, v: number) => {
    const width = height * shape;
    const x = left - u * (width - (right - left));
    const y = top - v * (height - (bottom - top));
    return [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ].every((corner) => inside(corner as Point));
  };
  const smallest = Math.max(bottom - top, (right - left) / shape);
  const steps = 60;
  let best = 0;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const [u, v] = [i / steps, j / steps];
      if (!fits(smallest, u, v)) {
        continue;
      }
      let [low, high] = [smallest, tallest];
      for (let step = 0; step < 40; step++) {
        const middle = (low + high) / 2;
        [low, high] = fits(middle, u, v) ? [middle, high] : [low, middle];
      }
      best = Math.max(best, low * low * shape);
    }
  }
  return best;
}
