// SelfPhotos Adjust's Auto: one tap sets the light and colour sliders from the photo itself, from
// its histogram and average colour.
import 'dart:convert';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_params.dart';

/// The sliders Auto sets (the rest keep their values).
const autoSliders = [
  AdjustSlider.exposure,
  AdjustSlider.brightness,
  AdjustSlider.contrast,
  AdjustSlider.highlights,
  AdjustSlider.shadows,
  AdjustSlider.saturation,
  AdjustSlider.warmth,
];

/// adjust-auto.json.
class AutoSettings {
  final Map<String, Object?> _json;

  const AutoSettings(this._json);

  factory AutoSettings.parse(String json) => AutoSettings(jsonDecode(json) as Map<String, Object?>);

  Object? _at(String path) {
    Object? value = _json;
    for (final key in path.split('.')) {
      value = (value! as Map<String, Object?>)[key];
    }
    return value;
  }

  double operator [](String path) => (_at(path)! as num).toDouble();

  (double, double) pair(String path) {
    final list = (_at(path)! as List).cast<num>();
    return (list[0].toDouble(), list[1].toDouble());
  }
}

Future<AutoSettings> loadAutoSettings() async =>
    AutoSettings.parse(await rootBundle.loadString('assets/selfphotos/adjust-auto.json'));

/// What Auto sees of a photo.
class PhotoStats {
  /// The tones the darkest 0.5%, half, and all but the brightest 0.5% of the photo are at or below.
  final double low;
  final double median;
  final double high;

  /// The share crushed to black, and blown out to white.
  final double darkClipped;
  final double brightClipped;

  /// The greyish midtones' average colour.
  final (double, double, double) balance;
  final double greyish;

  /// The midtones' average saturation, 0 (grey) to 1.
  final double saturation;

  const PhotoStats({
    required this.low,
    required this.median,
    required this.high,
    required this.darkClipped,
    required this.brightClipped,
    required this.balance,
    required this.greyish,
    required this.saturation,
  });
}

double _toLinear(double v) => v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4).toDouble();
double _toSrgb(double v) => v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1 / 2.4) - 0.055;
final _linear = [for (var v = 0; v < 256; v++) _toLinear(v / 255)];
double _log2(double v) => log(v) / ln2;

/// Looks at the photo (RGBA, unpremultiplied, rows top first).
PhotoStats measurePhoto(Uint8List pixels, int width, int height, AutoSettings settings) {
  final step = max(1, sqrt(width * height / settings['samples']).floor());
  final histogram = List.filled(256, 0);
  final (lowTone, highTone) = settings.pair('midtones');
  final lowCut = (lowTone * 255).round();
  final highCut = (highTone * 255).round();
  final greyishAt = settings['warmth.greyish'];
  var count = 0;
  var midtones = 0;
  var greyish = 0;
  var red = 0.0;
  var green = 0.0;
  var blue = 0.0;
  var saturation = 0.0;
  for (var y = 0; y < height; y += step) {
    for (var x = 0; x < width; x += step) {
      final i = (y * width + x) * 4;
      final r = pixels[i];
      final g = pixels[i + 1];
      final b = pixels[i + 2];
      final luma = (2126 * r + 7152 * g + 722 * b + 5000) ~/ 10000;
      histogram[luma]++;
      count++;
      if (luma < lowCut || luma > highCut) {
        continue;
      }
      final top = max(r, max(g, b));
      final colour = (top - min(r, min(g, b))) / top;
      saturation += colour;
      midtones++;
      if (colour <= greyishAt) {
        red += _linear[r];
        green += _linear[g];
        blue += _linear[b];
        greyish++;
      }
    }
  }
  double toneAt(double share) {
    var total = 0;
    for (var tone = 0; tone < 256; tone++) {
      total += histogram[tone];
      if (total >= share * count) {
        return tone / 255;
      }
    }
    return 1;
  }

  double shareOf(int from, int to) {
    var total = 0;
    for (var tone = from; tone <= to; tone++) {
      total += histogram[tone];
    }
    return total / count;
  }

  final ends = settings['ends'];
  return PhotoStats(
    low: toneAt(ends),
    median: toneAt(0.5),
    high: toneAt(1 - ends),
    darkClipped: shareOf(0, (settings['shadows.clipped'] * 255).round()),
    brightClipped: shareOf((settings['highlights.clipped'] * 255).round(), 255),
    balance: greyish > 0 ? (red / greyish, green / greyish, blue / greyish) : (0, 0, 0),
    greyish: greyish / count,
    saturation: midtones > 0 ? saturation / midtones : 0,
  );
}

double _toStep(double value) => value.sign * (value.abs() * 100).round() / 100 + 0;

/// The sliders for a photo with these stats.
Map<AdjustSlider, double> autoValues(PhotoStats stats, AutoSettings settings) {
  final (lowest, highest) = settings.pair('brightness.middle');
  final toWhite = 0.5 * _log2(_toLinear(settings['exposure.white']) / _toLinear(max(stats.high, 1 / 255)));
  final toMiddle = 0.5 * _log2(_toLinear(lowest) / _toLinear(max(stats.median, 1 / 255)));
  final exposure = _toStep(min(toWhite, toMiddle).clamp(0.0, settings['exposure.max']));
  final gain = pow(2, 2 * exposure);
  double exposed(double tone) => _toSrgb(min(1.0, _toLinear(tone) * gain));

  final low = exposed(stats.low);
  final black = settings['contrast.black'];
  final contrast = low > black && low < 0.5
      ? _toStep(((log(2 * black) / log(2 * low) - 1) / 1.5).clamp(0.0, settings['contrast.max']))
      : 0.0;
  final k = 1 + 1.5 * contrast;

  double contrasted(double tone) => tone < 0.5 ? 0.5 * pow(2 * tone, k) : 1 - 0.5 * pow(2 * (1 - tone), k);
  double uncontrasted(double tone) => tone < 0.5 ? 0.5 * pow(2 * tone, 1 / k) : 1 - 0.5 * pow(2 * (1 - tone), 1 / k);
  final middle = exposed(stats.median).clamp(0.01, 0.99);
  final shown = contrasted(middle);
  final aim = shown < lowest ? uncontrasted(lowest) : (shown > highest ? uncontrasted(highest) : middle);
  final brightness = _toStep(
    (-_log2(log(aim) / log(middle)) / 0.75 * settings['brightness.strength']).clamp(
      settings['brightness.min'],
      settings['brightness.max'],
    ),
  );

  final shadows = _toStep(
    ((stats.darkClipped - settings['shadows.allowed']) * settings['shadows.perClipped']).clamp(
      0.0,
      settings['shadows.max'],
    ),
  );
  final highlights = _toStep(
    -((stats.brightClipped - settings['highlights.allowed']) * settings['highlights.perClipped']).clamp(
      0.0,
      settings['highlights.max'],
    ),
  );

  final colourful = stats.saturation >= settings['grey'];
  final (r, _, b) = stats.balance;
  final balanced = colourful && stats.greyish >= settings['warmth.minShare'] && r > 0 && b > 0;
  final ratio = b / r;
  final warmthMax = settings['warmth.max'];
  final warmth = balanced
      ? _toStep((4 * (ratio - 1) / (1 + ratio) * settings['warmth.strength']).clamp(-warmthMax, warmthMax))
      : 0.0;
  final saturation = colourful
      ? _toStep(
          ((settings['saturation.target'] - stats.saturation) * settings['saturation.strength']).clamp(
            0.0,
            settings['saturation.max'],
          ),
        )
      : 0.0;

  return {
    AdjustSlider.exposure: exposure,
    AdjustSlider.brightness: brightness,
    AdjustSlider.contrast: contrast,
    AdjustSlider.highlights: highlights,
    AdjustSlider.shadows: shadows,
    AdjustSlider.saturation: saturation,
    AdjustSlider.warmth: warmth,
  };
}

Map<AdjustSlider, double> autoAdjust(Uint8List pixels, int width, int height, AutoSettings settings) =>
    autoValues(measurePhoto(pixels, width, height, settings), settings);

/// Auto for a picture Flutter holds.
Future<Map<AdjustSlider, double>> autoAdjustImage(ui.Image image, AutoSettings settings) async {
  final pixels = (await image.toByteData(format: ui.ImageByteFormat.rawStraightRgba))!;
  return autoAdjust(pixels.buffer.asUint8List(), image.width, image.height, settings);
}
