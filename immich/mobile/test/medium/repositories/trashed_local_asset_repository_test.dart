import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/infrastructure/repositories/local_asset.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/trashed_local_asset.repository.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late TrashedLocalAssetRepository sut;

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = TrashedLocalAssetRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  group('getToRestore', () {
    late String userId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
    });

    test('does not restore based on a partner\'s live remote copy', () async {
      const checksum = 'shared-partner-checksum';
      final album = await ctx.newLocalAlbum(backupSelection: BackupSelection.selected);
      final trashed = await ctx.newTrashedLocalAsset(albumId: album.id, checksum: checksum);

      // Current user's own remote copy is deleted; only a partner has an active copy.
      await ctx.newRemoteAsset(ownerId: userId, checksum: checksum, deletedAt: DateTime(2020, 1, 1));
      final partner = await ctx.newUser();
      await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum);

      final result = await sut.getToRestore();

      final ids = result.map((a) => a.id);
      expect(ids, isNot(contains(trashed.id)));
    });

    test('restores when the current user\'s own remote copy is live', () async {
      const checksum = 'my-live-copy';
      final album = await ctx.newLocalAlbum(backupSelection: BackupSelection.selected);
      final trashed = await ctx.newTrashedLocalAsset(albumId: album.id, checksum: checksum);
      await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);

      final result = await sut.getToRestore();

      final ids = result.map((a) => a.id);
      expect(ids, contains(trashed.id));
    });
  });

  group('getToTrash', () {
    late String userId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
    });

    Future<String> addLocalAssetToBackupAlbum(String checksum) async {
      final album = await ctx.newLocalAlbum(backupSelection: BackupSelection.selected);
      final local = await ctx.newLocalAsset(checksum: checksum);
      await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
      return local.id;
    }

    test('does not trash when only a partner\'s remote copy is deleted', () async {
      const checksum = 'shared-partner-checksum';
      final localId = await addLocalAssetToBackupAlbum(checksum);

      // Current user's own remote copy is live but a partner deleted theirs
      await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      final partner = await ctx.newUser();
      await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum, deletedAt: DateTime(2020, 1, 1));

      final result = await sut.getToTrash();

      final ids = result.values.expand((assets) => assets).map((a) => a.id);
      expect(ids, isNot(contains(localId)));
    });

    test('trashes when the current user\'s own remote copy is deleted', () async {
      const checksum = 'my-deleted-copy';
      final localId = await addLocalAssetToBackupAlbum(checksum);
      await ctx.newRemoteAsset(ownerId: userId, checksum: checksum, deletedAt: DateTime(2020, 1, 1));

      final result = await sut.getToTrash();

      final ids = result.values.expand((assets) => assets).map((a) => a.id);
      expect(ids, contains(localId));
    });
  });

  group('Storage saver link', () {
    late String userId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
    });

    Future<({String? checksum, String? deviceChecksum})> localRow(String id) async {
      final data = await ctx.db.managers.localAssetEntity.filter((row) => row.id.equals(id)).getSingle();
      return (checksum: data.checksum, deviceChecksum: data.deviceChecksum);
    }

    Future<({String? checksum, String? deviceChecksum})> trashedRow(String id) async {
      final data = await ctx.db.managers.trashedLocalAssetEntity.filter((row) => row.id.equals(id)).getSingle();
      return (checksum: data.checksum, deviceChecksum: data.deviceChecksum);
    }

    test('a linked asset keeps both checksums through trash and restore, then unlinks', () async {
      final album = await ctx.newLocalAlbum(backupSelection: BackupSelection.selected);
      final local = await ctx.newLocalAsset(checksum: 'copy', deviceChecksum: 'original');
      await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
      final copy = await ctx.newRemoteAsset(ownerId: userId, checksum: 'copy');

      await sut.applyTrashedAssets([local.id]);
      expect(await trashedRow(local.id), (checksum: 'copy', deviceChecksum: 'original'));

      await sut.applyRestoredAssets([local.id]);
      expect(await localRow(local.id), (checksum: 'copy', deviceChecksum: 'original'));

      await (ctx.db.delete(ctx.db.remoteAssetEntity)..where((row) => row.id.equals(copy.id))).go();
      await LocalAssetRepository(ctx.db).unlinkStorageSaverCopies();

      expect(await localRow(local.id), (checksum: 'original', deviceChecksum: null));
    });

    test('trashLocalAsset keeps the device checksum', () async {
      final album = await ctx.newLocalAlbum(backupSelection: BackupSelection.selected);
      final local = await ctx.newLocalAsset(checksum: 'copy', deviceChecksum: 'original');
      await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
      final asset = (await LocalAssetRepository(ctx.db).getById(local.id))!;

      await sut.trashLocalAsset({
        album.id: [asset],
      });

      expect(await trashedRow(local.id), (checksum: 'copy', deviceChecksum: 'original'));
    });
  });
}
