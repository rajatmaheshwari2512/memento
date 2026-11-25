#!/usr/bin/env python3
# SelfPhotos Adjust: makes adjust-geometry-parity.json, the values both apps' tests check
# (web: adjust-geometry.spec.ts; Android: test/selfphotos/adjust_test.dart): perspective's warp,
# its crop (with straighten) and the saved photo's size. Its own copy of the maths, so neither
# app's code is the source of truth. After a deliberate change to the maths, change it here too:
#   python3 -I adjust-geometry-parity.py > adjust-geometry-parity.json
#   npx prettier --write src/lib/ai-edit/adjust/adjust-geometry-parity.json   (from web/)
#
# The crop (adjust-geometry.ts explains it at more length): in the crop's own frame (turned with
# the angle), a rectangle inside the warped photo and around the four corners' rectangle (if the
# angle turns that rectangle past the photo's edges, around as much of it as fits, kept centred):
# the photo's own shape if one of those has it, else the shape closest to it; of that shape the
# largest, then the middle. A rectangle is (x, y, width, height); each condition is
# a·(x, y, width, height) ≤ limit. The shapes allowed run between those of the corners (where four
# conditions meet); a shape between them is tallest where three meet, its width ratio·height.
import itertools, json, math


def js_round(value):  # as Math.round and Dart's round() do for positive values (not halves to even)
    return math.floor(value + 0.5)


def crop_scale(degrees, width, height):
    radians = abs(degrees) * math.pi / 180
    return 1 / (math.cos(radians) + max(width / height, height / width) * math.sin(radians))


def rotation(degrees):
    radians = degrees * math.pi / 180
    return math.cos(radians), math.sin(radians)


def distance(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def project(m, p):
    w = m[6] * p[0] + m[7] * p[1] + m[8]
    return ((m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w)


def invert(m):
    a, b, c, d, e, f, g, h, i = m
    A, B, C = e * i - f * h, f * g - d * i, d * h - e * g
    det = a * A + b * B + c * C
    return [A / det, (c * h - b * i) / det, (b * f - c * e) / det,
            B / det, (a * i - c * g) / det, (c * d - a * f) / det,
            C / det, (b * g - a * h) / det, (a * e - b * d) / det]


def in_pixels(quad, size):
    return [(x * size[0], y * size[1]) for x, y in quad]


def marked_size(quad, size):
    p0, p1, p2, p3 = in_pixels(quad, size)
    return (distance(p0, p1) + distance(p3, p2)) / 2, (distance(p0, p3) + distance(p1, p2)) / 2


def perspective_matrix(quad, size):
    p0, p1, p2, p3 = in_pixels(quad, size)
    width, height = marked_size(quad, size)
    sx, sy = p0[0] - p1[0] + p2[0] - p3[0], p0[1] - p1[1] + p2[1] - p3[1]
    dx1, dx2, dy1, dy2 = p1[0] - p2[0], p3[0] - p2[0], p1[1] - p2[1], p3[1] - p2[1]
    den = dx1 * dy2 - dx2 * dy1
    g, h = (sx * dy2 - dx2 * sy) / den, (dx1 * sy - sx * dy1) / den
    return [(p1[0] - p0[0] + g * p1[0]) / width, (p3[0] - p0[0] + h * p3[0]) / height, p0[0],
            (p1[1] - p0[1] + g * p1[1]) / width, (p3[1] - p0[1] + h * p3[1]) / height, p0[1],
            g / width, h / height, 1]


PHOTO = [(0, 0), (1, 0), (1, 1), (0, 1)]


def is_valid(quad):
    if any(not (0 <= x <= 1 and 0 <= y <= 1) for x, y in quad):
        return False
    if any(not (cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) >= 0.01) for i in range(4)):
        return False
    m = invert(perspective_matrix(quad, (1, 1)))
    depths = [m[6] * x + m[7] * y + m[8] for x, y in PHOTO]
    sign = lambda v: (v > 0) - (v < 0)
    return all(sign(d) == sign(depths[0]) for d in depths) and min(map(abs, depths)) >= 0.1 * max(map(abs, depths))


def det3(c0, c1, c2):  # columns
    return (c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1])
            + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]))


def det4(rows):
    total = 0
    for j in range(4):
        minor = [[row[k] for k in range(4) if k != j] for row in rows[1:]]
        total += (-1) ** j * rows[0][j] * det3(*minor)
    return total


def conditions(to_photo, degrees, size, marked):
    from_photo = invert(to_photo)
    c, s = rotation(degrees)
    turn = lambda p: (c * p[0] - s * p[1], s * p[0] + c * p[1])
    outline = [turn(project(from_photo, (x * size[0], y * size[1]))) for x, y in PHOTO]
    corners = [turn((x * marked[0], y * marked[1])) for x, y in PHOTO]
    area = sum(cross((0, 0), outline[i], outline[(i + 1) % 4]) for i in range(4))
    sides = []
    for i in range(4):
        a, b = outline[i], outline[(i + 1) % 4]
        length = distance(a, b) * (1 if area > 0 else -1)
        n = ((b[1] - a[1]) / length, (a[0] - b[0]) / length)
        sides.append((n, n[0] * a[0] + n[1] * a[1]))
    xs, ys = [p[0] for p in corners], [p[1] for p in corners]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    hx, hy = (max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2
    fit = min([1] + [(d - n[0] * cx - n[1] * cy) / (abs(n[0]) * hx + abs(n[1]) * hy) for n, d in sides])
    rows = [[n[0], n[1], max(n[0], 0), max(n[1], 0), d] for n, d in sides]
    rows += [[1, 0, 0, 0, cx - fit * hx], [-1, 0, -1, 0, -(cx + fit * hx)],
             [0, 1, 0, 0, cy - fit * hy], [0, -1, 0, -1, -(cy + fit * hy)]]
    return rows, [cx - fit * hx, cy - fit * hy, 2 * fit * hx, 2 * fit * hy]


def fits(rows, tolerance):
    return lambda z: all(r[0] * z[0] + r[1] * z[1] + r[2] * z[2] + r[3] * z[3] <= r[4] + tolerance for r in rows)


def corners(rows, tolerance):
    found = []
    for four in itertools.combinations(rows, 4):
        det = det4([r[:4] for r in four])
        if abs(det) < 1e-12:
            continue
        z = [det4([[r[4] if k == j else r[k] for k in range(4)] for r in four]) / det for j in range(4)]
        if z[2] > 0 and z[3] > 0 and fits(rows, tolerance)(z):
            found.append(z)
    return found


def of_shape(rows, ratio, tolerance):
    found = []
    for three in itertools.combinations(rows, 3):
        col = lambda k: [r[k] for r in three]
        across = [r[2] * ratio + r[3] for r in three]
        det = det3(col(0), col(1), across)
        if abs(det) < 1e-12:
            continue
        height = det3(col(0), col(1), col(4)) / det
        z = [det3(col(4), col(1), across) / det, det3(col(0), col(4), across) / det, ratio * height, height]
        if height > 0 and fits(rows, tolerance)(z):
            found.append(z)
    return found


def pick(rows, fallback, size):
    tolerance = 1e-9 * max(size)
    found = corners(rows, tolerance) or [fallback]
    shape = size[0] / size[1]
    ratios = [z[2] / z[3] for z in found]
    best = of_shape(rows, shape, tolerance) if min(ratios) < shape < max(ratios) else []
    if not best:
        off = lambda z: abs(math.log(z[2] / z[3] / shape))
        closest = min(off(z) for z in found)
        best = [z for z in found if off(z) <= closest + 1e-9]
    tallest = max(z[3] for z in best)
    best = [z for z in best if z[3] >= tallest * (1 - 1e-9)]
    middle = lambda k: (min(z[k] + z[k + 2] / 2 for z in best) + max(z[k] + z[k + 2] / 2 for z in best)) / 2
    return middle(0), middle(1), best[0][2], best[0][3]


def framing(degrees, size, quad):
    to_photo = perspective_matrix(quad, size)
    rows, fallback = conditions(to_photo, degrees, size, marked_size(quad, size))
    ux, uy, width, height = pick(rows, fallback, size)
    c, s = rotation(degrees)
    return {'scale': [width / size[0], height / size[1]], 'centre': [c * ux + s * uy, -s * ux + c * uy],
            'rotation': [c, s], 'toPhoto': to_photo}


def output_size(view, size):
    sx, sy = view['scale']
    shrink = min(1, 1 / math.sqrt(sx * sy))
    return {'width': max(1, js_round(size[0] * sx * shrink)), 'height': max(1, js_round(size[1] * sy * shrink))}


def to_source(x, y, output, size, view):
    c, s = view['rotation']
    qx = (x / output['width'] - 0.5) * size[0] * view['scale'][0]
    qy = (y / output['height'] - 0.5) * size[1] * view['scale'][1]
    turned = (view['centre'][0] + qx * c + qy * s, view['centre'][1] + qy * c - qx * s)
    return list(project(view['toPhoto'], turned))


# Each with the crop's shape it should have: the photo's own ('own'), or not but within 2% of it
# ('near'), or whichever is closest (None).
CASES = [
    ('a building shot from below', (4000, 3000), 0, [[0.2, 0.05], [0.8, 0.05], [1, 0.95], [0, 0.95]], None),
    ('the same, also straightened: around as much of it as fits', (4000, 3000), 3.5,
     [[0.2, 0.05], [0.8, 0.05], [1, 0.95], [0, 0.95]], None),
    ('the same on the preview', (1440, 1080), 3.5, [[0.2, 0.05], [0.8, 0.05], [1, 0.95], [0, 0.95]], None),
    ('a wall seen from the side, portrait', (3000, 4000), -2, [[0.05, 0.1], [0.95, 0], [0.95, 1], [0.05, 0.9]],
     'near'),
    ('the same wall, unturned: no 3:4 crop holds it, so a little wider', (3000, 4000), 0,
     [[0.05, 0.1], [0.95, 0], [0.95, 1], [0.05, 0.9]], 'near'),
    ('uneven corners', (1920, 1080), 10, [[0.12, 0.2], [0.85, 0.1], [0.9, 0.8], [0.05, 0.95]], 'own'),
    ('the bottom corners left on the photo: the marked area is the copy', (4032, 3024), 0,
     [[0.15, 0], [0.85, 0], [1, 1], [0, 1]], None),
    ('a building in the middle of a landscape photo: still 4:3', (4000, 3000), 0,
     [[0.32, 0.2], [0.68, 0.2], [0.82, 0.9], [0.18, 0.9]], 'own'),
    ("the Android test's building, in a portrait photo: still 3:4", (300, 400), 0,
     [[0.32, 0.2], [0.68, 0.2], [0.82, 0.9], [0.18, 0.9]], 'own'),
    ('a rectangle of corners: the whole photo', (4032, 3024), 0, [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
     'own'),
    ("a rectangle of corners, turned: the photo's shape around it", (4032, 3024), 3,
     [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], 'own'),
]

INVALID = [
    ('crossed (a bow tie)', [[0, 0], [1, 1], [1, 0], [0, 1]]),
    ('three in a line', [[0, 0], [0.5, 0], [1, 0], [0, 1]]),
    ('outside the photo', [[-0.1, 0], [1, 0], [1, 1], [0, 1]]),
    ('anticlockwise', [[0, 0], [0, 1], [1, 1], [1, 0]]),
    ('too steep: the top stretched to infinity', [[0.49, 0.6], [0.51, 0.6], [1, 1], [0, 1]]),
    ('too small: about 5% of the photo a side', [[0.5, 0.5], [0.55, 0.5], [0.55, 0.55], [0.5, 0.55]]),
]

cases = []
for name, size, angle, quad, shape in CASES:
    assert is_valid(quad), name
    view = framing(angle, size, quad)
    output = output_size(view, size)
    off = abs(math.log(view['scale'][0] / view['scale'][1]))
    assert (off < 1e-9) if shape == 'own' else (1e-6 < off < 0.02) if shape == 'near' else True, (name, off)
    points = [[0, 0], [output['width'], 0], [output['width'], output['height']], [0, output['height']],
              [output['width'] / 2, output['height'] / 3]]
    cases.append({
        'name': name, 'source': {'width': size[0], 'height': size[1]}, 'angle': angle, 'corners': quad,
        'expected': {
            'toPhoto': view['toPhoto'], 'centre': view['centre'], 'scale': view['scale'], 'output': output,
            'toSource': [{'at': at, 'source': to_source(at[0], at[1], output, size, view)} for at in points],
        },
    })
for name, quad in INVALID:
    assert not is_valid(quad), name
valid = [[[0, 0], [1, 0], [1, 1], [0, 1]]] + [quad for _, _, _, quad, _ in CASES]
print(json.dumps({
    '_comment': "SelfPhotos Adjust: perspective and straighten's geometry (adjust-geometry.ts; Android: adjust_geometry.dart), checked by both apps' tests (web: adjust-geometry.spec.ts; Android: test/selfphotos/adjust_test.dart) to 1e-9 of each value. Made by adjust-geometry-parity.py, not by either app.",
    'cases': cases,
    'invalid': [{'name': name, 'corners': quad} for name, quad in INVALID],
    'valid': valid,
}, indent=2))
