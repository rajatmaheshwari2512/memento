import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/infrastructure/repositories/local_asset.repository.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver_native.dart';
import 'package:immich_mobile/services/cleanup.service.dart';
import 'package:mocktail/mocktail.dart';

import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../repository.mocks.dart';
import '../service.mocks.dart';

void main() {
  late CleanupService sut;

  late MockLocalAssetRepository localAssetRepository;
  late MockAssetMediaRepository assetMediaRepository;
  late MockStorageSaverNative storageSaverNative;

  setUpAll(() => registerFallbackValue(AssetKeepType.none));

  setUp(() {
    localAssetRepository = MockLocalAssetRepository();
    assetMediaRepository = MockAssetMediaRepository();
    storageSaverNative = MockStorageSaverNative();
    sut = CleanupService(localAssetRepository, assetMediaRepository, storageSaverNative);
  });

  group('CleanupService.deleteLocalAssets', () {
    test('returns 0 and does nothing for empty input', () async {
      final result = await sut.deleteLocalAssets([]);

      expect(result, 0);
      verifyNever(() => assetMediaRepository.deleteAll(any()));
      verifyNever(() => localAssetRepository.deleteAssets(any()));
    });

    test('deletes in a single batch when under limit', () async {
      final ids = List.generate(999, (i) => 'asset-$i');

      when(() => assetMediaRepository.deleteAll(any())).thenAnswer((invocation) async {
        return (invocation.positionalArguments.first as List<String>).toList();
      });
      when(() => localAssetRepository.deleteAssets(any())).thenAnswer((_) async {});

      final result = await sut.deleteLocalAssets(ids);

      expect(result, ids.length);
      verify(() => assetMediaRepository.deleteAll(ids)).called(1);
      verify(() => localAssetRepository.deleteAssets(ids)).called(1);
    });

    test('deletes in platform-specific batches when over limit', () async {
      final batchSize = CurrentPlatform.isAndroid ? 2000 : 10000;
      final ids = List.generate(batchSize * 2 + 501, (i) => 'asset-$i');
      final capturedBatches = <List<String>>[];

      when(() => assetMediaRepository.deleteAll(any())).thenAnswer((invocation) async {
        final batch = (invocation.positionalArguments.first as List<String>).toList();
        capturedBatches.add(batch);
        return batch;
      });
      when(() => localAssetRepository.deleteAssets(any())).thenAnswer((_) async {});

      final result = await sut.deleteLocalAssets(ids);

      expect(result, ids.length);
      expect(capturedBatches.length, 3);
      expect(capturedBatches[0].length, batchSize);
      expect(capturedBatches[1].length, batchSize);
      expect(capturedBatches[2].length, 501);
      expect(capturedBatches[0].first, 'asset-0');
      expect(capturedBatches[0].last, 'asset-${batchSize - 1}');
      expect(capturedBatches[1].first, 'asset-$batchSize');
      expect(capturedBatches[1].last, 'asset-${batchSize * 2 - 1}');
      expect(capturedBatches[2].first, 'asset-${batchSize * 2}');
      expect(capturedBatches[2].last, 'asset-${batchSize * 2 + 500}');
      verify(() => localAssetRepository.deleteAssets(any())).called(3);
    });
  });

  group('CleanupService.getRemovalCandidates', () {
    final assets = [LocalAssetStub.image1.copyWith(id: '1'), LocalAssetStub.image1.copyWith(id: '2')];

    setUp(() {
      when(
        () => localAssetRepository.getRemovalCandidates(
          any(),
          any(),
          keepMediaType: any(named: 'keepMediaType'),
          keepFavorites: any(named: 'keepFavorites'),
          keepAlbumIds: any(named: 'keepAlbumIds'),
        ),
      ).thenAnswer((_) async => RemovalCandidatesResult(assets: assets, totalBytes: 10, hasStorageSaverCopies: true));
    });

    tearDown(() => debugDefaultTargetPlatformOverride = null);

    test('on Android sums the sizes of the files on the phone', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      when(() => storageSaverNative.sizes(['1', '2'])).thenAnswer((_) async => {'1': 1000, '2': 2000});

      final result = await sut.getRemovalCandidates('user', DateTime.now());

      expect(result.totalBytes, 3000);
      expect(result.assets, assets);
      expect(result.hasStorageSaverCopies, isTrue);
    });

    test('on Android shows no size when a file has no size', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      when(() => storageSaverNative.sizes(any())).thenAnswer((_) async => {'1': 1000});

      final result = await sut.getRemovalCandidates('user', DateTime.now());

      expect(result.totalBytes, 0);
    });

    test('on Android shows no size when the sizes can not be read', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      when(() => storageSaverNative.sizes(any())).thenThrow(const StorageSaverNativeException('failed', 'denied'));

      final result = await sut.getRemovalCandidates('user', DateTime.now());

      expect(result.totalBytes, 0);
    });

    test('on iOS keeps the size from the server', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;

      final result = await sut.getRemovalCandidates('user', DateTime.now());

      expect(result.totalBytes, 10);
      verifyNever(() => storageSaverNative.sizes(any()));
    });
  });
}
