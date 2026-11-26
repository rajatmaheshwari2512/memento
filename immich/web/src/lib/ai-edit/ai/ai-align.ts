// SelfPhotos AI tools: lining the AI's result up with the photo before pasting.

// A greyscale picture, one value (0–255) per pixel.
export type Grey = { width: number; height: number; data: Float32Array };

// Where a point of the photo (x and y from 0 to 1) is in the result.
export type Alignment = {
  scaleX: number;
  offsetX: number;
  scaleY: number;
  offsetY: number;
  error: number;
  patches: number;
};

export const IDENTITY: Alignment = { scaleX: 1, offsetX: 0, scaleY: 1, offsetY: 0, error: 0, patches: 0 };

const COLUMNS = 10;
const ROWS = 8;
const HALF = 16;
const SEARCH = 12;
const FLAT = 2;
const MIN_PATCHES = 5;

// The average of the box ±`radius` px around each value.
export function boxBlur(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  const span = radius * 2 + 1;
  const across = new Float32Array(data.length);
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += data[row + clamp(x, width - 1)];
    }
    for (let x = 0; x < width; x++) {
      across[row + x] = sum / span;
      sum += data[row + clamp(x + radius + 1, width - 1)] - data[row + clamp(x - radius, width - 1)];
    }
  }
  const out = new Float32Array(data.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += across[clamp(y, height - 1) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      sum += across[clamp(y + radius + 1, height - 1) * width + x] - across[clamp(y - radius, height - 1) * width + x];
    }
  }
  return out;
}

const DETAIL = 4;

function detailOf({ width, height, data }: Grey): Grey {
  const blurred = boxBlur(data, width, height, DETAIL);
  return { width, height, data: data.map((value, i) => value - blurred[i]) };
}

function match(base: Grey, result: Grey, cx: number, cy: number): [number, number] | null {
  const { width, data } = base;
  let sum = 0;
  let squares = 0;
  for (let y = cy - HALF; y <= cy + HALF; y++) {
    for (let x = cx - HALF; x <= cx + HALF; x++) {
      const value = data[y * width + x];
      sum += value;
      squares += value * value;
    }
  }
  const count = (HALF * 2 + 1) ** 2;
  if (Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2)) < FLAT) {
    return null;
  }
  const span = SEARCH * 2 + 1;
  const cost = new Float32Array(span * span);
  let best = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let total = 0;
      for (let y = cy - HALF; y <= cy + HALF; y++) {
        const row = y * width;
        const shifted = (y + dy) * width + dx;
        for (let x = cx - HALF; x <= cx + HALF; x++) {
          total += Math.abs(data[row + x] - result.data[shifted + x]);
        }
      }
      const index = (dy + SEARCH) * span + dx + SEARCH;
      cost[index] = total;
      if (total < cost[best]) {
        best = index;
      }
    }
  }
  const [bx, by] = [best % span, Math.floor(best / span)];
  if (bx === 0 || by === 0 || bx === span - 1 || by === span - 1) {
    return null;
  }
  const refine = (before: number, at: number, after: number) => {
    const curve = before - 2 * at + after;
    return curve > 0 ? (before - after) / (2 * curve) : 0;
  };
  const c = (x: number, y: number) => cost[y * span + x];
  return [
    bx - SEARCH + refine(c(bx - 1, by), c(bx, by), c(bx + 1, by)),
    by - SEARCH + refine(c(bx, by - 1), c(bx, by), c(bx, by + 1)),
  ];
}

function fit(points: Array<[number, number]>, extent: number): [number, number] {
  const n = points.length;
  const meanP = points.reduce((s, [p]) => s + p, 0) / n;
  const meanS = points.reduce((s, [, v]) => s + v, 0) / n;
  const spread = Math.max(...points.map(([p]) => p)) - Math.min(...points.map(([p]) => p));
  if (spread < extent * 0.25) {
    return [0, meanS];
  }
  let covariance = 0;
  let variance = 0;
  for (const [p, v] of points) {
    covariance += (p - meanP) * (v - meanS);
    variance += (p - meanP) ** 2;
  }
  const slope = covariance / variance;
  return [slope, meanS - slope * meanP];
}

function nearChange(changed: Grey | null) {
  if (!changed) {
    return () => false;
  }
  const { width, height, data } = changed;
  const table = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x] > 0 ? 1 : 0;
      table[(y + 1) * (width + 1) + x + 1] = table[y * (width + 1) + x + 1] + row;
    }
  }
  return (cx: number, cy: number, reach: number) => {
    const [x0, y0] = [Math.max(0, cx - reach), Math.max(0, cy - reach)];
    const [x1, y1] = [Math.min(width, cx + reach + 1), Math.min(height, cy + reach + 1)];
    const at = (x: number, y: number) => table[y * (width + 1) + x];
    return at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0) > 0;
  };
}

// The alignment of `edited` to `photo` (two pictures of the same size), from patches away from
// `changed`.
export function estimateAlignment(photo: Grey, edited: Grey, changed: Grey | null): Alignment | null {
  const [base, result] = [detailOf(photo), detailOf(edited)];
  const { width, height } = base;
  const margin = HALF + SEARCH + 1;
  const near = nearChange(changed);
  let found: Array<{ x: number; y: number; dx: number; dy: number }> = [];
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const x = Math.round(margin + ((width - 2 * margin) * (column + 0.5)) / COLUMNS);
      const y = Math.round(margin + ((height - 2 * margin) * (row + 0.5)) / ROWS);
      if (near(x, y, margin)) {
        continue;
      }
      const shift = match(base, result, x, y);
      if (shift) {
        found.push({ x, y, dx: shift[0], dy: shift[1] });
      }
    }
  }
  if (found.length < MIN_PATCHES) {
    return null;
  }

  const solve = () => {
    const [ax, bx] = fit(
      found.map(({ x, dx }) => [x, dx]),
      width,
    );
    const [ay, by] = fit(
      found.map(({ y, dy }) => [y, dy]),
      height,
    );
    const misses = found.map(({ x, y, dx, dy }) => Math.hypot(dx - (ax * x + bx), dy - (ay * y + by)));
    return { ax, bx, ay, by, misses };
  };
  let fitted = solve();
  const median = [...fitted.misses].sort((a, b) => a - b)[Math.floor(fitted.misses.length / 2)];
  const kept = found.filter((_, i) => fitted.misses[i] <= Math.max(1, 3 * median));
  if (kept.length >= MIN_PATCHES && kept.length < found.length) {
    found = kept;
    fitted = solve();
  }
  const { ax, bx, ay, by, misses } = fitted;
  return {
    scaleX: 1 + ax,
    offsetX: bx / width,
    scaleY: 1 + ay,
    offsetY: by / height,
    error: Math.sqrt(misses.reduce((s, m) => s + m * m, 0) / misses.length) / width,
    patches: found.length,
  };
}
