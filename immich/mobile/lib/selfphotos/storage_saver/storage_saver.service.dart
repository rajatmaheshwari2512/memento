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

  /// The longest the shrunk video's short side can be, in pixels (null for [original]).
  int? get videoShortSide => switch (this) {
    original => null,
    saverHigh => 1440,
    saver => 1080,
  };
}

class StorageSaverService {
  final ExtrasClient _client;

  /// [_client]: Memento's extras service (a test can stand in for it).
  const StorageSaverService([this._client = const ExtrasClient()]);

  Future<BackupQuality> quality() async => BackupQuality.fromJson(await _client.send('GET', '/backup/settings'));

  Future<BackupQuality> change(BackupQuality quality) async =>
      BackupQuality.fromJson(await _client.send('PUT', '/backup/settings', body: {'quality': quality.name}));

  /// The quality to back up at ([BackupQuality.original] while the admin switch is off), and whether iPhone HDR
  /// videos are shrunk too.
  Future<({BackupQuality quality, bool shrinkHdr})> backupSettings() async {
    final flags = MementoFlags.fromJson(await _client.send('GET', '/flags'));
    if (!flags.storageSaver) {
      return (quality: BackupQuality.original, shrinkHdr: false);
    }
    return (quality: await quality(), shrinkHdr: flags.storageSaverIphoneHdr);
  }

  /// The quality to back up at: [BackupQuality.original] while the admin switch is off.
  Future<BackupQuality> backupQuality() async => (await backupSettings()).quality;
}
