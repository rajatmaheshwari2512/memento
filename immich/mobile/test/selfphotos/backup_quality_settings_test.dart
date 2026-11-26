import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/storage_saver/backup_quality_settings.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver.service.dart';
import 'package:immich_ui/immich_ui.dart';

import '../widget_tester_extensions.dart';

void main() {
  MementoFlags flags({required bool storageSaver}) => MementoFlags.fromJson({
    'flags': {
      'storageSaver': {'enabled': storageSaver},
    },
  });

  Future<void> pump(WidgetTester tester, {required bool storageSaver}) => tester.pumpConsumerWidget(
    const MementoBackupQualitySettings(),
    overrides: [
      mementoFeaturesProvider.overrideWithValue(flags(storageSaver: storageSaver)),
      backupQualityProvider.overrideWith((ref) async => BackupQuality.saver),
    ],
  );

  test('reads the Storage saver switch, off when unknown', () {
    expect(MementoFlags.unknown.storageSaver, isFalse);
    expect(MementoFlags.fromJson({'flags': {}}).storageSaver, isFalse);
    expect(flags(storageSaver: true).storageSaver, isTrue);
  });

  testWidgets('shows the person\'s backup quality while Storage saver is on', (tester) async {
    await pump(tester, storageSaver: true);

    final radios = tester.widget<SettingsRadioListTile<BackupQuality>>(
      find.byType(SettingsRadioListTile<BackupQuality>),
    );
    expect(radios.groupBy, BackupQuality.saver);
    expect(radios.groups.map((group) => group.value), [
      BackupQuality.original,
      BackupQuality.saverHigh,
      BackupQuality.saver,
    ]);
  });

  testWidgets('shows nothing while Storage saver is off', (tester) async {
    await pump(tester, storageSaver: false);

    expect(find.byType(SettingGroupTitle), findsNothing);
    expect(find.byType(SettingsRadioListTile<BackupQuality>), findsNothing);
  });
}
