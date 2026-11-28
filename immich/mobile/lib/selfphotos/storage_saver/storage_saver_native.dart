// SelfPhotos Storage saver: the native side of shrinking a video or photo before upload
// (android/.../selfphotos/StorageSaverPlugin.kt, ios/Runner/Selfphotos/StorageSaverPlugin.swift).
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

  /// Why it wasn't shrunk, e.g. hdr, alreadySmall or notSmaller.
  final String? reason;

  const StorageSaverResult({required this.shrunk, this.reason});

  /// Stopped by [StorageSaverNative.cancel]; the asset is left for the next backup.
  bool get isCancelled => reason == 'cancelled';

  factory StorageSaverResult.fromMap(Map<Object?, Object?> map) =>
      StorageSaverResult(shrunk: map['shrunk'] == true, reason: map['reason'] as String?);
}

class StorageSaverNative {
  const StorageSaverNative();

  static const _channel = MethodChannel('selfphotos/storage_saver');

  /// Shrinks [inputPath] into [outputPath], one at a time across the app, for the backup run [runId].
  /// [videoBitrate] is in bits per second; a video's short side is shrunk to at most [videoShortSide] pixels.
  Future<StorageSaverResult> shrink(
    String inputPath,
    String outputPath, {
    required StorageSaverKind kind,
    required int runId,
    int? videoBitrate,
    int? videoShortSide,
  }) async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>('shrink', {
        'inputPath': inputPath,
        'outputPath': outputPath,
        'kind': kind.name,
        'runId': runId,
        'videoBitrate': videoBitrate,
        'videoShortSide': videoShortSide,
      });
      return StorageSaverResult.fromMap(result!);
    } on PlatformException catch (e) {
      throw StorageSaverNativeException(e.code, e.message);
    }
  }

  /// The size on the phone, in bytes, of each of [localIds]; an id the phone no longer has is left out.
  /// Android only.
  Future<Map<String, int>> sizes(List<String> localIds) async {
    try {
      final result = await _channel.invokeMethod<Map<Object?, Object?>>('sizes', {'localIds': localIds});
      return {for (final MapEntry(:key, :value) in result!.entries) key! as String: (value! as num).toInt()};
    } on PlatformException catch (e) {
      throw StorageSaverNativeException(e.code, e.message);
    }
  }

  /// Stops [runId]'s running shrink, and the ones it already asked for.
  Future<void> cancel(int runId) => _channel.invokeMethod<void>('cancel', {'runId': runId});
}
