// SelfPhotos themed memories: the person's own switches (themed memories; collages and recap
// videos), on a page of its own opened from Settings (one line per layout in Immich's
// settings.page.dart). Built like the app's own settings pages (SavedSwitchTile, each change
// saved at once). Not part of Immich.
//
// Shown while an admin has themed memories switched on, or while this person's are on: with
// them switched off for everyone, the person can still turn theirs off (and their key goes),
// but not on. The collages switch shows while collages are switched on.
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/admin/admin_widgets.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/memories/memories.service.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';

const _icon = Icons.auto_stories_outlined;

final _settingsProvider = FutureProvider.autoDispose<MemorySettings>((ref) => const MemoriesService().settings());

void _open(BuildContext context) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const MemoriesSettingsPage()));

/// Whether to offer the page: themed memories switched on, or this person's on (to turn off).
/// When the service can't be reached, no.
bool _offered(WidgetRef ref) =>
    ref.watch(mementoFeaturesProvider).themedMemories || (ref.watch(_settingsProvider).valueOrNull?.enabled ?? false);

/// The Settings page's card (phones).
class MementoMemoriesCard extends ConsumerWidget {
  const MementoMemoriesCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!_offered(ref)) {
      return const SizedBox.shrink();
    }
    return SettingsCard(
      icon: _icon,
      title: context.t.themed_memories,
      subtitle: context.t.themed_memories_description,
      onTap: () => _open(context),
    );
  }
}

/// The Settings page's list entry (tablets).
class MementoMemoriesTile extends ConsumerWidget {
  const MementoMemoriesTile({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!_offered(ref)) {
      return const SizedBox.shrink();
    }
    return ListTile(title: Text(context.t.themed_memories), leading: const Icon(_icon), onTap: () => _open(context));
  }
}

class MemoriesSettingsPage extends ConsumerWidget {
  const MemoriesSettingsPage({super.key});

  /// Saves a change; on failure says why. The settings load again either way.
  Future<bool> _change(BuildContext context, WidgetRef ref, {bool? enabled, bool? creations}) async {
    try {
      await const MemoriesService().change(enabled: enabled, creations: creations);
      return true;
    } catch (error) {
      if (context.mounted) {
        ImmichToast.show(context: context, msg: error.toString(), toastType: ToastType.error);
      }
      return false;
    } finally {
      if (context.mounted) {
        ref.invalidate(_settingsProvider);
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(_settingsProvider);
    final features = ref.watch(mementoFeaturesProvider);
    final adminOn = features.themedMemories;
    return Scaffold(
      appBar: AppBar(title: Text(context.t.themed_memories)),
      body: settings.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => AdminNotice(error.toString()),
        data: (data) => ListView(
          padding: const EdgeInsets.symmetric(vertical: 8),
          children: [
            SavedSwitchTile(
              value: data.enabled,
              title: context.t.themed_memories,
              subtitle: context.t.themed_memories_enable_description,
              // Switched off for everyone: theirs can only be turned off.
              enabled: adminOn || data.enabled,
              save: (on) => _change(context, ref, enabled: on),
            ),
            if (!adminOn)
              AdminNotice(context.t.themed_memories_paused_by_admin)
            else if (data.pausedReason != null)
              AdminNotice(data.pausedReason!),
            if (adminOn && features.creations)
              SavedSwitchTile(
                value: data.creations,
                title: context.t.themed_memories_creations,
                subtitle: context.t.themed_memories_creations_description,
                save: (on) => _change(context, ref, creations: on),
              ),
          ],
        ),
      ),
    );
  }
}
