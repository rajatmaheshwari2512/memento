// SelfPhotos Storage saver: the Android side of shrinking a video or photo before upload
// (android/.../selfphotos/StorageSaverPlugin.kt).
import 'package:flutter/services.dart';

/// Why a shrink failed on the device.
class StorageSaverNativeException implements Exception {
  final String code;
  final String? message;

  const StorageSaverNativeException(this.code, this.message);

  @override
  String toString() => message ?? code;
}

enum StorageSaverKind { video, photo }

class StorageSaverResult {
  final bool shrunk;

  /// The shrunk copy's size in bytes.
  final int? size;

  /// The shrunk copy's base64 SHA-1, as local_asset_entity.checksum stores it.
  final String? checksum;

  /// Why it wasn't shrunk, e.g. hdr, alreadySmall or notSmaller.
  final String? reason;

  const StorageSaverResult({required this.shrunk, this.size, this.checksum, this.reason});

  /// Stopped by [StorageSaverNative.cancel]; the asset is left for the next backup.
  bool get isCancelled => reason == 'cancelled';

  factory StorageSaverResult.fromMap(Map<Object?, Object?> map) => StorageSaverResult(
    shrunk: map['shrunk'] == true,
    size: map['size'] as int?,
    checksum: map['checksum'] as String?,
    reason: map['reason'] as String?,
  );
}

class StorageSaverNative {
  const StorageSaverNative();

  static const _channel = MethodChannel('selfphotos/storage_saver');

  /// Shrinks [inputPath] into [outputPath], one at a time across the app. [videoBitrate] is in bits per second.
  Future<StorageSaverResult> shrink(
    String inputPath,
    String outputPath, {
    required StorageSaverKind kind,
    int? videoBitrate,
  }) async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>('shrink', {
        'inputPath': inputPath,
        'outputPath': outputPath,
        'kind': kind.name,
        'videoBitrate': videoBitrate,
      });
      return StorageSaverResult.fromMap(result!);
    } on PlatformException catch (e) {
      throw StorageSaverNativeException(e.code, e.message);
    }
  }

  /// Stops the running shrink, and the ones already asked for.
  Future<void> cancel() => _channel.invokeMethod<void>('cancel');
}
