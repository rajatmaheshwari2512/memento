import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_auto.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_params.dart';

const _webDir = '../web/src/lib/ai-edit/adjust';

void main() {
  group('cropScale', () {
    test('keeps the whole photo when not turned, and matches the known values at 45°', () {
      expect(cropScale(0, const AdjustSize(4000, 3000)), 1);
      expect(cropScale(45, const AdjustSize(1000, 1000)), closeTo(sqrt1_2, 1e-6));
      expect(cropScale(45, const AdjustSize(4000, 3000)), closeTo(0.6061, 1e-4));
      expect(cropScale(45, const AdjustSize(3000, 4000)), closeTo(0.6061, 1e-4));
      expect(
        cropScale(-12.5, const AdjustSize(4080, 3072)),
        closeTo(cropScale(12.5, const AdjustSize(4080, 3072)), 1e-12),
      );
    });

    test('keeps every corner of the crop inside the turned photo', () {
      for (final source in const [
        AdjustSize(4000, 3000),
        AdjustSize(3000, 4000),
        AdjustSize(8160, 6120),
        AdjustSize(1920, 400),
      ]) {
        for (var degrees = -45.0; degrees <= 45; degrees += 0.7) {
          final output = outputSize(degrees, source);
          for (final (x, y) in [(0, 0), (output.width, 0), (0, output.height), (output.width, output.height)]) {
            final (sx, sy) = toSource(x.toDouble(), y.toDouble(), output, source, degrees);
            final margin = 1e-6 * max(source.width, source.height);
            expect(sx, inInclusiveRange(-margin, source.width + margin));
            expect(sy, inInclusiveRange(-margin, source.height + margin));
          }
        }
      }
    });

    test('gives the copy the same size as the web does', () {
      expect(outputSize(8, const AdjustSize(4032, 3024)), const AdjustSize(3429, 2572));
      expect(outputSize(3, const AdjustSize(8160, 6120)), const AdjustSize(7638, 5728));
    });
  });

  group('Auto', () {
    final settings = AutoSettings.parse(File('assets/selfphotos/adjust-auto.json').readAsStringSync());
    final parity = jsonDecode(File('$_webDir/adjust-auto-parity.json').readAsStringSync()) as Map<String, Object?>;

    (Uint8List, int) picture(List runs) {
      final width = runs.fold<int>(0, (sum, run) => sum + ((run as List)[3] as int));
      final pixels = Uint8List(width * 4);
      var x = 0;
      for (final run in runs.cast<List>()) {
        for (var i = 0; i < (run[3] as int); i++, x++) {
          pixels.setAll(x * 4, [run[0] as int, run[1] as int, run[2] as int, 255]);
        }
      }
      return (pixels, width);
    }

    test("reads the web app's own settings", () {
      expect(
        File('assets/selfphotos/adjust-auto.json').resolveSymbolicLinksSync(),
        endsWith('web/src/lib/ai-edit/adjust/adjust-auto.json'),
      );
    });

    test('gives the same values as the web app', () {
      for (final entry in (parity['cases']! as List).cast<Map<String, Object?>>()) {
        final (pixels, width) = picture(entry['runs']! as List);
        final values = autoAdjust(pixels, width, 1, settings);
        final expected = (entry['expected']! as Map<String, Object?>).map(
          (key, value) => MapEntry(AdjustSlider.values.byName(key), (value! as num).toDouble()),
        );
        expect(values, expected, reason: entry['name']! as String);
        expect(values.keys.toSet(), autoSliders.toSet());
      }
    });

    test('sets the sliders it works out and keeps the rest', () {
      final (pixels, width) = picture(((parity['cases']! as List)[1] as Map<String, Object?>)['runs']! as List);
      final values = autoAdjust(pixels, width, 1, settings);
      final state = const AdjustState(
        filter: 'mono',
        angle: 3,
      ).withSlider(AdjustSlider.tint, 0.2).withSlider(AdjustSlider.exposure, -0.5).withSliders(values);
      expect(state[AdjustSlider.exposure], values[AdjustSlider.exposure]);
      expect(state[AdjustSlider.tint], 0.2);
      expect(state.filter, 'mono');
      expect(state.angle, 3);
    });
  });

  group('perspective', () {
    final parity = jsonDecode(File('$_webDir/adjust-geometry-parity.json').readAsStringSync()) as Map<String, Object?>;
    Quad corners(Object? json) => [
      for (final p in (json! as List).cast<List>()) ((p[0] as num).toDouble(), (p[1] as num).toDouble()),
    ];
    AdjustSize size(Object? json) {
      final map = json! as Map<String, Object?>;
      return AdjustSize(map['width']! as int, map['height']! as int);
    }

    void close(double actual, num expected, String reason) =>
        expect((actual - expected).abs(), lessThanOrEqualTo(1e-9 * max(1, expected.abs())), reason: reason);

    test('gives the same values as the web app', () {
      for (final entry in (parity['cases']! as List).cast<Map<String, Object?>>()) {
        final name = entry['name']! as String;
        final source = size(entry['source']);
        final angle = (entry['angle']! as num).toDouble();
        final quad = corners(entry['corners']);
        final expected = entry['expected']! as Map<String, Object?>;
        final view = framing(angle, source, quad);
        final toPhoto = (expected['toPhoto']! as List).cast<num>();
        expect(view.toPhoto, isNotNull, reason: name);
        for (var i = 0; i < 9; i++) {
          close(view.toPhoto![i], toPhoto[i], '$name: toPhoto[$i]');
        }
        final centre = (expected['centre']! as List).cast<num>();
        close(view.centre.$1, centre[0], '$name: centre');
        close(view.centre.$2, centre[1], '$name: centre');
        final scale = (expected['scale']! as List).cast<num>();
        close(view.scale.$1, scale[0], '$name: scale');
        close(view.scale.$2, scale[1], '$name: scale');
        final output = size(expected['output']);
        expect(outputSize(angle, source, quad), output, reason: name);
        for (final point in (expected['toSource']! as List).cast<Map<String, Object?>>()) {
          final at = (point['at']! as List).cast<num>();
          final position = (point['source']! as List).cast<num>();
          final (x, y) = toSource(at[0].toDouble(), at[1].toDouble(), output, source, angle, quad);
          close(x, position[0], '$name: toSource $at');
          close(y, position[1], '$name: toSource $at');
        }
      }
    });

    test('accepts only corners in order, inside the photo, that keep the whole photo in front', () {
      for (final quad in parity['valid']! as List) {
        expect(isValidPerspective(corners(quad)), isTrue, reason: '$quad');
      }
      for (final entry in (parity['invalid']! as List).cast<Map<String, Object?>>()) {
        expect(isValidPerspective(corners(entry['corners'])), isFalse, reason: entry['name']! as String);
      }
    });

    test("changes nothing for the photo's own corners; keeps the whole photo for a rectangle of corners", () {
      const source = AdjustSize(4032, 3024);
      expect(framing(5, source, photoCorners()).toPhoto, isNull);
      const rectangle = [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)];
      expect(outputSize(0, source, rectangle), source);
      final (sx, sy) = toSource(123, 456, source, source, 0, rectangle);
      expect(sx, closeTo(123, 1e-6));
      expect(sy, closeTo(456, 1e-6));
      expect(const AdjustState().withPerspective(photoCorners()).isUnchanged, isTrue);
      expect(const AdjustState().withPerspective(rectangle).isUnchanged, isFalse);
      expect(const AdjustState().withPerspective(rectangle).withAngle(2).withFilter('mono').perspective, rectangle);
    });

    test("keeps the photo's shape when a crop of it holds the marked area, else changes it only as needed", () {
      const building = [(0.32, 0.2), (0.68, 0.2), (0.82, 0.9), (0.18, 0.9)];
      for (final source in const [AdjustSize(300, 400), AdjustSize(4000, 3000)]) {
        final (sx, sy) = framing(0, source, building).scale;
        expect(sx, closeTo(sy, 1e-9), reason: '$source');
      }
      const source = AdjustSize(3000, 4000);
      final (sx, sy) = framing(0, source, const [(0.05, 0.1), (0.95, 0.0), (0.95, 1.0), (0.05, 0.9)]).scale;
      expect(sx / sy, greaterThan(1 + 1e-6));
      expect(log(sx / sy), lessThan(0.02));
    });

    test("keeps each tile's part of the source within the limit", () {
      const source = AdjustSize(8000, 6000);
      const steep = [(0.3, 0.3), (0.7, 0.3), (1.0, 1.0), (0.0, 1.0)];
      final output = outputSize(0, source, steep);
      final size = tileSizeWithin(output, source, 0, steep, 2048, 2048);
      expect(size, lessThan(2048));
      for (final tile in tiles(output, size)) {
        final part = sourceRect(tile, output, source, 0, perspective: steep);
        expect(max(part.width, part.height), lessThanOrEqualTo(2048));
      }
      expect(tileSizeWithin(outputSize(45, source), source, 45, null, 1024, 2048), 1024);
    });
  });

  group('tiles', () {
    test('cover the output exactly once', () {
      const output = AdjustSize(1000, 650);
      final parts = tiles(output, 256);
      expect(parts, hasLength(12));
      final covered = List.filled(output.width * output.height, 0);
      for (final tile in parts) {
        for (var y = tile.y; y < tile.y + tile.height; y++) {
          for (var x = tile.x; x < tile.x + tile.width; x++) {
            covered[y * output.width + x]++;
          }
        }
      }
      expect(covered.every((count) => count == 1), isTrue);
    });

    test("each tile's source part holds what it samples and stays inside the source", () {
      const source = AdjustSize(3000, 2000);
      for (final degrees in [0.0, 3.3, -17.0, 45.0]) {
        final output = outputSize(degrees, source);
        for (final tile in tiles(output, 512)) {
          final rect = sourceRect(tile, output, source, degrees);
          expect(rect.x, greaterThanOrEqualTo(0));
          expect(rect.y, greaterThanOrEqualTo(0));
          expect(rect.x + rect.width, lessThanOrEqualTo(source.width));
          expect(rect.y + rect.height, lessThanOrEqualTo(source.height));
          for (var y = tile.y + 0.5; y < tile.y + tile.height; y += 37) {
            for (var x = tile.x + 0.5; x < tile.x + tile.width; x += 37) {
              final (sx, sy) = toSource(x, y, output, source, degrees);
              expect(max(0, sx - 1), greaterThanOrEqualTo(rect.x - 1e-6));
              expect(max(0, sy - 1), greaterThanOrEqualTo(rect.y - 1e-6));
              expect(min(source.width, sx + 1), lessThanOrEqualTo(rect.x + rect.width + 1e-6));
              expect(min(source.height, sy + 1), lessThanOrEqualTo(rect.y + rect.height + 1e-6));
            }
          }
        }
      }
    });
  });

  group('settings', () {
    final filters = parseAdjustFilters(File('assets/selfphotos/adjust-filters.json').readAsStringSync());

    test('the filters are the web app\'s own file, each named in the translations', () {
      expect(
        File('assets/selfphotos/adjust-filters.json').resolveSymbolicLinksSync(),
        endsWith('web/src/lib/ai-edit/adjust/adjust-filters.json'),
      );
      expect(filters.length, greaterThanOrEqualTo(8));
      final en = jsonDecode(File('../i18n/en.json').readAsStringSync()) as Map<String, Object?>;
      for (final filter in filters) {
        expect(en['editor_filter_${filter.id}'], isNotNull, reason: filter.id);
      }
    });

    test('nothing set is all zeros', () {
      final values = shaderValues(const AdjustState(), filters);
      expect(values.sliders.values.every((v) => v == 0), isTrue);
      expect(values.fade, 0);
      expect(values.toneShadows, (0.0, 0.0, 0.0));
    });

    test('adds the filter at its strength to the sliders, as the web does', () {
      final state = const AdjustState(
        filter: 'golden',
        strength: 0.5,
      ).withSlider(AdjustSlider.warmth, 0.1).withSlider(AdjustSlider.contrast, -0.2);
      final values = shaderValues(state.withStrength(0.5), filters);
      expect(values.sliders[AdjustSlider.warmth], closeTo(0.1 + 0.25 * 0.5, 1e-9));
      expect(values.sliders[AdjustSlider.contrast], closeTo(-0.2 + 0.1 * 0.5, 1e-9));
      expect(values.toneHighlights, (0.2, 0.125, -0.1));
      expect(values.sliders[AdjustSlider.exposure], 0);
    });

    test('keeps every value in range, ignores an unknown filter', () {
      final noir = shaderValues(
        const AdjustState(
          filter: 'noir',
        ).withSlider(AdjustSlider.saturation, -0.8).withSlider(AdjustSlider.contrast, 1),
        filters,
      );
      expect(noir.sliders[AdjustSlider.saturation], -1);
      expect(noir.sliders[AdjustSlider.contrast], 1);
      expect(shaderValues(const AdjustState(filter: 'matte', strength: 7), filters).fade, closeTo(0.6, 1e-9));
      expect(shaderValues(const AdjustState(filter: 'nope'), filters).sliders.values.every((v) => v == 0), isTrue);
    });

    test('notices any slider, filter or turn', () {
      expect(const AdjustState().isUnchanged, isTrue);
      expect(const AdjustState().withAngle(0.5).isUnchanged, isFalse);
      expect(const AdjustState().withFilter('mono').isUnchanged, isFalse);
      expect(const AdjustState().withSlider(AdjustSlider.tint, 0.01).isUnchanged, isFalse);
      expect(const AdjustState().withSlider(AdjustSlider.tint, 0).isUnchanged, isTrue);
    });
  });

  group('the shared shader', () {
    test("the shader's own file names the shared file's hash, so a build doesn't ship the old shader", () {
      final wrapper = File('shaders/selfphotos_adjust.frag').readAsStringSync();
      final hash = sha256.convert(File('$_webDir/adjust-core.glsl').readAsBytesSync()).toString();
      if (!wrapper.contains('// adjust-core.glsl sha256: $hash\n')) {
        fail(
          'adjust-core.glsl has changed: put its new hash in shaders/selfphotos_adjust.frag, '
          '"// adjust-core.glsl sha256: $hash", or Flutter keeps building the old shader into the app.',
        );
      }
    });

    test("Android's shader includes the web's file, which has every value the app sets", () {
      final wrapper = File('shaders/selfphotos_adjust.frag').readAsStringSync();
      expect(wrapper, contains('#include "../../web/src/lib/ai-edit/adjust/adjust-core.glsl"'));
      final core = File('$_webDir/adjust-core.glsl').readAsStringSync();
      for (final name in [
        ...AdjustSlider.values.map((s) => 'float u${s.name[0].toUpperCase()}${s.name.substring(1)}'),
        'float uFade',
        'vec3 uToneShadows',
        'vec3 uToneHighlights',
        'vec2 uTexOrigin',
        'vec2 uTexSize',
        'vec2 uSrcSize',
        'vec2 uOutSize',
        'vec2 uTileOrigin',
        'vec2 uRotation',
        'vec2 uCropScale',
        'vec2 uCropCentre',
        'vec3 uPerspectiveX',
        'vec3 uPerspectiveY',
        'vec3 uPerspectiveW',
        'float uPremultiplied',
        'sampler2D uTexture',
      ]) {
        expect(core, contains('uniform $name;'), reason: name);
      }
    });
  });
}
