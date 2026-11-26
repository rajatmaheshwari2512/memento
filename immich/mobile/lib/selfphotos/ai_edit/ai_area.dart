// SelfPhotos AI tools: highlighting an area, and pasting just that area back.
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.service.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_export.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_native.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_align.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_tools.dart';
import 'package:path/path.dart' as p;

class AiStroke {
  final List<Offset> points;
  final double radius;

  const AiStroke(this.points, this.radius);
}

/// The AI's result can't be pasted.
class ShapeChangedException implements Exception {
  final AiAlignment? alignment;

  const ShapeChangedException([this.alignment]);
}

enum AiRefusal { shape, failed }

/// As the web's refusalOf (ai-area.ts).
AiRefusal refusalOf(Object error) => error is ShapeChangedException ? AiRefusal.shape : AiRefusal.failed;

class NeedsOriginalException implements Exception {
  const NeedsOriginalException();
}

/// For a first highlighted edit.
Future<({Uint8List jpeg, ui.Image image})> uprightPhoto(
  RemoteAsset asset,
  AiAreaSettings area, {
  AdjustService service = const AdjustService(),
  AdjustNative native = const AdjustNative(),
}) async {
  final photo = await exportFullSize(
    asset,
    service: service,
    native: native,
    png: false,
    quality: (area.photoQuality * 100).round(),
    outputOf: (source) {
      if (!isFullSize(source, asset.width, asset.height)) {
        throw const NeedsOriginalException();
      }
      return _fit(source, area.photoLongSide);
    },
    drawTile: (native, tile, source, output) async {
      final texture = sourceRect(tile, output, source, 0);
      final part = await imageFromPixels(await native.read(texture), texture.width, texture.height);
      final ui.Image drawn;
      try {
        drawn = await _draw(
          AdjustSize(tile.width, tile.height),
          (canvas) => canvas.drawImageRect(
            part,
            Rect.fromLTWH(0, 0, texture.width.toDouble(), texture.height.toDouble()),
            Rect.fromLTWH(
              (texture.x * output.width / source.width) - tile.x,
              (texture.y * output.height / source.height) - tile.y,
              texture.width * output.width / source.width,
              texture.height * output.height / source.height,
            ),
            Paint()..filterQuality = FilterQuality.medium,
          ),
        );
      } finally {
        part.dispose();
      }
      try {
        await native.write(tile, (await drawn.toByteData())!.buffer.asUint8List());
      } finally {
        drawn.dispose();
      }
    },
  );
  final codec = await ui.instantiateImageCodec(photo.bytes);
  try {
    return (jpeg: photo.bytes, image: (await codec.getNextFrame()).image);
  } finally {
    codec.dispose();
  }
}

/// Whether the AI kept the photo's shape (it returns its own size class, e.g. 3050×1408 for
/// 3120×1440).
bool sameShape(AdjustSize result, AdjustSize original, double tolerance) =>
    ((result.width / result.height) / (original.width / original.height) - 1).abs() <= tolerance;

AdjustSize _fit(AdjustSize size, int longSide) {
  final scale = min(1.0, longSide / max(size.width, size.height));
  return AdjustSize(max(1, (size.width * scale).round()), max(1, (size.height * scale).round()));
}

/// The strokes, filled in one colour, on a canvas of [size].
void paintStrokes(Canvas canvas, List<AiStroke> strokes, Size size, Color colour) {
  final longer = max(size.width, size.height);
  for (final stroke in strokes) {
    if (stroke.points.isEmpty) {
      continue;
    }
    final r = stroke.radius * longer;
    final at = [for (final point in stroke.points) Offset(point.dx * size.width, point.dy * size.height)];
    if (at.length == 1) {
      canvas.drawCircle(at.first, r, Paint()..color = colour);
      continue;
    }
    final path = Path()..moveTo(at.first.dx, at.first.dy);
    for (final point in at.skip(1)) {
      path.lineTo(point.dx, point.dy);
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = colour
        ..style = PaintingStyle.stroke
        ..strokeWidth = r * 2
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }
}

Future<ui.Image> _draw(AdjustSize size, void Function(Canvas canvas) draw) {
  final recorder = ui.PictureRecorder();
  draw(Canvas(recorder));
  final picture = recorder.endRecording();
  return picture.toImage(size.width, size.height).whenComplete(picture.dispose);
}

/// The copy the AI gets with the photo.
Future<Uint8List> markedCopy(
  ui.Image image,
  List<AiStroke> strokes,
  AiAreaSettings area, {
  AdjustNative native = const AdjustNative(),
}) async {
  final size = _fit(AdjustSize(image.width, image.height), area.markLongSide);
  final bounds = Rect.fromLTWH(0, 0, size.width.toDouble(), size.height.toDouble());
  final marked = await _draw(size, (canvas) {
    canvas.drawImageRect(
      image,
      Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()),
      bounds,
      Paint()..filterQuality = FilterQuality.medium,
    );
    canvas.saveLayer(bounds, Paint()..color = Color.fromRGBO(0, 0, 0, area.tintAlpha));
    paintStrokes(canvas, strokes, bounds.size, area.tintColor);
    canvas.restore();
  });
  final folder = await Directory.systemTemp.createTemp('selfphotos-mark-');
  try {
    final pixels = await marked.toByteData();
    await native.createOutput(size);
    await native.write(AdjustRect(0, 0, size.width, size.height), pixels!.buffer.asUint8List());
    final file = File(p.join(folder.path, 'mark.jpg'));
    await native.encode(file.path, png: false, quality: (area.markQuality * 100).round());
    return await file.readAsBytes();
  } finally {
    marked.dispose();
    await native.close();
    await folder.delete(recursive: true);
  }
}

/// Softens a mask's edges: three box blurs, about a Gaussian's.
Float32List feather(Float32List alpha, int width, int height, int radius) {
  var soft = alpha;
  for (var n = 0; n < 3; n++) {
    soft = boxBlur(soft, width, height, radius);
  }
  return soft;
}

/// The highlighted area: white with soft edges on transparent, small (it's stretched to any size),
/// and the part of the photo it covers (0–1), or null when it covers nothing.
class AiMask {
  final ui.Image image;
  final Rect? bounds;

  const AiMask(this.image, this.bounds);

  void dispose() => image.dispose();
}

Future<AiMask> areaMask(List<AiStroke> strokes, AdjustSize shape, AiAreaSettings area) async {
  final size = _fit(shape, area.maskLongSide);
  final drawn = await _draw(
    size,
    (canvas) =>
        paintStrokes(canvas, strokes, Size(size.width.toDouble(), size.height.toDouble()), const Color(0xFFFFFFFF)),
  );
  final pixels = (await drawn.toByteData())!.buffer.asUint8List();
  drawn.dispose();
  final alpha = Float32List(size.width * size.height);
  for (var i = 0; i < alpha.length; i++) {
    alpha[i] = pixels[i * 4 + 3].toDouble();
  }
  final soft = feather(alpha, size.width, size.height, max(1, (area.feather * max(size.width, size.height)).round()));
  var (x0, y0, x1, y1) = (size.width, size.height, -1, -1);
  final out = Uint8List(alpha.length * 4);
  for (var y = 0; y < size.height; y++) {
    for (var x = 0; x < size.width; x++) {
      final value = soft[y * size.width + x].round().clamp(0, 255);
      out.setAll((y * size.width + x) * 4, [value, value, value, value]);
      if (value > 0) {
        (x0, y0, x1, y1) = (min(x0, x), min(y0, y), max(x1, x), max(y1, y));
      }
    }
  }
  final bounds = x1 < 0
      ? null
      : Rect.fromLTRB(x0 / size.width, y0 / size.height, (x1 + 1) / size.width, (y1 + 1) / size.height);
  return AiMask(await imageFromPixels(out, size.width, size.height), bounds);
}

// [image] shrunk to [size] (smoothly), one value per pixel from its RGBA.
Future<Grey> _valuesOf(ui.Image image, AdjustSize size, double Function(Uint8List rgba, int i) value) async {
  final drawn = await _draw(
    size,
    (canvas) => canvas.drawImageRect(
      image,
      Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()),
      Rect.fromLTWH(0, 0, size.width.toDouble(), size.height.toDouble()),
      Paint()..filterQuality = FilterQuality.medium,
    ),
  );
  try {
    final pixels = (await drawn.toByteData())!.buffer.asUint8List();
    final values = Float32List(size.width * size.height);
    for (var i = 0; i < values.length; i++) {
      values[i] = value(pixels, i * 4);
    }
    return Grey(size.width, size.height, values);
  } finally {
    drawn.dispose();
  }
}

Future<Grey> _greyOf(ui.Image image, AdjustSize size) =>
    _valuesOf(image, size, (rgba, i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);

Future<AiAlignment> alignFor(ui.Image base, ui.Image result, List<AiStroke> strokes, AiAreaSettings area) async {
  final shape = AdjustSize(base.width, base.height);
  if (!sameShape(AdjustSize(result.width, result.height), shape, area.shapeTolerance)) {
    throw const ShapeChangedException();
  }
  final size = _fit(shape, area.alignLongSide);
  final photo = await _greyOf(base, size);
  final edited = await _greyOf(result, size);
  final mask = await areaMask(strokes, size, area);
  final changed = await _valuesOf(mask.image, size, (rgba, i) => rgba[i + 3].toDouble());
  mask.dispose();
  final alignment = await Isolate.run(() => estimateAlignment(photo, edited, changed));
  if (alignment != null && alignment.error > area.maxMisalignment) {
    throw ShapeChangedException(alignment);
  }
  return alignment ?? AiAlignment.identity;
}

/// [result] drawn through [mask] onto [part] (the base's pixels in [tile], of a photo of [size]),
/// lined up by [alignment].
Future<ui.Image> _pasteTile(
  ui.Image part,
  ui.Image result,
  AiMask mask,
  AdjustSize size,
  AdjustRect tile,
  AiAlignment alignment,
) {
  final target = Rect.fromLTWH(0, 0, tile.width.toDouble(), tile.height.toDouble());
  Rect partOf(ui.Image source, AiAlignment a) {
    final sx = source.width / size.width;
    final sy = source.height / size.height;
    return Rect.fromLTWH(
      (tile.x * a.scaleX + a.offsetX * size.width) * sx,
      (tile.y * a.scaleY + a.offsetY * size.height) * sy,
      tile.width * a.scaleX * sx,
      tile.height * a.scaleY * sy,
    );
  }

  return _draw(AdjustSize(tile.width, tile.height), (canvas) {
    canvas.drawImage(part, Offset.zero, Paint());
    canvas.saveLayer(target, Paint());
    canvas.drawImageRect(result, partOf(result, alignment), target, Paint()..filterQuality = FilterQuality.medium);
    canvas.drawImageRect(
      mask.image,
      partOf(mask.image, AiAlignment.identity),
      target,
      Paint()
        ..blendMode = BlendMode.dstIn
        ..filterQuality = FilterQuality.medium,
    );
    canvas.restore();
  });
}

Future<ui.Image> pasteOnto(
  ui.Image base,
  ui.Image result,
  List<AiStroke> strokes,
  AiAreaSettings area, [
  AiAlignment alignment = AiAlignment.identity,
]) async {
  final size = AdjustSize(base.width, base.height);
  if (!sameShape(AdjustSize(result.width, result.height), size, area.shapeTolerance)) {
    throw const ShapeChangedException();
  }
  final mask = await areaMask(strokes, size, area);
  try {
    return await _pasteTile(base, result, mask, size, AdjustRect(0, 0, size.width, size.height), alignment);
  } finally {
    mask.dispose();
  }
}

/// The copy saved for an edit of a highlighted area.
Future<AdjustExport> pasteBack(
  RemoteAsset asset,
  ui.Image result,
  List<AiStroke> strokes,
  AiAreaSettings area,
  AiAlignment alignment, {
  void Function(double done)? onProgress,
  AdjustService service = const AdjustService(),
  AdjustNative native = const AdjustNative(),
}) async {
  final mask = await areaMask(strokes, AdjustSize(result.width, result.height), area);
  try {
    return await exportFullSize(
      asset,
      service: service,
      native: native,
      onProgress: onProgress,
      outputOf: (source) {
        if (!isFullSize(source, asset.width, asset.height)) {
          throw const NeedsOriginalException();
        }
        if (!sameShape(AdjustSize(result.width, result.height), source, area.shapeTolerance)) {
          throw const ShapeChangedException();
        }
        return source;
      },
      drawTile: (native, tile, source, output) async {
        final pixels = await native.read(tile);
        final bounds = mask.bounds;
        final covered =
            bounds != null &&
            Rect.fromLTWH(
              tile.x / output.width,
              tile.y / output.height,
              tile.width / output.width,
              tile.height / output.height,
            ).overlaps(bounds.inflate(2 / min(output.width, output.height)));
        if (!covered) {
          await native.write(tile, pixels);
          return;
        }
        final part = await imageFromPixels(pixels, tile.width, tile.height);
        final ui.Image pasted;
        try {
          pasted = await _pasteTile(part, result, mask, output, tile, alignment);
        } finally {
          part.dispose();
        }
        try {
          final bytes = await pasted.toByteData();
          await native.write(tile, bytes!.buffer.asUint8List());
        } finally {
          pasted.dispose();
        }
      },
    );
  } finally {
    mask.dispose();
  }
}
