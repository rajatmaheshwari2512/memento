// SelfPhotos: Memento admin, Memento's switches and limits: the same list as the web's
// Administration → Settings → Memento Features, described by Memento's service
// (GET /admin/settings), so a new switch shows up here without an app update. Built from the
// app's own settings pieces (SavedSwitchTile, around SettingsSwitchListTile; SettingListTile;
// SettingGroupTitle).
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/selfphotos/admin/admin.service.dart';
import 'package:immich_mobile/selfphotos/admin/admin_widgets.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';

class AdminFeaturesPage extends ConsumerWidget {
  const AdminFeaturesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(adminSettingsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Memento features')),
      body: settings.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => AdminNotice(error.toString()),
        data: (data) => ListView(
          padding: const EdgeInsets.symmetric(vertical: 8),
          children: [
            for (final section in {for (final s in data.settings) s.section}) ...[
              SettingGroupTitle(title: section),
              for (final setting in data.settings.where((s) => s.section == section))
                setting.isSwitch
                    ? SavedSwitchTile(
                        value: data.values[setting.key] == true,
                        title: setting.title,
                        subtitle: setting.subtitle,
                        save: (wanted) => _save(context, ref, setting.key, wanted),
                      )
                    : _Number(setting: setting, value: (data.values[setting.key] as num?)?.toInt() ?? setting.min),
              const SizedBox(height: 12),
            ],
          ],
        ),
      ),
    );
  }
}

/// Saves a change; on failure says why. The page loads again either way (AdminService).
Future<bool> _save(BuildContext context, WidgetRef ref, String key, Object value) async {
  try {
    await ref.read(adminServiceProvider).changeSetting(key, value);
    return true;
  } catch (error) {
    if (context.mounted) {
      ImmichToast.show(context: context, msg: error.toString(), toastType: ToastType.error);
    }
    return false;
  }
}

class _Number extends ConsumerWidget {
  final MementoSetting setting;
  final int value;

  const _Number({required this.setting, required this.value});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SettingListTile(
      title: setting.title,
      subtitle: setting.subtitle,
      trailing: Text('$value'),
      onTap: () async {
        final wanted = await showDialog<int>(
          context: context,
          builder: (_) => NumberDialog(title: setting.title, value: value, min: setting.min, max: setting.max),
        );
        if (wanted != null && wanted != value && context.mounted) {
          await _save(context, ref, setting.key, wanted);
        }
      },
    );
  }
}
