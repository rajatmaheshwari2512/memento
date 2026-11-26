// SelfPhotos Adjust's Markup for Android.
import 'dart:convert';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';

class MarkupColour {
  final Color fill;

  /// Text in this colour gets a thin outline in this one.
  final Color outline;

  const MarkupColour(this.fill, this.outline);
}

/// A size: a line's width and a new text's size.
class MarkupSize {
  final double width;
  final double text;

  const MarkupSize(this.width, this.text);
}

/// adjust-markup.json, which the web reads too.
class MarkupConfig {
  final List<MarkupColour> colours;
  final List<MarkupSize> sizes;
  final double highlighterOpacity;
  final double highlighterWidthScale;

  /// Arrow heads: [arrowHeadLength] times the line's width long (at most [arrowMaxHeadShare] of the
  /// arrow), each side [arrowHeadAngle] degrees from the line.
  final double arrowHeadAngle;
  final double arrowHeadLength;
  final double arrowMaxHeadShare;
  final String font;
  final FontWeight weight;
  final int maxLength;
  final double minTextSize;
  final double maxTextSize;

  /// The text's outline, as a share of its size.
  final double textOutline;

  /// A line's points are kept only this far apart (a share of the picture).
  final double minStep;

  const MarkupConfig({
    required this.colours,
    required this.sizes,
    required this.highlighterOpacity,
    required this.highlighterWidthScale,
    required this.arrowHeadAngle,
    required this.arrowHeadLength,
    required this.arrowMaxHeadShare,
    required this.font,
    required this.weight,
    required this.maxLength,
    required this.minTextSize,
    required this.maxTextSize,
    required this.textOutline,
    required this.minStep,
  });

  static Color _hex(Object? value) => Color(0xff000000 | int.parse((value! as String).substring(1), radix: 16));
  static double _number(Map<String, Object?> json, String key) => (json[key]! as num).toDouble();

  factory MarkupConfig.parse(String source) {
    final json = jsonDecode(source) as Map<String, Object?>;
    final arrow = json['arrow']! as Map<String, Object?>;
    final highlighter = json['highlighter']! as Map<String, Object?>;
    final text = json['text']! as Map<String, Object?>;
    return MarkupConfig(
      colours: [
        for (final colour in (json['colours']! as List).cast<Map<String, Object?>>())
          MarkupColour(_hex(colour['fill']), _hex(colour['outline'])),
      ],
      sizes: [
        for (final size in (json['sizes']! as List).cast<Map<String, Object?>>())
          MarkupSize(_number(size, 'width'), _number(size, 'text')),
      ],
      highlighterOpacity: _number(highlighter, 'opacity'),
      highlighterWidthScale: _number(highlighter, 'widthScale'),
      arrowHeadAngle: _number(arrow, 'headAngle'),
      arrowHeadLength: _number(arrow, 'headLength'),
      arrowMaxHeadShare: _number(arrow, 'maxHeadShare'),
      font: text['font']! as String,
      weight: FontWeight.values.firstWhere((w) => w.value == text['weight']! as int),
      maxLength: text['maxLength']! as int,
      minTextSize: _number(text, 'minSize'),
      maxTextSize: _number(text, 'maxSize'),
      textOutline: _number(text, 'outline'),
      minStep: _number(json, 'minStep'),
    );
  }

  static Future<MarkupConfig> load() async =>
      MarkupConfig.parse(await rootBundle.loadString('assets/selfphotos/adjust-markup.json'));

  Color outlineOf(Color fill) => colours.where((c) => c.fill == fill).firstOrNull?.outline ?? Colors.black;

  /// A text size within the limits.
  double textSize(double size) => size.clamp(minTextSize, maxTextSize);
}

enum MarkupLineKind { pen, highlighter }

enum MarkupShapeKind { arrow, box, circle }

/// Something drawn on the photo.
@immutable
sealed class MarkupItem {
  final Color colour;

  const MarkupItem(this.colour);
}

class MarkupLine extends MarkupItem {
  final MarkupLineKind kind;
  final double width;
  final List<Offset> points;

  const MarkupLine(this.kind, super.colour, this.width, this.points);
}

class MarkupShape extends MarkupItem {
  final MarkupShapeKind kind;
  final double width;
  final Offset from;
  final Offset to;

  const MarkupShape(this.kind, super.colour, this.width, this.from, this.to);
}

class MarkupText extends MarkupItem {
  final double fontSize;

  /// The middle of the text.
  final Offset at;
  final String text;

  const MarkupText(super.colour, this.fontSize, this.at, this.text);

  MarkupText copyWith({Color? colour, double? fontSize, Offset? at, String? text}) =>
      MarkupText(colour ?? this.colour, fontSize ?? this.fontSize, at ?? this.at, text ?? this.text);
}

/// A width or text size (a share of the longer side) in pixels, on a picture of [size].
double markupPixels(double share, Size size) => share * max(size.width, size.height);

Offset _pixel(Offset point, Size size) => Offset(point.dx * size.width, point.dy * size.height);

/// An arrow from [from] to [to] (pixels), its line [width] pixels wide.
({Offset lineEnd, List<Offset> head}) arrowGeometry(Offset from, Offset to, double width, MarkupConfig config) {
  final length = (to - from).distance;
  final unit = length > 0 ? (to - from) / length : const Offset(1, 0);
  final head = min(width * config.arrowHeadLength, length * config.arrowMaxHeadShare);
  final angle = config.arrowHeadAngle * pi / 180;
  final back = head * cos(angle);
  final side = head * sin(angle);
  final base = to - unit * back;
  return (
    lineEnd: base,
    head: [
      to,
      Offset(base.dx - unit.dy * side, base.dy + unit.dx * side),
      Offset(base.dx + unit.dy * side, base.dy - unit.dx * side),
    ],
  );
}

TextPainter _textPainter(MarkupText item, Size size, MarkupConfig config, {Paint? foreground}) {
  final pixels = markupPixels(item.fontSize, size);
  return TextPainter(
    text: TextSpan(
      text: item.text,
      style: TextStyle(
        fontFamily: config.font,
        fontWeight: config.weight,
        fontSize: pixels,
        color: foreground == null ? item.colour : null,
        foreground: foreground,
      ),
    ),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
}

/// The box a text takes on a picture of [size] (pixels), centred on its place.
Rect markupTextBox(MarkupText item, Size size, MarkupConfig config) {
  final painter = _textPainter(item, size, config);
  final box = Rect.fromCenter(center: _pixel(item.at, size), width: painter.width, height: painter.height);
  painter.dispose();
  return box;
}

Path _linePath(List<Offset> points) {
  final path = Path()..moveTo(points.first.dx, points.first.dy);
  for (var i = 1; i < points.length - 1; i++) {
    final middle = (points[i] + points[i + 1]) / 2;
    path.quadraticBezierTo(points[i].dx, points[i].dy, middle.dx, middle.dy);
  }
  path.lineTo(points.last.dx, points.last.dy);
  return path;
}

void paintMarkup(Canvas canvas, List<MarkupItem> items, Size size, MarkupConfig config) {
  for (final item in items) {
    final stroke = Paint()
      ..color = item.colour
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final fill = Paint()..color = item.colour;
    switch (item) {
      case MarkupLine(:final kind, :final width, :final points):
        final pixels = markupPixels(width, size);
        final at = [for (final point in points) _pixel(point, size)];
        final colour = kind == MarkupLineKind.highlighter
            ? item.colour.withValues(alpha: config.highlighterOpacity)
            : item.colour;
        if (at.length == 1) {
          canvas.drawCircle(at.first, pixels / 2, fill..color = colour);
        } else {
          canvas.drawPath(
            _linePath(at),
            stroke
              ..color = colour
              ..strokeWidth = pixels,
          );
        }
      case MarkupShape(kind: MarkupShapeKind.arrow, :final width, :final from, :final to):
        final pixels = markupPixels(width, size);
        final start = _pixel(from, size);
        final (:lineEnd, :head) = arrowGeometry(start, _pixel(to, size), pixels, config);
        canvas.drawLine(start, lineEnd, stroke..strokeWidth = pixels);
        canvas.drawPath(
          Path()
            ..moveTo(head[0].dx, head[0].dy)
            ..lineTo(head[1].dx, head[1].dy)
            ..lineTo(head[2].dx, head[2].dy)
            ..close(),
          fill,
        );
      case MarkupShape(:final kind, :final width, :final from, :final to):
        final rect = Rect.fromPoints(_pixel(from, size), _pixel(to, size));
        stroke.strokeWidth = markupPixels(width, size);
        if (kind == MarkupShapeKind.box) {
          canvas.drawRect(rect, stroke..strokeJoin = StrokeJoin.miter);
        } else {
          canvas.drawOval(rect, stroke);
        }
      case MarkupText(:final fontSize, :final text):
        if (text.isEmpty) {
          continue;
        }
        final outline = _textPainter(
          item,
          size,
          config,
          foreground: Paint()
            ..color = config.outlineOf(item.colour)
            ..style = PaintingStyle.stroke
            ..strokeJoin = StrokeJoin.round
            ..strokeWidth = markupPixels(fontSize, size) * config.textOutline,
        );
        final letters = _textPainter(item, size, config);
        final topLeft = _pixel(item.at, size) - Offset(letters.width / 2, letters.height / 2);
        outline.paint(canvas, topLeft);
        letters.paint(canvas, topLeft);
        outline.dispose();
        letters.dispose();
    }
  }
}

/// One tile of the full-size copy ([tile] of a picture of [output]) with the markup painted on it.
Future<ui.Image> markupTile(
  ui.Image image,
  AdjustRect tile,
  AdjustSize output,
  List<MarkupItem> items,
  MarkupConfig config,
) {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder)..drawImage(image, Offset.zero, Paint());
  canvas.translate(-tile.x.toDouble(), -tile.y.toDouble());
  paintMarkup(canvas, items, Size(output.width.toDouble(), output.height.toDouble()), config);
  final picture = recorder.endRecording();
  return picture.toImage(tile.width, tile.height).whenComplete(picture.dispose);
}

@immutable
class MarkupHistory {
  final List<MarkupItem> items;
  final List<List<MarkupItem>> past;
  final List<List<MarkupItem>> future;

  const MarkupHistory([this.items = const [], this.past = const [], this.future = const []]);

  /// A change that can be undone.
  MarkupHistory commit(List<MarkupItem> next) => MarkupHistory(next, [...past, items]);

  /// More of the last change (a line growing, text typed, a drag going on): undone with it.
  MarkupHistory amend(List<MarkupItem> next) {
    if (past.isNotEmpty && _same(past.last, next)) {
      return MarkupHistory(next, past.sublist(0, past.length - 1), future);
    }
    return MarkupHistory(next, past, future);
  }

  MarkupHistory undo() =>
      past.isEmpty ? this : MarkupHistory(past.last, past.sublist(0, past.length - 1), [items, ...future]);

  MarkupHistory redo() => future.isEmpty ? this : MarkupHistory(future.first, [...past, items], future.sublist(1));

  static bool _same(List<MarkupItem> a, List<MarkupItem> b) =>
      a.length == b.length && [for (var i = 0; i < a.length; i++) identical(a[i], b[i])].every((same) => same);
}
