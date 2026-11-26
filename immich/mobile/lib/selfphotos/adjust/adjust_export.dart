// SelfPhotos Adjust: the full-size render that's saved as the copy, and the steps it shares with
// AI edits' paste-back (exportFullSize).
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.service.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_native.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_params.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_shader.dart';
import 'package:immich_mobile/selfphotos/adjust/markup.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/work_folder.dart';
import 'package:path/path.dart' as p;

// Small enough for any phone GPU even when turned (a tile's source part is up to √2 bigger).
const _tileSize = 1024;

const _maxPart = 2048;

class AdjustExport {
  final Uint8List bytes;
  final String mime;
  final AdjustSize size;

  final bool fromPreview;

  const AdjustExport(this.bytes, this.mime, this.size, {required this.fromPreview});
}

/// Draws one tile of the output.
typedef TileDrawer = Future<void> Function(AdjustNative native, AdjustRect tile, AdjustSize source, AdjustSize output);

/// The full-size copy's steps.
Future<AdjustExport> exportFullSize(
  RemoteAsset asset, {
  required AdjustSize Function(AdjustSize source) outputOf,
  required TileDrawer drawTile,
  int Function(AdjustSize source, AdjustSize output, int size)? tileSizeOf,
  int tileSize = _tileSize,
  bool? png,
  int quality = 92,
  void Function(double done)? onProgress,
  AdjustService service = const AdjustService(),
  AdjustNative native = const AdjustNative(),
}) async {
  final folder = await createWorkFolder('selfphotos-copy-');
  try {
    final source = await _openSource(asset, folder, service, native);
    final output = outputOf(source);
    await native.createOutput(output);
    final parts = tiles(output, tileSizeOf?.call(source, output, tileSize) ?? tileSize);
    for (final (index, tile) in parts.indexed) {
      await drawTile(native, tile, source, output);
      onProgress?.call((index + 1) / parts.length);
    }

    final asPng = png ?? p.extension(asset.name).toLowerCase() == '.png';
    final file = File(p.join(folder.path, asPng ? 'copy.png' : 'copy.jpg'));
    await native.encode(file.path, png: asPng, quality: quality);
    await native.close();
    final largest = [asset.width ?? 0, asset.height ?? 0].reduce((a, b) => a > b ? a : b);
    final read = source.width > source.height ? source.width : source.height;
    return AdjustExport(
      await file.readAsBytes(),
      asPng ? 'image/png' : 'image/jpeg',
      output,
      fromPreview: largest > 0 && read < largest * 0.9,
    );
  } finally {
    await native.close();
    await folder.delete(recursive: true);
  }
}

// Downloads and opens the best picture the phone can read (see adjust.service.dart).
Future<AdjustSize> _openSource(RemoteAsset asset, Directory folder, AdjustService service, AdjustNative native) async {
  for (final (index, url) in service.sourceUrls(asset).indexed) {
    final file = File(p.join(folder.path, 'source-$index'));
    try {
      await service.download(url, file);
      return await native.open(file.path);
    } on ExtrasException {
    } on AdjustNativeException catch (e) {
      if (e.code != 'unreadable') {
        rethrow;
      }
    }
    if (file.existsSync()) {
      await file.delete();
    }
  }
  throw const AdjustNativeException('unreadable', "This photo's format can't be read here.");
}

/// Pixels from the Android side (RGBA, premultiplied) as an image Flutter can draw.
Future<ui.Image> imageFromPixels(Uint8List pixels, int width, int height) {
  final completer = Completer<ui.Image>();
  ui.decodeImageFromPixels(pixels, width, height, ui.PixelFormat.rgba8888, completer.complete);
  return completer.future;
}

class AdjustExporter {
  final AdjustShader shader;
  final List<AdjustFilter> filters;
  final AdjustService service;
  final AdjustNative native;

  final int tileSize;
  final int maxPart;

  const AdjustExporter(
    this.shader,
    this.filters, {
    this.service = const AdjustService(),
    this.native = const AdjustNative(),
    this.tileSize = _tileSize,
    this.maxPart = _maxPart,
  });

  /// [markup]: drawn on top of each tile, on the final picture (none: the tiles as rendered).
  Future<AdjustExport> export(
    RemoteAsset asset,
    AdjustState state, {
    ({List<MarkupItem> items, MarkupConfig config})? markup,
    void Function(double done)? onProgress,
  }) {
    final values = shaderValues(state, filters);
    return exportFullSize(
      asset,
      service: service,
      native: native,
      onProgress: onProgress,
      outputOf: (source) => outputSize(state.angle, source, state.perspective),
      tileSize: tileSize,
      tileSizeOf: state.perspective == null
          ? null
          : (source, output, size) => tileSizeWithin(output, source, state.angle, state.perspective, size, maxPart),
      drawTile: (native, tile, source, output) async {
        final texture = sourceRect(tile, output, source, state.angle, perspective: state.perspective);
        final part = await imageFromPixels(await native.read(texture), texture.width, texture.height);
        final ui.Image rendered;
        try {
          rendered = await shader.render(
            AdjustRenderJob(
              values: values,
              degrees: state.angle,
              perspective: state.perspective,
              source: source,
              output: output,
              tile: tile,
              texture: texture,
            ),
            part,
          );
        } finally {
          part.dispose();
        }
        var drawn = rendered;
        try {
          if (markup != null) {
            drawn = await markupTile(rendered, tile, output, markup.items, markup.config);
          }
          final pixels = await drawn.toByteData();
          await native.write(tile, pixels!.buffer.asUint8List());
        } finally {
          rendered.dispose();
          if (!identical(drawn, rendered)) {
            drawn.dispose();
          }
        }
      },
    );
  }
}
