// SelfPhotos Adjust: the Android side of saving a full-size copy
// (android/.../selfphotos/AdjustImagePlugin.kt): reads the source in parts, upright and in
// sRGB; gathers the rendered tiles; encodes the JPEG. Not part of Immich.
import 'package:flutter/services.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';

/// Why a save failed on the device: `too-large` (out of memory), `unreadable` (a format the
/// phone can't read), or anything else.
class AdjustNativeException implements Exception {
  final String code;
  final String? message;

  const AdjustNativeException(this.code, this.message);

  @override
  String toString() => message ?? code;
}

class AdjustNative {
  const AdjustNative();

  static const _channel = MethodChannel('selfphotos/adjust_image');

  Future<T?> _call<T>(String method, [Map<String, Object?>? arguments]) async {
    try {
      return await _channel.invokeMethod<T>(method, arguments);
    } on PlatformException catch (e) {
      throw AdjustNativeException(e.code, e.message);
    }
  }

  static Map<String, int> _rect(AdjustRect r) => {'x': r.x, 'y': r.y, 'width': r.width, 'height': r.height};

  /// Opens the source photo; returns its upright size.
  Future<AdjustSize> open(String path) async {
    final size = (await _call<Map<Object?, Object?>>('open', {'path': path}))!;
    return AdjustSize(size['width']! as int, size['height']! as int);
  }

  /// One part of the source, upright: RGBA bytes, premultiplied (Flutter's rgba8888).
  Future<Uint8List> read(AdjustRect rect) async => (await _call<Uint8List>('read', _rect(rect)))!;

  Future<void> createOutput(AdjustSize size) =>
      _call<void>('createOutput', {'width': size.width, 'height': size.height});

  /// A rendered tile (RGBA, premultiplied), copied into its place in the output.
  Future<void> write(AdjustRect tile, Uint8List pixels) => _call<void>('write', {..._rect(tile), 'pixels': pixels});

  /// Encodes the output to [path] as a JPEG (or PNG).
  Future<void> encode(String path, {required bool png, int quality = 92}) =>
      _call<void>('encode', {'path': path, 'png': png, 'quality': quality});

  /// Frees the source and the output.
  Future<void> close() => _call<void>('close');
}
