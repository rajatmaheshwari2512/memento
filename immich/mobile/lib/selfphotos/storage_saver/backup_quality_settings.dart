// SelfPhotos Storage saver: the Backup quality group in the app's backup settings.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/admin/admin_widgets.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/storage_saver/storage_saver.service.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';

final backupQualityProvider = FutureProvider.autoDispose<BackupQuality>((ref) => const StorageSaverService().quality());

/// Shown while the admin switch is on.
class MementoBackupQualitySettings extends HookConsumerWidget {
  const MementoBackupQualitySettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chosen = useState<BackupQuality?>(null);
    if (!ref.watch(mementoFeaturesProvider).storageSaver) {
      return const SizedBox.shrink();
    }
    final saved = ref.watch(backupQualityProvider);
    final quality = chosen.value ?? saved.valueOrNull;

    Future<void> change(BackupQuality? value) async {
      if (value == null || value == quality) {
        return;
      }
      chosen.value = value;
      try {
        await const StorageSaverService().change(value);
      } catch (error) {
        chosen.value = null;
        if (context.mounted) {
          ImmichToast.show(context: context, msg: error.toString(), toastType: ToastType.error);
        }
      } finally {
        if (context.mounted) {
          ref.invalidate(backupQualityProvider);
        }
      }
    }

    final descriptionStyle = context.textTheme.bodyMedium!.copyWith(
      color: context.textTheme.bodyMedium!.color!.withAlpha(215),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Divider(),
        SettingGroupTitle(
          title: context.t.backup_quality,
          subtitle: context.t.backup_quality_description,
          icon: Icons.cloud_upload_outlined,
        ),
        if (quality == null)
          saved.hasError
              ? AdminNotice(saved.error.toString())
              : const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                ),
        if (quality != null) ...[
          SettingsRadioListTile(
            groups: [
              SettingsRadioGroup(title: context.t.backup_quality_original, value: BackupQuality.original),
              SettingsRadioGroup(title: context.t.backup_quality_saver_high, value: BackupQuality.saverHigh),
              SettingsRadioGroup(title: context.t.backup_quality_saver, value: BackupQuality.saver),
            ],
            groupBy: quality,
            onRadioChanged: (value) => unawaited(change(value)),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
            child: Text(switch (quality) {
              BackupQuality.original => context.t.backup_quality_original_description,
              BackupQuality.saverHigh => context.t.backup_quality_saver_high_description,
              BackupQuality.saver => context.t.backup_quality_saver_description,
            }, style: descriptionStyle),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
            child: Text(context.t.backup_quality_note, style: descriptionStyle),
          ),
        ],
      ],
    );
  }
}
