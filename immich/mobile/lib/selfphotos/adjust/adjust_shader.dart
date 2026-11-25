// SelfPhotos Adjust: the shared shader (web/src/lib/ai-edit/adjust/adjust-core.glsl, through
// shaders/selfphotos_adjust.frag) for the preview, the filter thumbnails and the full-size
// tiles. Not part of Immich. The web runs the same file (adjust-renderer.ts).
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_params.dart';

/// One render: which part of the output to draw, from which part of the source the image holds.
class AdjustRenderJob {
  final ShaderValues values;
  final double degrees;
  final Quad? perspective;
  final AdjustSize source; // the whole source, upright
  final AdjustSize output; // the whole output
  final AdjustRect tile; // the part of the output drawn now
  final AdjustRect texture; // the part of the source in the image

  const AdjustRenderJob({
    required this.values,
    required this.degrees,
    required this.source,
    required this.output,
    required this.tile,
    required this.texture,
    this.perspective,
  });

  /// The whole of [image] drawn at [output] size (the preview, a thumbnail).
  factory AdjustRenderJob.whole(
    ShaderValues values,
    double degrees,
    ui.Image image,
    AdjustSize output, [
    Quad? perspective,
  ]) {
    final source = AdjustSize(image.width, image.height);
    return AdjustRenderJob(
      values: values,
      degrees: degrees,
      perspective: perspective,
      source: source,
      output: output,
      tile: AdjustRect(0, 0, output.width, output.height),
      texture: AdjustRect(0, 0, source.width, source.height),
    );
  }
}

class AdjustShader {
  final ui.FragmentProgram _program;

  const AdjustShader._(this._program);

  static Future<AdjustShader> load() async =>
      AdjustShader._(await ui.FragmentProgram.fromAsset('shaders/selfphotos_adjust.frag'));

  /// A new shader; [configure] sets it up for a render. The caller disposes it.
  ui.FragmentShader create() => _program.fragmentShader();

  /// Sets [shader] up for [job], sampling [image]. [quality]: `medium` (with smaller copies)
  /// for pictures drawn much smaller than they are, `low` (plain bilinear) at full size.
  void configure(ui.FragmentShader shader, AdjustRenderJob job, ui.Image image, {required FilterQuality quality}) {
    shader.setImageSampler(0, image, filterQuality: quality);
    void vec2(String name, num x, num y) => shader.getUniformVec2(name).set(x.toDouble(), y.toDouble());
    void float(String name, double value) => shader.getUniformFloat(name).set(value);
    void vec3(String name, Rgb rgb) => shader.getUniformVec3(name).set(rgb.$1, rgb.$2, rgb.$3);

    vec2('uTexOrigin', job.texture.x, job.texture.y);
    vec2('uTexSize', job.texture.width, job.texture.height);
    vec2('uSrcSize', job.source.width, job.source.height);
    vec2('uOutSize', job.output.width, job.output.height);
    vec2('uTileOrigin', job.tile.x, job.tile.y);
    final view = framing(job.degrees, job.source, job.perspective);
    vec2('uRotation', view.rotation.$1, view.rotation.$2);
    vec2('uCropScale', view.scale.$1, view.scale.$2);
    vec2('uCropCentre', view.centre.$1, view.centre.$2);
    final toPhoto = view.toPhoto ?? identityMatrix;
    vec3('uPerspectiveX', (toPhoto[0], toPhoto[1], toPhoto[2]));
    vec3('uPerspectiveY', (toPhoto[3], toPhoto[4], toPhoto[5]));
    vec3('uPerspectiveW', (toPhoto[6], toPhoto[7], toPhoto[8]));
    float('uPremultiplied', 1); // Flutter's images are
    for (final slider in AdjustSlider.values) {
      float('u${slider.name[0].toUpperCase()}${slider.name.substring(1)}', job.values.sliders[slider]!);
    }
    float('uFade', job.values.fade);
    vec3('uToneShadows', job.values.toneShadows);
    vec3('uToneHighlights', job.values.toneHighlights);
  }

  /// Draws [job] into a new image the size of its tile.
  Future<ui.Image> render(AdjustRenderJob job, ui.Image image, {FilterQuality quality = FilterQuality.low}) async {
    final shader = create();
    configure(shader, job, image, quality: quality);
    final recorder = ui.PictureRecorder();
    ui.Canvas(recorder).drawRect(
      ui.Rect.fromLTWH(0, 0, job.tile.width.toDouble(), job.tile.height.toDouble()),
      ui.Paint()..shader = shader,
    );
    final picture = recorder.endRecording();
    try {
      return await picture.toImage(job.tile.width, job.tile.height);
    } finally {
      picture.dispose();
      shader.dispose();
    }
  }
}
