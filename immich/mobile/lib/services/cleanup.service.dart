import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/infrastructure/repositories/local_asset.repository.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/repositories/asset_media.repository.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver_native.dart';

final cleanupServiceProvider = Provider<CleanupService>((ref) {
  return CleanupService(
    ref.watch(driftProvider).localAssetRepository,
    ref.watch(assetMediaRepositoryProvider),
    const StorageSaverNative(),
  );
});

class CleanupService {
  static final int _deleteBatchSize = CurrentPlatform.isAndroid ? 2000 : 10000;

  final LocalAssetRepository _localAssetRepository;
  final AssetMediaRepository _assetMediaRepository;

  final StorageSaverNative _storageSaverNative;

  const CleanupService(this._localAssetRepository, this._assetMediaRepository, this._storageSaverNative);

  Future<RemovalCandidatesResult> getRemovalCandidates(
    String userId,
    DateTime cutoffDate, {
    AssetKeepType keepMediaType = AssetKeepType.none,
    bool keepFavorites = true,
    Set<String> keepAlbumIds = const {},
  }) async {
    final result = await _localAssetRepository.getRemovalCandidates(
      userId,
      cutoffDate,
      keepMediaType: keepMediaType,
      keepFavorites: keepFavorites,
      keepAlbumIds: keepAlbumIds,
    );
    return RemovalCandidatesResult(
      assets: result.assets,
      totalBytes: CurrentPlatform.isAndroid
          ? await _phoneBytes(result.assets)
          : (result.hasStorageSaverCopies ? 0 : result.totalBytes),
      hasStorageSaverCopies: result.hasStorageSaverCopies,
    );
  }

  /// The space [assets] take on the phone; 0 (shown as no size) when any of them can't be read.
  Future<int> _phoneBytes(List<LocalAsset> assets) async {
    try {
      final sizes = await _storageSaverNative.sizes(assets.map((asset) => asset.id).toList());
      var total = 0;
      for (final asset in assets) {
        final size = sizes[asset.id];
        if (size == null) {
          return 0;
        }
        total += size;
      }
      return total;
    } catch (_) {
      return 0;
    }
  }

  Future<int> deleteLocalAssets(List<String> localIds) async {
    if (localIds.isEmpty) {
      return 0;
    }

    int deletedCount = 0;

    for (int index = 0; index < localIds.length; index += _deleteBatchSize) {
      final end = index + _deleteBatchSize < localIds.length ? index + _deleteBatchSize : localIds.length;
      final batch = localIds.sublist(index, end);

      final deletedIds = await _assetMediaRepository.deleteAll(batch);
      if (deletedIds.isNotEmpty) {
        await _localAssetRepository.deleteAssets(deletedIds);
        deletedCount += deletedIds.length;
      }
    }

    return deletedCount;
  }

  /// Returns album IDs that should be kept by default (e.g., messaging app albums)
  Set<String> getDefaultKeepAlbumIds(List<(String id, String name)> albums) {
    const messagingApps = ['whatsapp', 'telegram', 'signal', 'messenger', 'viber', 'wechat', 'line'];

    final toKeep = <String>{};
    for (final (id, name) in albums) {
      final albumName = name.toLowerCase();
      if (messagingApps.any((app) => albumName.contains(app))) {
        toKeep.add(id);
      }
    }
    return toKeep;
  }
}
