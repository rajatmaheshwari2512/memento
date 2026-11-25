// SelfPhotos AI tools: lining the AI's result up with the photo before pasting. The same steps
// and numbers as the web's ai-align.ts (see it for why). Not part of Immich.
//
// Gemini's content isn't exactly where the original's is (the first real 4K result was about
// 0.35% larger and a few pixels off), so a pasted area's edge would be off by up to ~13 px. The
// error is fitted as a scale and an offset per axis, from small patches of the photo outside the
// highlighted area, matched by their detail between the photo and the result.
import 'dart:math';
import 'dart:typed_data';

/// A greyscale picture, one value (0–255) per pixel.
class Grey {
  final int width;
  final int height;
  final Float32List data;

  const Grey(this.width, this.height, this.data);
}

/// Where a point of the photo (x and y from 0 to 1) is in the result:
/// (scaleX·x + offsetX, scaleY·y + offsetY). [error]: how far the matched patches still are
/// from that, as a share of the photo's width.
class AiAlignment {
  final double scaleX;
  final double offsetX;
  final double scaleY;
  final double offsetY;
  final double error;
  final int patches;

  const AiAlignment(this.scaleX, this.offsetX, this.scaleY, this.offsetY, {this.error = 0, this.patches = 0});

  static const identity = AiAlignment(1, 0, 1, 0);
}

const _columns = 10;
const _rows = 8;
const _half = 16; // a patch is 33×33 px
const _search = 12; // ±12 px, about ±50 px at full size
const _flat = 2.0; // a patch whose detail varies less than this can't be matched
const _minPatches = 5;
const _detail = 4; // the detail: each value less the average of the box ±4 px around it (_detailOf)

int _clamp(int value, int max) => value < 0 ? 0 : (value > max ? max : value);

/// The average of the box ±[radius] px around each value (across, then down, by running sums;
/// edges repeated). Also the mask's soft edge (ai_area.dart feather).
Float32List boxBlur(Float32List data, int width, int height, int radius) {
  final span = radius * 2 + 1;
  final across = Float32List(data.length);
  for (var y = 0; y < height; y++) {
    final row = y * width;
    var sum = 0.0;
    for (var x = -radius; x <= radius; x++) {
      sum += data[row + _clamp(x, width - 1)];
    }
    for (var x = 0; x < width; x++) {
      across[row + x] = sum / span;
      sum += data[row + _clamp(x + radius + 1, width - 1)] - data[row + _clamp(x - radius, width - 1)];
    }
  }
  final out = Float32List(data.length);
  for (var x = 0; x < width; x++) {
    var sum = 0.0;
    for (var y = -radius; y <= radius; y++) {
      sum += across[_clamp(y, height - 1) * width + x];
    }
    for (var y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      sum +=
          across[_clamp(y + radius + 1, height - 1) * width + x] - across[_clamp(y - radius, height - 1) * width + x];
    }
  }
  return out;
}

Grey _detailOf(Grey grey) {
  final blurred = boxBlur(grey.data, grey.width, grey.height, _detail);
  final out = Float32List(grey.data.length);
  for (var i = 0; i < out.length; i++) {
    out[i] = grey.data[i] - blurred[i];
  }
  return Grey(grey.width, grey.height, out);
}

// How far `result` must move to match `base` at (cx, cy), to a fraction of a pixel; null when
// the patch is flat or the best match is at the edge of the search.
(double, double)? _match(Grey base, Grey result, int cx, int cy) {
  final width = base.width;
  var sum = 0.0;
  var squares = 0.0;
  for (var y = cy - _half; y <= cy + _half; y++) {
    for (var x = cx - _half; x <= cx + _half; x++) {
      final value = base.data[y * width + x];
      sum += value;
      squares += value * value;
    }
  }
  const count = (_half * 2 + 1) * (_half * 2 + 1);
  if (sqrt(max(0.0, squares / count - pow(sum / count, 2))) < _flat) {
    return null;
  }
  const span = _search * 2 + 1;
  final cost = Float64List(span * span);
  var best = 0;
  for (var dy = -_search; dy <= _search; dy++) {
    for (var dx = -_search; dx <= _search; dx++) {
      var total = 0.0;
      for (var y = cy - _half; y <= cy + _half; y++) {
        final row = y * width;
        final shifted = (y + dy) * width + dx;
        for (var x = cx - _half; x <= cx + _half; x++) {
          total += (base.data[row + x] - result.data[shifted + x]).abs();
        }
      }
      final index = (dy + _search) * span + dx + _search;
      cost[index] = total;
      if (total < cost[best]) {
        best = index;
      }
    }
  }
  final bx = best % span;
  final by = best ~/ span;
  if (bx == 0 || by == 0 || bx == span - 1 || by == span - 1) {
    return null;
  }
  // A parabola through the best and its neighbours, for the fraction of a pixel.
  double refine(double before, double at, double after) {
    final curve = before - 2 * at + after;
    return curve > 0 ? (before - after) / (2 * curve) : 0;
  }

  double c(int x, int y) => cost[y * span + x];
  return (
    bx - _search + refine(c(bx - 1, by), c(bx, by), c(bx + 1, by)),
    by - _search + refine(c(bx, by - 1), c(bx, by), c(bx, by + 1)),
  );
}

// Least squares: shift = slope·position + intercept. With the positions bunched together, only
// the intercept.
(double, double) _fit(List<(double, double)> points, int extent) {
  final n = points.length;
  final meanP = points.fold(0.0, (s, p) => s + p.$1) / n;
  final meanS = points.fold(0.0, (s, p) => s + p.$2) / n;
  final spread = points.map((p) => p.$1).reduce(max) - points.map((p) => p.$1).reduce(min);
  if (spread < extent * 0.25) {
    return (0, meanS);
  }
  var covariance = 0.0;
  var variance = 0.0;
  for (final (p, v) in points) {
    covariance += (p - meanP) * (v - meanS);
    variance += (p - meanP) * (p - meanP);
  }
  final slope = covariance / variance;
  return (slope, meanS - slope * meanP);
}

// Whether any of [changed] (above 0) is within [reach] px of (cx, cy): a summed-area table of
// it, so each patch is one lookup.
bool Function(int cx, int cy, int reach) _nearChange(Grey? changed) {
  if (changed == null) {
    return (_, _, _) => false;
  }
  final Grey(:width, :height, :data) = changed;
  final table = Float64List((width + 1) * (height + 1));
  for (var y = 0; y < height; y++) {
    var row = 0.0;
    for (var x = 0; x < width; x++) {
      row += data[y * width + x] > 0 ? 1 : 0;
      table[(y + 1) * (width + 1) + x + 1] = table[y * (width + 1) + x + 1] + row;
    }
  }
  double at(int x, int y) => table[y * (width + 1) + x];
  return (cx, cy, reach) {
    final x0 = max(0, cx - reach);
    final y0 = max(0, cy - reach);
    final x1 = min(width, cx + reach + 1);
    final y1 = min(height, cy + reach + 1);
    return at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0) > 0;
  };
}

/// The alignment of [edited] to [photo] (two pictures of the same size), from patches away from
/// [changed] (the highlighted area as a mask of the same size, which the edit changed). Null
/// when too few patches have texture to match: then there's nothing a misaligned edge would
/// show against either.
AiAlignment? estimateAlignment(Grey photo, Grey edited, Grey? changed) {
  final base = _detailOf(photo);
  final result = _detailOf(edited);
  final width = base.width;
  final height = base.height;
  const margin = _half + _search + 1;
  final near = _nearChange(changed);
  var found = <({int x, int y, double dx, double dy})>[];
  for (var row = 0; row < _rows; row++) {
    for (var column = 0; column < _columns; column++) {
      final x = (margin + (width - 2 * margin) * (column + 0.5) / _columns).round();
      final y = (margin + (height - 2 * margin) * (row + 0.5) / _rows).round();
      if (near(x, y, margin)) {
        continue;
      }
      final shift = _match(base, result, x, y);
      if (shift != null) {
        found.add((x: x, y: y, dx: shift.$1, dy: shift.$2));
      }
    }
  }
  if (found.length < _minPatches) {
    return null;
  }

  ({double ax, double bx, double ay, double by, List<double> misses}) solve() {
    final (ax, bx) = _fit([for (final p in found) (p.x.toDouble(), p.dx)], width);
    final (ay, by) = _fit([for (final p in found) (p.y.toDouble(), p.dy)], height);
    final misses = [for (final p in found) sqrt(pow(p.dx - (ax * p.x + bx), 2) + pow(p.dy - (ay * p.y + by), 2))];
    return (ax: ax, bx: bx, ay: ay, by: by, misses: misses);
  }

  var fitted = solve();
  // Patches that matched something else (a changed object, a repeating pattern) are dropped, once.
  final median = ([...fitted.misses]..sort())[fitted.misses.length ~/ 2];
  final kept = [
    for (final (i, p) in found.indexed)
      if (fitted.misses[i] <= max(1.0, 3 * median)) p,
  ];
  if (kept.length >= _minPatches && kept.length < found.length) {
    found = kept;
    fitted = solve();
  }
  final error = sqrt(fitted.misses.fold(0.0, (s, m) => s + m * m) / fitted.misses.length) / width;
  // The photo's x is at x + ax·x + bx in the result (the patch at x matched there).
  return AiAlignment(
    1 + fitted.ax,
    fitted.bx / width,
    1 + fitted.ay,
    fitted.by / height,
    error: error,
    patches: found.length,
  );
}
