// SelfPhotos Storage saver: the smaller copy a backup uploads in place of the phone's original.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:immich_mobile/domain/models/asset/asset_metadata.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver.service.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver_native.dart';
import 'package:logging/logging.dart';
import 'package:path/path.dart' as p;

final _logger = Logger('StorageSaverUpload');

const _folderPrefix = 'selfphotos-saver-';

/// The quality one backup run uploads at; [id] tells its shrinks apart from other runs'.
class StorageSaverRun {
  final BackupQuality quality;
  final int id;

  const StorageSaverRun(this.quality, this.id);

  static const original = StorageSaverRun(BackupQuality.original, 0);

  static int _lastId = 0;

  /// Reads the quality for a run ([original] when it can't be read). Completing [cancelToken] stops the run's
  /// shrinks.
  static Future<StorageSaverRun> start(
    StorageSaverService service,
    StorageSaverNative native,
    Completer<void>? cancelToken,
  ) async {
    unawaited(deleteStaleFolders());
    try {
      final quality = await service.backupQuality();
      if (cancelToken?.isCompleted ?? false) {
        return original;
      }
      final run = StorageSaverRun(quality, ++_lastId);
      if (quality != BackupQuality.original && cancelToken != null) {
        unawaited(cancelToken.future.then((_) => native.cancel(run.id)).catchError((Object _) {}));
      }
      _logger.info("Storage saver quality for this run: ${quality.name}");
      return run;
    } catch (error) {
      _logger.warning("Couldn't read the Storage saver quality, uploading originals: $error");
      return original;
    }
  }
}

/// Deletes the temporary folders of shrinks that were cut short (the app was killed), once they're [maxAge] old.
/// [root] is where they are; ignores errors.
Future<void> deleteStaleFolders({Directory? root, Duration maxAge = const Duration(hours: 24)}) async {
  try {
    final cutoff = DateTime.now().subtract(maxAge);
    await for (final entity in (root ?? Directory.systemTemp).list()) {
      if (entity is Directory && p.basename(entity.path).startsWith(_folderPrefix)) {
        try {
          if (entity.statSync().modified.isBefore(cutoff)) {
            await entity.delete(recursive: true);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/// A shrunk copy ready to upload.
class StorageSaverCopy {
  final File file;
  final String checksum;
  final String originalChecksum;
  final BackupQuality quality;

  const StorageSaverCopy({
    required this.file,
    required this.checksum,
    required this.originalChecksum,
    required this.quality,
  });

  /// [originalFileName] with the copy's extension.
  String fileName(String originalFileName) => p.setExtension(originalFileName, p.extension(file.path));

  /// The upload's `metadata` field.
  String get metadata => jsonEncode([
    RemoteAssetMetadataItem(
      key: RemoteAssetMetadataKey.storageSaver,
      value: RemoteAssetStorageSaverMetadata(originalChecksum: originalChecksum, quality: quality.name),
    ),
  ]);
}

/// One asset's Storage saver shrink, in a temporary folder of its own. Call [dispose] when the upload is done.
class StorageSaverUpload {
  final StorageSaverNative _native;
  Directory? _folder;
  bool _cancelled = false;

  StorageSaverUpload(this._native);

  /// Stopped by the run's cancel token; the asset is left for the next backup.
  bool get isCancelled => _cancelled;

  /// Shrinks [file] for [run]; null means upload the original.
  Future<StorageSaverCopy?> prepare(LocalAsset asset, File file, StorageSaverRun run) async {
    final copyName = _copyName(asset, file);
    if (run.quality == BackupQuality.original || copyName == null) {
      return null;
    }
    try {
      final originalChecksum = asset.checksum ?? await _checksum(file);
      final folder = _folder = await (await Directory.systemTemp.create(recursive: true)).createTemp(_folderPrefix);
      final output = File(p.join(folder.path, copyName));
      final result = await _native.shrink(
        file.path,
        output.path,
        kind: asset.type == AssetType.video ? StorageSaverKind.video : StorageSaverKind.photo,
        runId: run.id,
        videoBitrate: run.quality.videoBitrate,
      );
      if (result.isCancelled) {
        _cancelled = true;
        return null;
      }
      if (!result.shrunk) {
        _logger.info("Storage saver kept ${asset.id} - ${asset.name} full size: ${result.reason}");
        return null;
      }
      final checksum = await _checksum(output);
      _logger.info("Storage saver shrank ${asset.id} - ${asset.name} to ${await output.length()} bytes");
      return StorageSaverCopy(
        file: output,
        checksum: checksum,
        originalChecksum: originalChecksum,
        quality: run.quality,
      );
    } catch (error) {
      _logger.warning("Storage saver couldn't shrink ${asset.id} - ${asset.name}, uploading the original: $error");
      return null;
    }
  }

  /// The copy's file name: on iOS a photo keeps [file]'s format and a video becomes QuickTime. Null when an iOS
  /// photo's format can't be named.
  String? _copyName(LocalAsset asset, File file) => switch ((asset.type == AssetType.video, CurrentPlatform.isIOS)) {
    (true, true) => 'copy.mov',
    (true, false) => 'copy.mp4',
    (false, true) => p.extension(file.path).isEmpty ? null : 'copy${p.extension(file.path).toLowerCase()}',
    (false, false) => 'copy.jpg',
  };

  /// The base64 SHA-1 of [file], as the app stores checksums.
  Future<String> _checksum(File file) async => base64.encode((await sha1.bind(file.openRead()).first).bytes);

  Future<void> dispose() async {
    try {
      await _folder?.delete(recursive: true);
    } catch (error) {
      _logger.warning("Couldn't delete Storage saver's temporary files: $error");
    }
  }
}
