// SelfPhotos Storage saver: each person's backup quality.
import 'package:immich_mobile/selfphotos/extras_client.dart';

/// The size this app's backups upload at.
enum BackupQuality {
  original,
  saverHigh,
  saver;

  factory BackupQuality.fromJson(Object? json) {
    final quality = json is Map ? json['quality'] : null;
    return values.firstWhere((value) => value.name == quality, orElse: () => original);
  }

  /// The shrunk video's bitrate in bits per second (null for [original]).
  int? get videoBitrate => switch (this) {
    original => null,
    saverHigh => 8000000,
    saver => 4000000,
  };
}

class StorageSaverService {
  const StorageSaverService();

  static const _client = ExtrasClient();

  Future<BackupQuality> quality() async => BackupQuality.fromJson(await _client.send('GET', '/backup/settings'));

  Future<BackupQuality> change(BackupQuality quality) async =>
      BackupQuality.fromJson(await _client.send('PUT', '/backup/settings', body: {'quality': quality.name}));

  /// The quality to back up at: [BackupQuality.original] while the admin switch is off.
  Future<BackupQuality> backupQuality() async {
    final flags = await MementoFlags.fetch();
    return flags.storageSaver ? quality() : BackupQuality.original;
  }
}
