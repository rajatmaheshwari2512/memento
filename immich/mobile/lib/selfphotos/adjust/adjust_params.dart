// SelfPhotos Adjust: what the sliders and filters set, and how they become the shader's values
// (web/src/lib/ai-edit/adjust/adjust-core.glsl).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';

/// The sliders, in the order they're shown.
enum AdjustSlider {
  exposure(Icons.exposure),
  brightness(Icons.brightness_6_outlined),
  contrast(Icons.contrast),
  highlights(Icons.wb_sunny_outlined),
  shadows(Icons.nights_stay_outlined),
  vignette(Icons.vignette_outlined),
  saturation(Icons.palette_outlined),
  warmth(Icons.thermostat),
  tint(Icons.colorize_outlined);

  final IconData icon;

  const AdjustSlider(this.icon);

  String label(BuildContext context) => switch (this) {
    exposure => context.t.editor_exposure,
    brightness => context.t.editor_brightness,
    contrast => context.t.editor_contrast,
    highlights => context.t.editor_highlights,
    shadows => context.t.editor_shadows,
    vignette => context.t.editor_vignette,
    saturation => context.t.editor_saturation,
    warmth => context.t.editor_warmth,
    tint => context.t.editor_tint,
  };
}

/// Straighten: the slider's range, in degrees (clockwise is positive).
const maxAngle = 45.0;

typedef Rgb = (double, double, double);

/// A filter: some sliders, plus two settings only filters use (fade, and colours pushed into the
/// shadows and highlights).
class AdjustFilter {
  final String id;
  final Map<AdjustSlider, double> sliders;
  final double fade;
  final Rgb toneShadows;
  final Rgb toneHighlights;

  const AdjustFilter(
    this.id,
    this.sliders, {
    this.fade = 0,
    this.toneShadows = (0, 0, 0),
    this.toneHighlights = (0, 0, 0),
  });

  static Rgb _rgb(Object? value) {
    final list = value is List ? value.map((v) => (v as num).toDouble()).toList() : const [0.0, 0.0, 0.0];
    return (list[0], list[1], list[2]);
  }

  factory AdjustFilter.fromJson(Map<String, Object?> json) => AdjustFilter(
    json['id']! as String,
    {
      for (final slider in AdjustSlider.values)
        if (json[slider.name] case final num value) slider: value.toDouble(),
    },
    fade: (json['fade'] as num?)?.toDouble() ?? 0,
    toneShadows: _rgb(json['toneShadows']),
    toneHighlights: _rgb(json['toneHighlights']),
  );

  String label(BuildContext context) => switch (id) {
    'bright' => context.t.editor_filter_bright,
    'punch' => context.t.editor_filter_punch,
    'warm' => context.t.editor_filter_warm,
    'cool' => context.t.editor_filter_cool,
    'golden' => context.t.editor_filter_golden,
    'matte' => context.t.editor_filter_matte,
    'film' => context.t.editor_filter_film,
    'soft' => context.t.editor_filter_soft,
    'moody' => context.t.editor_filter_moody,
    'mono' => context.t.editor_filter_mono,
    'noir' => context.t.editor_filter_noir,
    'sepia' => context.t.editor_filter_sepia,
    _ => id,
  };
}

/// The filters, from the file the web app uses too.
List<AdjustFilter> parseAdjustFilters(String json) => [
  for (final filter in (jsonDecode(json) as Map<String, Object?>)['filters']! as List)
    AdjustFilter.fromJson(filter as Map<String, Object?>),
];

Future<List<AdjustFilter>> loadAdjustFilters() async =>
    parseAdjustFilters(await rootBundle.loadString('assets/selfphotos/adjust-filters.json'));

/// Everything the editor holds.
@immutable
class AdjustState {
  final Map<AdjustSlider, double> sliders;
  final String? filter;
  final double strength;
  final double angle;
  final Quad? perspective;

  const AdjustState({this.sliders = const {}, this.filter, this.strength = 1, this.angle = 0, this.perspective});

  double operator [](AdjustSlider slider) => sliders[slider] ?? 0;

  AdjustState withSlider(AdjustSlider slider, double value) => withSliders({slider: value});

  /// [values] set, the other sliders kept.
  AdjustState withSliders(Map<AdjustSlider, double> values) => AdjustState(
    sliders: {...sliders, ...values},
    filter: filter,
    strength: strength,
    angle: angle,
    perspective: perspective,
  );

  AdjustState withFilter(String? id) =>
      AdjustState(sliders: sliders, filter: id, strength: 1, angle: angle, perspective: perspective);

  AdjustState withStrength(double value) =>
      AdjustState(sliders: sliders, filter: filter, strength: value, angle: angle, perspective: perspective);

  AdjustState withAngle(double value) =>
      AdjustState(sliders: sliders, filter: filter, strength: strength, angle: value, perspective: perspective);

  /// The photo's own corners are no perspective (null).
  AdjustState withPerspective(Quad? corners) => AdjustState(
    sliders: sliders,
    filter: filter,
    strength: strength,
    angle: angle,
    perspective: corners == null || isPhotoCorners(corners) ? null : corners,
  );

  /// Nothing changed: no slider moved, no filter, not turned, no perspective.
  bool get isUnchanged => filter == null && angle == 0 && perspective == null && sliders.values.every((v) => v == 0);
}

class ShaderValues {
  final Map<AdjustSlider, double> sliders;
  final double fade;
  final Rgb toneShadows;
  final Rgb toneHighlights;

  const ShaderValues(this.sliders, this.fade, this.toneShadows, this.toneHighlights);
}

/// The sliders, plus the filter at its strength.
ShaderValues shaderValues(AdjustState state, List<AdjustFilter> filters) {
  final filter = filters.where((f) => f.id == state.filter).firstOrNull;
  final strength = filter == null ? 0.0 : state.strength.clamp(0.0, 1.0);
  Rgb scaled(Rgb rgb) => (rgb.$1 * strength, rgb.$2 * strength, rgb.$3 * strength);
  return ShaderValues(
    {
      for (final slider in AdjustSlider.values)
        slider: (state[slider] + (filter?.sliders[slider] ?? 0) * strength).clamp(-1.0, 1.0),
    },
    ((filter?.fade ?? 0) * strength).clamp(0.0, 1.0),
    scaled(filter?.toneShadows ?? (0, 0, 0)),
    scaled(filter?.toneHighlights ?? (0, 0, 0)),
  );
}
