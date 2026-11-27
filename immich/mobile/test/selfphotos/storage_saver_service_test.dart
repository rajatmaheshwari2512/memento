import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver.service.dart';

class _Extras extends ExtrasClient {
  final bool storageSaver;
  final bool iphoneHdr;
  final paths = <String>[];

  _Extras({required this.storageSaver, this.iphoneHdr = false});

  @override
  Future<Object?> send(String method, String path, {Object? body}) async {
    paths.add(path);
    return switch (path) {
      '/flags' => {
        'flags': {
          'storageSaver': {'enabled': storageSaver, 'iphoneHdr': iphoneHdr},
        },
      },
      '/backup/settings' => {'quality': 'saver'},
      _ => throw ArgumentError(path),
    };
  }
}

void main() {
  test('reads a backup quality, original when unknown or missing', () {
    expect(BackupQuality.fromJson({'quality': 'saverHigh'}), BackupQuality.saverHigh);
    expect(BackupQuality.fromJson({'quality': 'tiny'}), BackupQuality.original);
    expect(BackupQuality.fromJson({}), BackupQuality.original);
    expect(BackupQuality.fromJson(null), BackupQuality.original);
  });

  test('backs up at original quality while the admin switch is off', () async {
    final extras = _Extras(storageSaver: false);

    expect(await StorageSaverService(extras).backupQuality(), BackupQuality.original);
    expect(extras.paths, ['/flags']);
  });

  test('backs up at the person\'s quality while the admin switch is on', () async {
    final extras = _Extras(storageSaver: true);

    expect(await StorageSaverService(extras).backupQuality(), BackupQuality.saver);
    expect(extras.paths, ['/flags', '/backup/settings']);
  });

  test('shrinks iPhone HDR videos only with both admin switches on', () async {
    expect(
      (await StorageSaverService(_Extras(storageSaver: true, iphoneHdr: true)).backupSettings()).shrinkHdr,
      isTrue,
    );
    expect((await StorageSaverService(_Extras(storageSaver: true)).backupSettings()).shrinkHdr, isFalse);

    final off = await StorageSaverService(_Extras(storageSaver: false, iphoneHdr: true)).backupSettings();
    expect(off.quality, BackupQuality.original);
    expect(off.shrinkHdr, isFalse);
  });
}
