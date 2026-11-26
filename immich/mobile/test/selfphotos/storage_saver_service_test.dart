import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver.service.dart';

class _Extras extends ExtrasClient {
  final bool storageSaver;
  final paths = <String>[];

  _Extras({required this.storageSaver});

  @override
  Future<Object?> send(String method, String path, {Object? body}) async {
    paths.add(path);
    return switch (path) {
      '/flags' => {
        'flags': {
          'storageSaver': {'enabled': storageSaver},
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
}
