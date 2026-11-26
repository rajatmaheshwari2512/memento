import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver.service.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver_native.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:mocktail/mocktail.dart';

import '../api.mocks.dart';
import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../mocks/asset_entity.mock.dart';
import '../repository.mocks.dart';
import '../service.mocks.dart';

void main() {
  late ForegroundUploadService sut;
  late MockUploadRepository mockUploadRepository;
  late MockStorageRepository mockStorageRepository;
  late MockBackupRepository mockBackupRepository;
  late MockConnectivityApi mockConnectivityApi;
  late MockAssetMediaRepository mockAssetMediaRepository;
  late MockAssetService mockAssetService;
  late MockStorageSaverService mockStorageSaverService;
  late MockStorageSaverNative mockStorageSaverNative;
  late Drift db;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async => 'test',
    );
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
    await SettingsRepository.ensureInitialized(db);

    await Store.put(StoreKey.serverEndpoint, 'http://demo.immich.app');
    await Store.put(StoreKey.deviceId, 'device-id');

    registerFallbackValue(File('file'));
    registerFallbackValue(<String, String>{});
    registerFallbackValue(StorageSaverKind.photo);
  });

  setUp(() {
    mockUploadRepository = MockUploadRepository();
    mockStorageRepository = MockStorageRepository();
    mockBackupRepository = MockBackupRepository();
    mockConnectivityApi = MockConnectivityApi();
    mockAssetMediaRepository = MockAssetMediaRepository();
    mockAssetService = MockAssetService();
    mockStorageSaverService = MockStorageSaverService();
    mockStorageSaverNative = MockStorageSaverNative();
    when(() => mockAssetService.getLocalAsset(any())).thenAnswer((_) async => null);
    when(() => mockAssetService.stackEditedUpload(any(), any(), any())).thenAnswer((_) async {});
    when(() => mockAssetService.linkStorageSaverCopy(any(), any(), any())).thenAnswer((_) async {});
    when(() => mockStorageSaverNative.cancel()).thenAnswer((_) async {});

    sut = ForegroundUploadService(
      mockUploadRepository,
      mockStorageRepository,
      mockBackupRepository,
      mockConnectivityApi,
      mockAssetMediaRepository,
      mockAssetService,
      mockStorageSaverService,
      mockStorageSaverNative,
    );
  });

  List<Map<String, String>> captureFields() {
    final captured = <Map<String, String>>[];
    when(
      () => mockUploadRepository.uploadFile(
        file: any(named: 'file'),
        originalFileName: any(named: 'originalFileName'),
        fields: any(named: 'fields'),
        cancelToken: any(named: 'cancelToken'),
        onProgress: any(named: 'onProgress'),
        logContext: any(named: 'logContext'),
      ),
    ).thenAnswer((invocation) async {
      final fields = invocation.namedArguments[#fields] as Map<String, String>;
      captured.add(Map.of(fields));
      return UploadResult.success(remoteAssetId: 'remote-${captured.length}');
    });
    return captured;
  }

  List<String> captureOriginalFileNames() {
    final captured = <String>[];
    when(
      () => mockUploadRepository.uploadFile(
        file: any(named: 'file'),
        originalFileName: any(named: 'originalFileName'),
        fields: any(named: 'fields'),
        cancelToken: any(named: 'cancelToken'),
        onProgress: any(named: 'onProgress'),
        logContext: any(named: 'logContext'),
      ),
    ).thenAnswer((invocation) async {
      captured.add(invocation.namedArguments[#originalFileName] as String);
      return UploadResult.success(remoteAssetId: 'remote-${captured.length}');
    });
    return captured;
  }

  group('uploadSingleAsset', () {
    test('should upload the motion part hidden and keep the still image visible', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/still.heic');
      final videoFile = File('/path/to/motion.mov');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockStorageRepository.getMotionFileForAsset(asset)).thenAnswer((_) async => videoFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'live.heic');

      final captured = captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(captured, hasLength(2));
      expect(captured[0]['visibility'], equals('hidden'));
      expect(captured[0].containsKey('livePhotoVideoId'), isFalse);
      expect(captured[1].containsKey('visibility'), isFalse);
      expect(captured[1]['livePhotoVideoId'], equals('remote-1'));
    });

    test('should not set visibility for a regular photo', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/photo.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'photo.jpg');

      final captured = captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(captured, hasLength(1));
      expect(captured[0].containsKey('visibility'), isFalse);
    });

    test('corrects the extension when iOS returns a rendered file for a .dng asset', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/IMG_6499.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_6499.dng');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['IMG_6499.jpg']));
    });

    test('keeps the .dng extension for a genuine RAW original', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/IMG_5210.dng');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_5210.dng');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['IMG_5210.dng']));
    });

    test('borrows the extension from the asset name for an extensionless name (DJI/Fusion)', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/DJI_0001');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'DJI_0001');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['DJI_0001.jpg']));
    });

    test('stacks a plain photo after its upload', () async {
      final asset = LocalAssetStub.image1.copyWith(checksum: 'sha');
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/photo.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'photo.jpg');
      captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      verify(() => mockAssetService.getLocalAsset(asset.id)).called(1);
      verify(() => mockAssetService.stackEditedUpload(asset.localId!, 'remote-1', 'sha')).called(1);
      verifyNoMoreInteractions(mockAssetService);
    });

    test('stacks the still of a live photo, not its video', () async {
      final asset = LocalAssetStub.image1.copyWith(checksum: 'sha');
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/still.heic');
      final videoFile = File('/path/to/motion.mov');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockStorageRepository.getMotionFileForAsset(asset)).thenAnswer((_) async => videoFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'live.heic');
      captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      verify(() => mockAssetService.getLocalAsset(asset.id)).called(1);
      verify(() => mockAssetService.stackEditedUpload(asset.localId!, 'remote-2', 'sha')).called(1);
      verifyNoMoreInteractions(mockAssetService);
    });

    test('does not upload a photo the server already has', () async {
      final asset = LocalAssetStub.image1.copyWith(checksum: 'sha');
      final succeeded = <String>[];
      when(() => mockAssetService.getLocalAsset(asset.id)).thenAnswer((_) async => asset.copyWith(remoteId: 'remote'));

      await sut.uploadSingleAsset(
        asset,
        null,
        callbacks: UploadCallbacks(onSuccess: (_, remoteId) => succeeded.add(remoteId)),
      );

      expect(succeeded, equals(['remote']));
      verify(() => mockAssetService.stackEditedUpload(asset.localId!, 'remote', 'sha')).called(1);
      verifyZeroInteractions(mockStorageRepository);
      verifyZeroInteractions(mockUploadRepository);
    });
  });

  group('Storage saver', () {
    final photo = LocalAssetStub.image1.copyWith(checksum: 'original-sha');
    final video = LocalAssetStub.image1.copyWith(
      id: 'video1',
      name: 'clip.mov',
      type: AssetType.video,
      checksum: 'original-sha',
    );

    void stubAsset(LocalAsset asset, String path, String name) {
      final mockEntity = MockAssetEntity();
      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => File(path));
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => name);
    }

    void stubShrink(StorageSaverResult Function() answer) {
      when(
        () => mockStorageSaverNative.shrink(
          any(),
          any(),
          kind: any(named: 'kind'),
          videoBitrate: any(named: 'videoBitrate'),
        ),
      ).thenAnswer((_) async => answer());
    }

    List<({String path, String name, Map<String, String> fields})> captureUploads() {
      final captured = <({String path, String name, Map<String, String> fields})>[];
      when(
        () => mockUploadRepository.uploadFile(
          file: any(named: 'file'),
          originalFileName: any(named: 'originalFileName'),
          fields: any(named: 'fields'),
          cancelToken: any(named: 'cancelToken'),
          onProgress: any(named: 'onProgress'),
          logContext: any(named: 'logContext'),
        ),
      ).thenAnswer((invocation) async {
        captured.add((
          path: (invocation.namedArguments[#file] as File).path,
          name: invocation.namedArguments[#originalFileName] as String,
          fields: Map.of(invocation.namedArguments[#fields] as Map<String, String>),
        ));
        return UploadResult.success(remoteAssetId: 'remote-${captured.length}');
      });
      return captured;
    }

    const shrunk = StorageSaverResult(shrunk: true, size: 100, checksum: 'copy-sha');

    setUp(() => when(() => mockStorageRepository.clearCache()).thenAnswer((_) async {}));

    tearDown(() => debugDefaultTargetPlatformOverride = null);

    test('uploads the shrunk copy with its original\'s checksum', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadSingleAsset(photo, null, callbacks: const UploadCallbacks(), storageSaver: BackupQuality.saver);

      expect(uploads, hasLength(1));
      expect(uploads[0].path, endsWith('/copy.jpg'));
      expect(uploads[0].path, isNot('/path/to/photo.jpg'));
      expect(uploads[0].name, 'photo.jpg');
      expect(
        uploads[0].fields['metadata'],
        '[{"key":"memento-storage-saver","value":{"originalChecksum":"original-sha","quality":"saver"}}]',
      );
      verify(
        () => mockStorageSaverNative.shrink(
          '/path/to/photo.jpg',
          any(),
          kind: StorageSaverKind.photo,
          videoBitrate: 4000000,
        ),
      ).called(1);
    });

    test('links the original to the copy and stacks on the copy\'s checksum', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => shrunk);
      captureUploads();

      await sut.uploadSingleAsset(photo, null, callbacks: const UploadCallbacks(), storageSaver: BackupQuality.saver);

      verifyInOrder([
        () => mockAssetService.linkStorageSaverCopy(photo.id, 'original-sha', 'copy-sha'),
        () => mockAssetService.stackEditedUpload(photo.localId!, 'remote-1', 'copy-sha'),
      ]);
    });

    test('names a shrunk video after the original with the copy\'s extension', () async {
      stubAsset(video, '/path/to/clip.mov', 'clip.mov');
      when(
        () => mockStorageSaverNative.shrink(
          any(),
          any(),
          kind: any(named: 'kind'),
          videoBitrate: any(named: 'videoBitrate'),
        ),
      ).thenAnswer((invocation) async {
        File(invocation.positionalArguments[1] as String).writeAsStringSync('copy');
        return shrunk;
      });
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        video,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: BackupQuality.saverHigh,
      );

      expect(uploads.single.name, 'clip.mp4');
      expect(jsonDecode(uploads.single.fields['metadata']!), [
        {
          'key': 'memento-storage-saver',
          'value': {'originalChecksum': 'original-sha', 'quality': 'saverHigh'},
        },
      ]);
      verify(
        () => mockStorageSaverNative.shrink(any(), any(), kind: StorageSaverKind.video, videoBitrate: 8000000),
      ).called(1);
      expect(File(uploads.single.path).existsSync(), isFalse);
    });

    test('uploads the original when the copy is not kept', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => const StorageSaverResult(shrunk: false, reason: 'notSmaller'));
      final uploads = captureUploads();

      await sut.uploadSingleAsset(photo, null, callbacks: const UploadCallbacks(), storageSaver: BackupQuality.saver);

      expect(uploads.single.path, '/path/to/photo.jpg');
      expect(uploads.single.fields.containsKey('metadata'), isFalse);
      verifyNever(() => mockAssetService.linkStorageSaverCopy(any(), any(), any()));
      verify(() => mockAssetService.stackEditedUpload(photo.localId!, 'remote-1', 'original-sha')).called(1);
    });

    test('uploads the original when shrinking fails', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => throw const StorageSaverNativeException('failed', 'No space left on device'));
      final errors = <String>[];
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        photo,
        null,
        callbacks: UploadCallbacks(onError: (_, message) => errors.add(message)),
        storageSaver: BackupQuality.saver,
      );

      expect(uploads.single.path, '/path/to/photo.jpg');
      expect(uploads.single.fields.containsKey('metadata'), isFalse);
      expect(errors, isEmpty);
      verify(() => mockAssetService.stackEditedUpload(photo.localId!, 'remote-1', 'original-sha')).called(1);
    });

    test('does not shrink at original quality, or an asset with no checksum', () async {
      final unhashed = LocalAssetStub.image1;
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubAsset(unhashed, '/path/to/photo.jpg', 'photo.jpg');
      final uploads = captureUploads();

      await sut.uploadSingleAsset(photo, null, callbacks: const UploadCallbacks());
      await sut.uploadSingleAsset(
        unhashed,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: BackupQuality.saver,
      );

      expect(uploads.map((upload) => upload.path), ['/path/to/photo.jpg', '/path/to/photo.jpg']);
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('reads the quality once per run', () async {
      final assets = [for (var i = 0; i < 3; i++) photo.copyWith(id: 'photo$i')];
      for (final asset in assets) {
        stubAsset(asset, '/path/to/photo.jpg', 'photo.jpg');
      }
      when(() => mockStorageSaverService.backupQuality()).thenAnswer((_) async => BackupQuality.saver);
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadManual(assets);

      verify(() => mockStorageSaverService.backupQuality()).called(1);
      expect(uploads, hasLength(3));
      expect(uploads.every((upload) => upload.fields.containsKey('metadata')), isTrue);
    });

    test('uploads originals when the quality is original or can\'t be read', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      final uploads = captureUploads();

      when(() => mockStorageSaverService.backupQuality()).thenAnswer((_) async => BackupQuality.original);
      await sut.uploadManual([photo]);
      when(() => mockStorageSaverService.backupQuality()).thenThrow(Exception('offline'));
      await sut.uploadManual([photo]);

      expect(uploads.map((upload) => upload.path), ['/path/to/photo.jpg', '/path/to/photo.jpg']);
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('does not shrink on iOS', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      when(() => mockStorageSaverService.backupQuality()).thenAnswer((_) async => BackupQuality.saver);
      final uploads = captureUploads();

      await sut.uploadManual([photo]);

      expect(uploads.single.path, '/path/to/photo.jpg');
      verifyNever(() => mockStorageSaverService.backupQuality());
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('cancels the shrink when the run is cancelled', () async {
      final cancelToken = Completer<void>();
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      when(() => mockStorageSaverService.backupQuality()).thenAnswer((_) async => BackupQuality.saver);
      stubShrink(() {
        cancelToken.complete();
        return const StorageSaverResult(shrunk: false, reason: 'cancelled');
      });
      final uploads = captureUploads();

      await sut.uploadManual([photo], cancelToken: cancelToken);
      await pumpEventQueue();

      verify(() => mockStorageSaverNative.cancel()).called(1);
      expect(uploads, isEmpty);
    });

    test('a run cancelled while reading the quality leaves other runs\' shrinks alone', () async {
      final cancelToken = Completer<void>()..complete();
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      when(() => mockStorageSaverService.backupQuality()).thenAnswer((_) async => BackupQuality.saver);
      final uploads = captureUploads();

      await sut.uploadManual([photo], cancelToken: cancelToken);
      await pumpEventQueue();

      expect(uploads, isEmpty);
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('leaves an asset whose shrink was cancelled for the next backup', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => const StorageSaverResult(shrunk: false, reason: 'cancelled'));
      final errors = <String>[];
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        photo,
        Completer<void>(),
        callbacks: UploadCallbacks(onError: (_, message) => errors.add(message)),
        storageSaver: BackupQuality.saver,
      );

      expect(uploads, isEmpty);
      expect(errors, isEmpty);
    });
  });
}
