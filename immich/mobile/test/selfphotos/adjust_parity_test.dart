import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.service.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_export.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_native.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_params.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_shader.dart';

import '../unit/factories/remote_asset_factory.dart';
import 'work_folder_stub.dart';

class _Source extends AdjustService {
  const _Source();

  @override
  List<String> sourceUrls(RemoteAsset asset) => const ['original'];

  @override
  Future<void> download(String url, File file) => file.writeAsBytes(const [0]);
}

class _Native extends AdjustNative {
  final AdjustSize source;
  final Uint8List pixels;
  AdjustSize? size;
  late Uint8List output;
  void Function(AdjustRect tile)? onWrite;

  _Native(this.source, this.pixels);

  @override
  Future<AdjustSize> open(String path) async => source;

  @override
  Future<Uint8List> read(AdjustRect r) async {
    final part = Uint8List(r.width * r.height * 4);
    for (var row = 0; row < r.height; row++) {
      final from = ((r.y + row) * source.width + r.x) * 4;
      part.setRange(row * r.width * 4, (row + 1) * r.width * 4, pixels, from);
    }
    return part;
  }

  @override
  Future<void> createOutput(AdjustSize size) async {
    this.size = size;
    output = Uint8List(size.width * size.height * 4);
  }

  @override
  Future<void> write(AdjustRect tile, Uint8List pixels) async {
    onWrite?.call(tile);
    for (var row = 0; row < tile.height; row++) {
      output.setRange(
        ((tile.y + row) * size!.width + tile.x) * 4,
        ((tile.y + row) * size!.width + tile.x + tile.width) * 4,
        pixels,
        row * tile.width * 4,
      );
    }
  }

  @override
  Future<void> encode(String path, {required bool png, int quality = 92}) => File(path).writeAsBytes(const [0]);

  @override
  Future<void> close() async {}
}

void main() {
  setUpAll(stubWorkFolderRoot);

  testWidgets('the shader gives the same pixels as on the web', (tester) async {
    await tester.runAsync(() async {
      final parity =
          jsonDecode(File('../web/src/lib/ai-edit/adjust/adjust-parity.json').readAsStringSync())
              as Map<String, Object?>;
      final filters = parseAdjustFilters(File('assets/selfphotos/adjust-filters.json').readAsStringSync());
      final picture = parity['image']! as Map<String, Object?>;
      final width = picture['width']! as int;
      final height = picture['height']! as int;
      final pixels = Uint8List.fromList((picture['pixels']! as List).cast<int>());
      final completer = Completer<ui.Image>();
      ui.decodeImageFromPixels(pixels, width, height, ui.PixelFormat.rgba8888, completer.complete);
      final image = await completer.future;
      final shader = await AdjustShader.load();

      for (final entry in (parity['cases']! as List).cast<Map<String, Object?>>()) {
        final json = entry['state']! as Map<String, Object?>;
        var state = AdjustState(
          filter: json['filter'] as String?,
          strength: (json['strength'] as num?)?.toDouble() ?? 1,
          angle: (json['angle'] as num?)?.toDouble() ?? 0,
          perspective: (json['perspective'] as List?)
              ?.map((p) => ((p as List)[0] as num, p[1] as num))
              .map((p) => (p.$1.toDouble(), p.$2.toDouble()))
              .toList(),
        );
        for (final MapEntry(:key, :value) in (json['adjustments']! as Map<String, Object?>).entries) {
          state = state.withSlider(AdjustSlider.values.byName(key), (value! as num).toDouble());
        }
        final source = AdjustSize(width, height);
        final output = outputSize(state.angle, source, state.perspective);
        final rendered = await shader.render(
          AdjustRenderJob(
            values: shaderValues(state, filters),
            degrees: state.angle,
            perspective: state.perspective,
            source: source,
            output: output,
            tile: AdjustRect(0, 0, output.width, output.height),
            texture: AdjustRect(0, 0, width, height),
          ),
          image,
        );
        final actual = (await rendered.toByteData(format: ui.ImageByteFormat.rawStraightRgba))!.buffer.asUint8List();
        final expected = (entry['expected']! as List).cast<int>();
        expect(actual.length, expected.length, reason: '$json');
        var worst = 0;
        for (var i = 0; i < expected.length; i++) {
          worst = (actual[i] - expected[i]).abs() > worst ? (actual[i] - expected[i]).abs() : worst;
        }
        expect(worst, lessThanOrEqualTo(2), reason: '$json: $actual');
      }
    });
  });

  testWidgets('tiles from parts of the source give the one-pass picture', (tester) async {
    await tester.runAsync(() async {
      const source = AdjustSize(61, 43);
      final pixels = Uint8List(source.width * source.height * 4);
      for (var y = 0; y < source.height; y++) {
        for (var x = 0; x < source.width; x++) {
          pixels.setAll((y * source.width + x) * 4, [x * 4 % 256, y * 6 % 256, (x * 7 + y * 13) % 256, 255]);
        }
      }
      Future<ui.Image> image(AdjustRect r) {
        final part = Uint8List(r.width * r.height * 4);
        for (var row = 0; row < r.height; row++) {
          final from = ((r.y + row) * source.width + r.x) * 4;
          part.setRange(row * r.width * 4, (row + 1) * r.width * 4, pixels, from);
        }
        final completer = Completer<ui.Image>();
        ui.decodeImageFromPixels(part, r.width, r.height, ui.PixelFormat.rgba8888, completer.complete);
        return completer.future;
      }

      final filters = parseAdjustFilters(File('assets/selfphotos/adjust-filters.json').readAsStringSync());
      final shader = await AdjustShader.load();
      final state = const AdjustState(
        filter: 'film',
        strength: 0.8,
        angle: 7.3,
      ).withSlider(AdjustSlider.contrast, 0.4).withSlider(AdjustSlider.vignette, 0.6);
      final values = shaderValues(state, filters);
      final output = outputSize(state.angle, source);

      Future<Uint8List> draw(AdjustRect tile, AdjustRect texture) async {
        final part = await image(texture);
        final job = AdjustRenderJob(
          values: values,
          degrees: state.angle,
          source: source,
          output: output,
          tile: tile,
          texture: texture,
        );
        final rendered = await shader.render(job, part);
        return (await rendered.toByteData(format: ui.ImageByteFormat.rawStraightRgba))!.buffer.asUint8List();
      }

      final whole = await draw(
        AdjustRect(0, 0, output.width, output.height),
        AdjustRect(0, 0, source.width, source.height),
      );
      var worst = 0;
      for (final tile in tiles(output, 16)) {
        final part = await draw(tile, sourceRect(tile, output, source, state.angle));
        for (var y = 0; y < tile.height; y++) {
          for (var x = 0; x < tile.width * 4; x++) {
            final difference = (part[y * tile.width * 4 + x] - whole[((tile.y + y) * output.width + tile.x) * 4 + x])
                .abs();
            worst = difference > worst ? difference : worst;
          }
        }
      }
      expect(worst, lessThanOrEqualTo(1));
    });
  });

  testWidgets('the full-size save warps for perspective, with straighten and the sliders', (tester) async {
    await tester.runAsync(() async {
      const source = AdjustSize(1301, 903);
      final pixels = Uint8List(source.width * source.height * 4);
      for (var y = 0; y < source.height; y++) {
        for (var x = 0; x < source.width; x++) {
          pixels.setAll((y * source.width + x) * 4, [x % 256, (y * 3) % 256, (x * 7 + y * 13) % 256, 255]);
        }
      }
      const corners = [(0.15, 0.05), (0.8, 0.1), (1.0, 0.9), (0.0, 1.0)];
      final state = const AdjustState(angle: 3.5, perspective: corners).withSlider(AdjustSlider.contrast, 0.3);
      final filters = parseAdjustFilters(File('assets/selfphotos/adjust-filters.json').readAsStringSync());
      final shader = await AdjustShader.load();
      final native = _Native(source, pixels);

      final output = outputSize(3.5, source, corners);
      final size = tileSizeWithin(output, source, 3.5, corners, 256, 260);
      expect(size, lessThan(256), reason: 'the tiles shrunk to keep within the limit');
      final parts = tiles(output, size);
      expect(parts.map((tile) => tile.y).toSet().length, greaterThan(1), reason: 'more than one row');
      expect(parts.where((tile) => tile.width < size || tile.height < size), isNotEmpty, reason: 'edge tiles');
      final drawn = <AdjustRect>[];
      await AdjustExporter(
        shader,
        filters,
        service: const _Source(),
        native: native..onWrite = drawn.add,
        tileSize: 256,
        maxPart: 260,
      ).export(RemoteAssetFactory.create(), state);
      expect(native.size, output);
      expect(output, isNot(outputSize(3.5, source)));
      expect(drawn.map((tile) => (tile.x, tile.y, tile.width, tile.height)), [
        for (final tile in parts) (tile.x, tile.y, tile.width, tile.height),
      ]);

      final completer = Completer<ui.Image>();
      ui.decodeImageFromPixels(pixels, source.width, source.height, ui.PixelFormat.rgba8888, completer.complete);
      final whole = await shader.render(
        AdjustRenderJob(
          values: shaderValues(state, filters),
          degrees: 3.5,
          perspective: corners,
          source: source,
          output: output,
          tile: AdjustRect(0, 0, output.width, output.height),
          texture: AdjustRect(0, 0, source.width, source.height),
        ),
        await completer.future,
      );
      final expected = (await whole.toByteData())!.buffer.asUint8List();
      var worst = 0;
      for (var i = 0; i < expected.length; i++) {
        final difference = (native.output[i] - expected[i]).abs();
        worst = difference > worst ? difference : worst;
      }
      expect(worst, lessThanOrEqualTo(1));
    });
  });
}
