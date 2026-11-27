import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/platform/connectivity_api.g.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver.service.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver_native.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver_upload.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:mocktail/mocktail.dart';

import '../api.mocks.dart';
import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../mocks/asset_entity.mock.dart';
import '../repository.mocks.dart';
import '../service.mocks.dart';
import 'work_folder_stub.dart';

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
    stubWorkFolderRoot();
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
    when(() => mockStorageSaverNative.cancel(any())).thenAnswer((_) async {});

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

  group('Storage saver uploads', () {
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
          runId: any(named: 'runId'),
          videoBitrate: any(named: 'videoBitrate'),
          videoShortSide: any(named: 'videoShortSide'),
          shrinkHdr: any(named: 'shrinkHdr'),
        ),
      ).thenAnswer((invocation) async {
        final result = answer();
        if (result.shrunk) {
          File(invocation.positionalArguments[1] as String).writeAsStringSync('copy');
        }
        return result;
      });
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

    const shrunk = StorageSaverResult(shrunk: true);
    // base64 SHA-1 of the stubbed copy's content, 'copy'
    const copySha = '+E4uLa3Yc4T7VfJYhpJrd36DePE=';

    setUp(() => when(() => mockStorageRepository.clearCache()).thenAnswer((_) async {}));

    tearDown(() => debugDefaultTargetPlatformOverride = null);

    test('uploads the shrunk copy with its original\'s checksum', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        photo,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

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
          runId: 1,
          videoBitrate: 4000000,
          videoShortSide: 1080,
          shrinkHdr: false,
        ),
      ).called(1);
    });

    test('asks the shrink to include HDR videos when the run says so', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => shrunk);
      captureUploads();

      await sut.uploadSingleAsset(
        photo,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1, shrinkHdr: true),
      );

      verify(
        () => mockStorageSaverNative.shrink(
          any(),
          any(),
          kind: any(named: 'kind'),
          runId: 1,
          videoBitrate: any(named: 'videoBitrate'),
          videoShortSide: any(named: 'videoShortSide'),
          shrinkHdr: true,
        ),
      ).called(1);
    });

    test('links the original to the copy and stacks on the copy\'s checksum', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => shrunk);
      captureUploads();

      await sut.uploadSingleAsset(
        photo,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      verifyInOrder([
        () => mockAssetService.linkStorageSaverCopy(photo.id, 'original-sha', copySha),
        () => mockAssetService.stackEditedUpload(photo.localId!, 'remote-1', copySha),
      ]);
    });

    test('hashes an original the app has not hashed yet and links it by that hash', () async {
      final folder = Directory.systemTemp.createTempSync('saver-test-');
      addTearDown(() => folder.deleteSync(recursive: true));
      final original = File('${folder.path}/photo.jpg')..writeAsStringSync('original');
      final unhashed = LocalAsset(
        id: photo.id,
        name: photo.name,
        type: photo.type,
        createdAt: photo.createdAt,
        updatedAt: photo.updatedAt,
        playbackStyle: photo.playbackStyle,
        isEdited: false,
      );
      stubAsset(unhashed, original.path, 'photo.jpg');
      stubShrink(() => shrunk);
      final uploads = captureUploads();
      // base64 SHA-1 of 'original'
      final originalSha = base64.encode(sha1.convert(utf8.encode('original')).bytes);

      await sut.uploadSingleAsset(
        unhashed,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(jsonDecode(uploads.single.fields['metadata']!), [
        {
          'key': 'memento-storage-saver',
          'value': {'originalChecksum': originalSha, 'quality': 'saver'},
        },
      ]);
      verify(() => mockAssetService.linkStorageSaverCopy(unhashed.id, originalSha, copySha)).called(1);
    });

    test('on iOS links an edited photo by the app\'s own hash of it', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final edited = photo.copyWith(checksum: 'edited-sha', isEdited: true, adjustmentTime: DateTime(2024));
      stubAsset(edited, '/path/to/FullSizeRender.heic', 'IMG_0001.HEIC');
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        edited,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(jsonDecode(uploads.single.fields['metadata']!), [
        {
          'key': 'memento-storage-saver',
          'value': {'originalChecksum': 'edited-sha', 'quality': 'saver'},
        },
      ]);
      verify(() => mockAssetService.linkStorageSaverCopy(edited.id, 'edited-sha', copySha)).called(1);
    });

    test('keeps a Live Photo full size, with its iCloud metadata', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final livePhoto = photo.copyWith(cloudId: 'cloud-id');
      stubAsset(livePhoto, '/path/to/IMG_0001.HEIC', 'IMG_0001.HEIC');
      final mockEntity = MockAssetEntity();
      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(livePhoto)).thenAnswer((_) async => mockEntity);
      when(
        () => mockStorageRepository.getMotionFileForAsset(livePhoto),
      ).thenAnswer((_) async => File('/path/to/IMG_0001.MOV'));
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        livePhoto,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(uploads.map((upload) => upload.path), ['/path/to/IMG_0001.MOV', '/path/to/IMG_0001.HEIC']);
      expect(uploads.last.fields['metadata'], contains('mobile-app'));
      expect(uploads.last.fields['livePhotoVideoId'], 'remote-1');
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('names a shrunk video after the original with the copy\'s extension', () async {
      stubAsset(video, '/path/to/clip.mov', 'clip.mov');
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        video,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saverHigh, 1),
      );

      expect(uploads.single.name, 'clip.mp4');
      expect(jsonDecode(uploads.single.fields['metadata']!), [
        {
          'key': 'memento-storage-saver',
          'value': {'originalChecksum': 'original-sha', 'quality': 'saverHigh'},
        },
      ]);
      verify(
        () => mockStorageSaverNative.shrink(
          any(),
          any(),
          kind: StorageSaverKind.video,
          runId: 1,
          videoBitrate: 8000000,
          videoShortSide: 1440,
          shrinkHdr: false,
        ),
      ).called(1);
      expect(File(uploads.single.path).existsSync(), isFalse);
    });

    test('uploads the original when the copy is not kept', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      stubShrink(() => const StorageSaverResult(shrunk: false, reason: 'notSmaller'));
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        photo,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

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
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
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
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(uploads.map((upload) => upload.path), ['/path/to/photo.jpg', '/path/to/photo.jpg']);
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('reads the quality once per run', () async {
      final assets = [for (var i = 0; i < 3; i++) photo.copyWith(id: 'photo$i')];
      for (final asset in assets) {
        stubAsset(asset, '/path/to/photo.jpg', 'photo.jpg');
      }
      when(
        () => mockStorageSaverService.backupSettings(),
      ).thenAnswer((_) async => (quality: BackupQuality.saver, shrinkHdr: false));
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadManual(assets);

      verify(() => mockStorageSaverService.backupSettings()).called(1);
      expect(uploads, hasLength(3));
      expect(uploads.every((upload) => upload.fields.containsKey('metadata')), isTrue);
    });

    test('reads the quality once per backup run, in either upload mode', () async {
      final assets = [for (var i = 0; i < 3; i++) photo.copyWith(id: 'photo$i')];
      for (final asset in assets) {
        stubAsset(asset, '/path/to/photo.jpg', 'photo.jpg');
      }
      when(() => mockBackupRepository.getCandidates('user-id')).thenAnswer((_) async => assets);
      when(() => mockConnectivityApi.getCapabilities()).thenAnswer((_) async => [NetworkCapability.unmetered]);
      when(
        () => mockStorageSaverService.backupSettings(),
      ).thenAnswer((_) async => (quality: BackupQuality.saver, shrinkHdr: false));
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadCandidates('user-id', Completer<void>());
      verify(() => mockStorageSaverService.backupSettings()).called(1);
      await sut.uploadCandidates('user-id', Completer<void>(), useSequentialUpload: true);
      verify(() => mockStorageSaverService.backupSettings()).called(1);

      expect(uploads, hasLength(6));
      expect(uploads.every((upload) => upload.fields.containsKey('metadata')), isTrue);
    });

    test('uploads originals when the quality is original or can\'t be read', () async {
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      final uploads = captureUploads();

      when(
        () => mockStorageSaverService.backupSettings(),
      ).thenAnswer((_) async => (quality: BackupQuality.original, shrinkHdr: false));
      await sut.uploadManual([photo]);
      when(() => mockStorageSaverService.backupSettings()).thenThrow(Exception('offline'));
      await sut.uploadManual([photo]);

      expect(uploads.map((upload) => upload.path), ['/path/to/photo.jpg', '/path/to/photo.jpg']);
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('shrinks on iOS too', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      when(
        () => mockStorageSaverService.backupSettings(),
      ).thenAnswer((_) async => (quality: BackupQuality.saver, shrinkHdr: false));
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadManual([photo]);

      verify(() => mockStorageSaverService.backupSettings()).called(1);
      expect(uploads.single.path, endsWith('/copy.jpg'));
      expect(uploads.single.fields['metadata'], contains('memento-storage-saver'));
    });

    test('on iOS keeps a HEIC photo as HEIC', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      stubAsset(photo, '/path/to/IMG_0001.HEIC', 'IMG_0001.HEIC');
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        photo,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(uploads.single.path, endsWith('/copy.heic'));
      expect(uploads.single.name, 'IMG_0001.heic');
    });

    test('on iOS keeps a photo with no extension full size', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      stubAsset(photo, '/path/to/DJI_0001', 'DJI_0001');
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        photo,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(uploads.single.path, '/path/to/DJI_0001');
      verifyZeroInteractions(mockStorageSaverNative);
    });

    test('on iOS names a shrunk video as QuickTime', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      stubAsset(video, '/path/to/clip.mov', 'clip.mov');
      stubShrink(() => shrunk);
      final uploads = captureUploads();

      await sut.uploadSingleAsset(
        video,
        null,
        callbacks: const UploadCallbacks(),
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(uploads.single.path, endsWith('/copy.mov'));
      expect(uploads.single.name, 'clip.mov');
    });

    int capturedRunId() =>
        verify(
              () => mockStorageSaverNative.shrink(
                any(),
                any(),
                kind: any(named: 'kind'),
                runId: captureAny(named: 'runId'),
                videoBitrate: any(named: 'videoBitrate'),
                videoShortSide: any(named: 'videoShortSide'),
                shrinkHdr: any(named: 'shrinkHdr'),
              ),
            ).captured.single
            as int;

    test('cancels the shrink when the run is cancelled', () async {
      final cancelToken = Completer<void>();
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      when(
        () => mockStorageSaverService.backupSettings(),
      ).thenAnswer((_) async => (quality: BackupQuality.saver, shrinkHdr: false));
      stubShrink(() {
        cancelToken.complete();
        return const StorageSaverResult(shrunk: false, reason: 'cancelled');
      });
      final uploads = captureUploads();

      await sut.uploadManual([photo], cancelToken: cancelToken);
      await pumpEventQueue();

      final runId = capturedRunId();
      verify(() => mockStorageSaverNative.cancel(runId)).called(1);
      expect(uploads, isEmpty);
    });

    test('cancelling one run leaves another run\'s shrinks alone', () async {
      final cancelA = Completer<void>();
      final cancelB = Completer<void>();
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      when(
        () => mockStorageSaverService.backupSettings(),
      ).thenAnswer((_) async => (quality: BackupQuality.saver, shrinkHdr: false));
      stubShrink(() => shrunk);
      captureUploads();

      await sut.uploadManual([photo], cancelToken: cancelA);
      final runA = capturedRunId();
      await sut.uploadManual([photo], cancelToken: cancelB);
      final runB = capturedRunId();
      cancelA.complete();
      await pumpEventQueue();

      expect(runB, isNot(runA));
      verify(() => mockStorageSaverNative.cancel(runA)).called(1);
      verifyNever(() => mockStorageSaverNative.cancel(runB));
    });

    test('a run cancelled while reading the quality leaves other runs\' shrinks alone', () async {
      final cancelToken = Completer<void>()..complete();
      stubAsset(photo, '/path/to/photo.jpg', 'photo.jpg');
      when(
        () => mockStorageSaverService.backupSettings(),
      ).thenAnswer((_) async => (quality: BackupQuality.saver, shrinkHdr: false));
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
        storageSaver: const StorageSaverRun(BackupQuality.saver, 1),
      );

      expect(uploads, isEmpty);
      expect(errors, isEmpty);
    });
  });

  group('deleteStaleFolders', () {
    test('deletes the Storage saver folders older than a day and keeps the newer ones', () async {
      final root = Directory.systemTemp.createTempSync('stale-test-');
      addTearDown(() => root.deleteSync(recursive: true));
      final old = Directory('${root.path}/selfphotos-saver-old')..createSync();
      File('${old.path}/copy.mp4').writeAsStringSync('copy');
      final fresh = Directory('${root.path}/selfphotos-saver-new')..createSync();
      final other = Directory('${root.path}/other-old')..createSync();
      for (final folder in [old, other]) {
        await Process.run('touch', ['-t', '202001010000', folder.path]);
      }

      await deleteStaleFolders(root: root);

      expect(old.existsSync(), isFalse);
      expect(fresh.existsSync(), isTrue);
      expect(other.existsSync(), isTrue);
    });
  });
}
