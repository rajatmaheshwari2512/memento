// SelfPhotos Adjust: straighten's and perspective's crop, and the tiles of a full-size render.
// Not part of Immich. The same maths as the web's adjust-geometry.ts (and the shader's
// sourcePosition); web/src/lib/ai-edit/adjust/adjust-geometry-parity.json holds values both are
// checked against.
import 'dart:math';

class AdjustSize {
  final int width;
  final int height;

  const AdjustSize(this.width, this.height);

  @override
  bool operator ==(Object other) => other is AdjustSize && other.width == width && other.height == height;

  @override
  int get hashCode => Object.hash(width, height);

  @override
  String toString() => '${width}x$height';
}

class AdjustRect {
  final int x;
  final int y;
  final int width;
  final int height;

  const AdjustRect(this.x, this.y, this.width, this.height);

  @override
  String toString() => 'AdjustRect($x, $y, $width, $height)';
}

typedef AdjustPoint = (double, double);

/// Perspective: four points the person drags onto lines that should be straight (a building's
/// edges), clockwise from the top left, as shares of the photo's width and height (0..1).
typedef Quad = List<AdjustPoint>;

/// A 3×3 matrix, row by row, for positions (x, y, 1).
typedef Matrix3 = List<double>;

/// Turning a w×h photo by [degrees] leaves empty corners. The largest centred rectangle of
/// the same shape that fits inside the turned photo is this share of its width and height:
/// 1 / (cos + max(w/h, h/w)·sin). 1 at 0°; for a square at 45°, 0.7071.
double cropScale(double degrees, AdjustSize source) {
  final radians = degrees.abs() * pi / 180;
  final ratio = max(source.width / source.height, source.height / source.width);
  return 1 / (cos(radians) + ratio * sin(radians));
}

/// (cos, sin) of the angle, for the shader's uRotation.
(double, double) rotation(double degrees) {
  final radians = degrees * pi / 180;
  return (cos(radians), sin(radians));
}

/// The corners that change nothing: the photo's own.
Quad photoCorners() => [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];

AdjustPoint project(Matrix3 m, AdjustPoint p) {
  final (x, y) = p;
  final w = m[6] * x + m[7] * y + m[8];
  return ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w);
}

Matrix3 invert(Matrix3 m) {
  final [a, b, c, d, e, f, g, h, i] = m;
  final aa = e * i - f * h;
  final bb = f * g - d * i;
  final cc = d * h - e * g;
  final det = a * aa + b * bb + c * cc;
  return [
    aa / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    bb / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    cc / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}

double _cross(AdjustPoint o, AdjustPoint a, AdjustPoint b) =>
    (a.$1 - o.$1) * (b.$2 - o.$2) - (a.$2 - o.$2) * (b.$1 - o.$1);

double _distance(AdjustPoint a, AdjustPoint b) {
  final dx = b.$1 - a.$1;
  final dy = b.$2 - a.$2;
  return sqrt(dx * dx + dy * dy);
}

double _sign(double value) => value > 0 ? 1 : (value < 0 ? -1 : 0);

/// The four corners' rectangle once straightened: its sides as long as theirs, on average (pixels).
(double, double) _markedSize(Quad quad, AdjustSize source) {
  final [p0, p1, p2, p3] = [for (final (x, y) in quad) (x * source.width, y * source.height)];
  return ((_distance(p0, p1) + _distance(p3, p2)) / 2, (_distance(p0, p3) + _distance(p1, p2)) / 2);
}

/// Perspective's warp, the other way round: from a position in the straightened picture (the
/// four corners' rectangle, [_markedSize], its top left at 0, 0) to the photo (pixels). The unit
/// square to the corners (Heckbert's formula), after scaling the rectangle down to it.
Matrix3 perspectiveMatrix(Quad quad, AdjustSize source) {
  final [p0, p1, p2, p3] = [for (final (x, y) in quad) (x * source.width, y * source.height)];
  final (width, height) = _markedSize(quad, source);
  final sx = p0.$1 - p1.$1 + p2.$1 - p3.$1;
  final sy = p0.$2 - p1.$2 + p2.$2 - p3.$2;
  final dx1 = p1.$1 - p2.$1;
  final dx2 = p3.$1 - p2.$1;
  final dy1 = p1.$2 - p2.$2;
  final dy2 = p3.$2 - p2.$2;
  final den = dx1 * dy2 - dx2 * dy1;
  final g = (sx * dy2 - dx2 * sy) / den;
  final h = (dx1 * sy - sx * dy1) / den;
  return [
    (p1.$1 - p0.$1 + g * p1.$1) / width,
    (p3.$1 - p0.$1 + h * p3.$1) / height,
    p0.$1,
    (p1.$2 - p0.$2 + g * p1.$2) / width,
    (p3.$2 - p0.$2 + h * p3.$2) / height,
    p0.$2,
    g / width,
    h / height,
    1,
  ];
}

/// How sharply each corner must turn (the cross product of its two sides, in shares of the
/// photo): keeps the corners a real four-sided shape, not a sliver or a bow tie.
const _minTurn = 0.01;

/// How far the warp may stretch one side of the photo against the other: 10 times.
const _minDepth = 0.1;

/// Whether the corners make a warp the photo survives: inside the photo, in order and turning
/// the same way (a convex shape of some size), and with the whole photo still in front after the
/// warp (none of it stretched to infinity), so its corners can be cropped to a rectangle.
bool isValidPerspective(Quad quad) {
  if (quad.length != 4 || quad.any((p) => !(p.$1 >= 0 && p.$1 <= 1 && p.$2 >= 0 && p.$2 <= 1))) {
    return false;
  }
  for (var i = 0; i < 4; i++) {
    if (!(_cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) >= _minTurn)) {
      return false;
    }
  }
  final fromPhoto = invert(perspectiveMatrix(quad, const AdjustSize(1, 1)));
  final depths = [for (final (x, y) in photoCorners()) fromPhoto[6] * x + fromPhoto[7] * y + fromPhoto[8]];
  final nearest = depths.map((d) => d.abs()).reduce(min);
  final farthest = depths.map((d) => d.abs()).reduce(max);
  return depths.every((d) => _sign(d) == _sign(depths[0])) && nearest >= _minDepth * farthest;
}

bool isPhotoCorners(Quad quad) {
  final corners = photoCorners();
  return quad.length == 4 && [for (var i = 0; i < 4; i++) quad[i] == corners[i]].every((same) => same);
}

const Matrix3 identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/// Where each output pixel comes from: the crop's width and height (each a share of the source's),
/// its centre and turn, and perspective's warp to the photo (none without it). The shader's
/// uCropScale, uCropCentre, uRotation and uPerspective rows.
class AdjustFraming {
  final (double, double) scale;
  final AdjustPoint centre;
  final (double, double) rotation;
  final Matrix3? toPhoto;

  const AdjustFraming(this.scale, this.centre, this.rotation, this.toPhoto);
}

/// Without perspective, straighten's centred crop, the photo's own shape. With it, a rectangle
/// that keeps everything inside the four corners and has no empty corners, in the photo's own
/// shape where one can, else in the shape closest to it ([_perspectiveCrop]).
AdjustFraming framing(double degrees, AdjustSize source, [Quad? perspective]) {
  final scale = cropScale(degrees, source);
  final plain = AdjustFraming((scale, scale), (source.width / 2, source.height / 2), rotation(degrees), null);
  if (perspective == null || isPhotoCorners(perspective) || !isValidPerspective(perspective)) {
    return plain;
  }
  final toPhoto = perspectiveMatrix(perspective, source);
  final (crop, centre) = _perspectiveCrop(toPhoto, degrees, source, _markedSize(perspective, source));
  return AdjustFraming(crop, centre, plain.rotation, toPhoto);
}

/// A rectangle in the crop's own frame (the straightened picture, turned with the angle): its top
/// left, width and height. A condition on one: a·(x, y, width, height) ≤ limit, as [...a, limit].
typedef _Box = List<double>;
typedef _Condition = List<double>;

double _det3(List<double> c0, List<double> c1, List<double> c2) =>
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
    c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
    c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);

/// Of four rows of four.
double _det4(List<List<double>> rows) {
  var sum = 0.0;
  for (var j = 0; j < 4; j++) {
    final minor = [
      for (final row in rows.skip(1))
        [
          for (var k = 0; k < 4; k++)
            if (k != j) row[k],
        ],
    ];
    sum += (j.isEven ? 1 : -1) * rows[0][j] * _det3(minor[0], minor[1], minor[2]);
  }
  return sum;
}

/// Perspective's crop: its width and height (shares of the source's) and its centre in the
/// straightened picture. In the crop's frame the photo, warped, is a four-sided shape, and the four
/// corners' rectangle ([marked], straightened) is inside it. The crop is a rectangle inside the
/// shape (no empty corners) and around the marked rectangle (nothing of it cut off): the largest of
/// those with the photo's own shape; if none has it, the largest of those closest to it. Turned
/// with the angle, the marked rectangle may reach past the photo's edges (when corners are on
/// them): then the crop goes around as much of it as fits, kept centred.
((double, double), AdjustPoint) _perspectiveCrop(
  Matrix3 toPhoto,
  double degrees,
  AdjustSize source,
  (double, double) marked,
) {
  final (conditions, fallback) = _cropConditions(toPhoto, degrees, source, marked);
  final [x, y, width, height] = _bestCrop(conditions, fallback, source);
  // Its centre turned back, into the straightened picture.
  final (c, s) = rotation(degrees);
  return ((width / source.width, height / source.height), (c * x + s * y, -s * x + c * y));
}

/// What a crop box must keep to, in the crop's frame: for each side of the warped photo (its
/// outward direction n, of length 1), the box's corner farthest along n stays inside it; and the
/// box goes around the marked rectangle's bounds, shrunk about their centre (by `fit`, at most 1)
/// until they're inside the photo. The second: those bounds, a box that keeps to all of it.
(List<_Condition>, _Box) _cropConditions(Matrix3 toPhoto, double degrees, AdjustSize source, (double, double) marked) {
  final fromPhoto = invert(toPhoto);
  final (c, s) = rotation(degrees);
  AdjustPoint turn(AdjustPoint p) => (c * p.$1 - s * p.$2, s * p.$1 + c * p.$2);
  final outline = [
    for (final (x, y) in photoCorners()) turn(project(fromPhoto, (x * source.width, y * source.height))),
  ];
  final corners = [for (final (x, y) in photoCorners()) turn((x * marked.$1, y * marked.$2))];
  var area = 0.0;
  for (var i = 0; i < 4; i++) {
    area += _cross((0, 0), outline[i], outline[(i + 1) % 4]);
  }
  final sides = [
    for (var i = 0; i < 4; i++)
      () {
        final a = outline[i];
        final b = outline[(i + 1) % 4];
        final length = _distance(a, b) * (area > 0 ? 1 : -1);
        final n = ((b.$2 - a.$2) / length, (a.$1 - b.$1) / length);
        return (n: n, d: n.$1 * a.$1 + n.$2 * a.$2);
      }(),
  ];
  final xs = corners.map((p) => p.$1);
  final ys = corners.map((p) => p.$2);
  final cx = (xs.reduce(min) + xs.reduce(max)) / 2;
  final cy = (ys.reduce(min) + ys.reduce(max)) / 2;
  final hx = (xs.reduce(max) - xs.reduce(min)) / 2;
  final hy = (ys.reduce(max) - ys.reduce(min)) / 2;
  final fit = [
    1.0,
    for (final (:n, :d) in sides) (d - n.$1 * cx - n.$2 * cy) / (n.$1.abs() * hx + n.$2.abs() * hy),
  ].reduce(min);
  return (
    [
      for (final (:n, :d) in sides) [n.$1, n.$2, max(n.$1, 0.0), max(n.$2, 0.0), d],
      [1, 0, 0, 0, cx - fit * hx],
      [-1, 0, -1, 0, -(cx + fit * hx)],
      [0, 1, 0, 0, cy - fit * hy],
      [0, -1, 0, -1, -(cy + fit * hy)],
    ],
    [cx - fit * hx, cy - fit * hy, 2 * fit * hx, 2 * fit * hy],
  );
}

bool Function(_Box) _keepsTo(List<_Condition> conditions, double tolerance) =>
    (box) => conditions.every((c) => c[0] * box[0] + c[1] * box[1] + c[2] * box[2] + c[3] * box[3] <= c[4] + tolerance);

/// The corners of what's allowed: boxes where four conditions meet, keeping to every condition.
List<_Box> _cropCorners(List<_Condition> conditions, double tolerance) {
  final keeps = _keepsTo(conditions, tolerance);
  final found = <_Box>[];
  final count = conditions.length;
  for (var i = 0; i < count; i++) {
    for (var j = i + 1; j < count; j++) {
      for (var k = j + 1; k < count; k++) {
        for (var l = k + 1; l < count; l++) {
          final four = [conditions[i], conditions[j], conditions[k], conditions[l]];
          final det = _det4([for (final c in four) c.sublist(0, 4)]);
          if (det.abs() < 1e-12) {
            continue;
          }
          final box = [
            for (var column = 0; column < 4; column++)
              _det4([
                    for (final c in four) [for (var m = 0; m < 4; m++) m == column ? c[4] : c[m]],
                  ]) /
                  det,
          ];
          if (box[2] > 0 && box[3] > 0 && keeps(box)) {
            found.add(box);
          }
        }
      }
    }
  }
  return found;
}

/// The boxes of one shape (width ratio·height) that could be the tallest: where three conditions
/// meet, with the width written as ratio·height, keeping to every condition.
List<_Box> _cropsOfShape(List<_Condition> conditions, double ratio, double tolerance) {
  final keeps = _keepsTo(conditions, tolerance);
  final found = <_Box>[];
  final count = conditions.length;
  for (var i = 0; i < count; i++) {
    for (var j = i + 1; j < count; j++) {
      for (var k = j + 1; k < count; k++) {
        final three = [conditions[i], conditions[j], conditions[k]];
        List<double> column(int m) => [for (final c in three) c[m]];
        final across = [for (final c in three) c[2] * ratio + c[3]];
        final det = _det3(column(0), column(1), across);
        if (det.abs() < 1e-12) {
          continue;
        }
        final height = _det3(column(0), column(1), column(4)) / det;
        final box = [
          _det3(column(4), column(1), across) / det,
          _det3(column(0), column(4), across) / det,
          ratio * height,
          height,
        ];
        if (height > 0 && keeps(box)) {
          found.add(box);
        }
      }
    }
  }
  return found;
}

/// The winner. What's allowed is convex, so the shapes it allows run from the narrowest of its
/// corners to the widest, every one between them included: the photo's own shape if it's between,
/// else the nearer end (there, only corners have that shape). Of that shape, the tallest (so the
/// largest); of those (the same box, able to slide), the one in the middle. Returns its centre,
/// width and height.
_Box _bestCrop(List<_Condition> conditions, _Box fallback, AdjustSize source) {
  final tolerance = 1e-9 * max(source.width, source.height);
  final corners = _cropCorners(conditions, tolerance);
  final found = corners.isNotEmpty ? corners : [fallback];
  final shape = source.width / source.height;
  final ratios = [for (final box in found) box[2] / box[3]];
  var best = ratios.reduce(min) < shape && shape < ratios.reduce(max)
      ? _cropsOfShape(conditions, shape, tolerance)
      : <_Box>[];
  if (best.isEmpty) {
    double offShape(_Box box) => log(box[2] / box[3] / shape).abs();
    final closest = found.map(offShape).reduce(min);
    best = found.where((box) => offShape(box) <= closest + 1e-9).toList();
  }
  final tallest = best.map((box) => box[3]).reduce(max);
  best = best.where((box) => box[3] >= tallest * (1 - 1e-9)).toList();
  double middle(int axis) {
    final centres = best.map((box) => box[axis] + box[axis + 2] / 2);
    return (centres.reduce(min) + centres.reduce(max)) / 2;
  }

  return [middle(0), middle(1), best[0][2], best[0][3]];
}

/// The saved photo's size: the crop at the source's own resolution, never more pixels than the
/// source (perspective's crop may be another shape, so it may be longer on one side).
AdjustSize outputSize(double degrees, AdjustSize source, [Quad? perspective]) {
  final (sx, sy) = framing(degrees, source, perspective).scale;
  final shrink = min(1.0, 1 / sqrt(sx * sy));
  return AdjustSize(max(1, (source.width * sx * shrink).round()), max(1, (source.height * sy * shrink).round()));
}

/// Where an output position (pixels) is in the source (pixels).
AdjustPoint _sourcePosition(double x, double y, AdjustSize output, AdjustSize source, AdjustFraming view) {
  final (c, s) = view.rotation;
  final (sx, sy) = view.scale;
  final qx = (x / output.width - 0.5) * source.width * sx;
  final qy = (y / output.height - 0.5) * source.height * sy;
  final turned = (view.centre.$1 + qx * c + qy * s, view.centre.$2 + qy * c - qx * s);
  final toPhoto = view.toPhoto;
  return toPhoto == null ? turned : project(toPhoto, turned);
}

AdjustPoint toSource(double x, double y, AdjustSize output, AdjustSize source, double degrees, [Quad? perspective]) =>
    _sourcePosition(x, y, output, source, framing(degrees, source, perspective));

/// The output cut into tiles of at most [size]×[size], row by row.
List<AdjustRect> tiles(AdjustSize output, int size) => [
  for (var y = 0; y < output.height; y += size)
    for (var x = 0; x < output.width; x += size)
      AdjustRect(x, y, min(size, output.width - x), min(size, output.height - y)),
];

/// The part of the source a tile shows: the box around its turned (and warped) corners, plus
/// [pad] pixels for smooth sampling, inside the source, on whole pixels. Perspective keeps
/// straight lines straight, so the corners are enough.
AdjustRect _partOf(AdjustRect tile, AdjustSize output, AdjustSize source, AdjustFraming view, int pad) {
  final corners = [
    _sourcePosition(tile.x.toDouble(), tile.y.toDouble(), output, source, view),
    _sourcePosition((tile.x + tile.width).toDouble(), tile.y.toDouble(), output, source, view),
    _sourcePosition(tile.x.toDouble(), (tile.y + tile.height).toDouble(), output, source, view),
    _sourcePosition((tile.x + tile.width).toDouble(), (tile.y + tile.height).toDouble(), output, source, view),
  ];
  final xs = corners.map((c) => c.$1);
  final ys = corners.map((c) => c.$2);
  final x0 = max(0, xs.reduce(min).floor() - pad);
  final y0 = max(0, ys.reduce(min).floor() - pad);
  final x1 = min(source.width, xs.reduce(max).ceil() + pad);
  final y1 = min(source.height, ys.reduce(max).ceil() + pad);
  return AdjustRect(x0, y0, max(1, x1 - x0), max(1, y1 - y0));
}

AdjustRect sourceRect(
  AdjustRect tile,
  AdjustSize output,
  AdjustSize source,
  double degrees, {
  Quad? perspective,
  int pad = 2,
}) => _partOf(tile, output, source, framing(degrees, source, perspective), pad);

/// Perspective can make a tile's part of the source larger than the tile (where the warp shrinks
/// the photo): the tile size halved until every tile's part is at most [limit] on a side.
int tileSizeWithin(AdjustSize output, AdjustSize source, double degrees, Quad? perspective, int size, int limit) {
  final view = framing(degrees, source, perspective);
  bool tooBig(AdjustRect tile) {
    final part = _partOf(tile, output, source, view, 2);
    return part.width > limit || part.height > limit;
  }

  var fitting = size;
  while (fitting > 64 && tiles(output, fitting).any(tooBig)) {
    fitting ~/= 2;
  }
  return fitting;
}
