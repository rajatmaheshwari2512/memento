// SelfPhotos: Memento admin, the list of people (Settings → Memento admin, admins only), and the
// way to add one.
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/infrastructure/utils/user.converter.dart';
import 'package:immich_mobile/selfphotos/admin/admin.service.dart';
import 'package:immich_mobile/selfphotos/admin/admin_add_user.page.dart';
import 'package:immich_mobile/selfphotos/admin/admin_features.page.dart';
import 'package:immich_mobile/selfphotos/admin/admin_user.page.dart';
import 'package:immich_mobile/selfphotos/admin/admin_widgets.dart';
import 'package:immich_mobile/widgets/common/user_circle_avatar.dart';
import 'package:immich_ui/immich_ui.dart';

/// "12 GB of 100 GB used", or "12 GB · Unlimited".
String storageText(BuildContext context, AdminUser person) => person.quotaText == null
    ? '${person.usedText} · ${context.t.unlimited}'
    : context.t.storage_usage(used: person.usedText, available: person.quotaText!);

class AdminPage extends ConsumerWidget {
  const AdminPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final overview = ref.watch(adminOverviewProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Memento admin'),
        actions: [
          IconButton(
            icon: const Icon(Icons.person_add_alt_1_outlined),
            tooltip: 'Add a person',
            onPressed: () =>
                Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AdminAddUserPage())),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(adminOverviewProvider.future),
        child: overview.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(children: [AdminNotice(error.toString())]),
          data: (data) {
            final month = data.month;
            return ListView(
              padding: const EdgeInsets.symmetric(vertical: 8),
              children: [
                const SettingGroupTitle(title: 'People', icon: Icons.people_alt_outlined),
                for (final person in data.users) _PersonTile(person: person),
                const SizedBox(height: 16),
                const SettingGroupTitle(title: 'Memento', icon: Icons.tune_outlined),
                SettingListTile(
                  leading: const Icon(Icons.toggle_on_outlined),
                  title: 'Memento features',
                  subtitle: 'AI edits, live albums, Ask Photos, captions',
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AdminFeaturesPage())),
                ),
                SettingListTile(
                  leading: const Icon(Icons.auto_fix_high_outlined),
                  title: 'AI edits this month',
                  subtitle: month == null
                      ? "Unavailable: Memento's service didn't answer"
                      : '${month.used} of ${month.limit} for everyone · ≈ ${usd(month.costUsd)} · '
                            'each person ${month.defaultDailyLimit} a day, unless set for them',
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _PersonTile extends StatelessWidget {
  final AdminUser person;

  const _PersonTile({required this.person});

  @override
  Widget build(BuildContext context) {
    final user = person.user;
    final share = person.quotaShare;
    final aiEdits = person.aiEdits;
    final details = person.removed
        ? context.t.user_has_been_deleted
        : [
            storageText(context, person),
            aiEdits == null ? 'AI edits unavailable' : '${aiEdits.thisMonth} AI edits this month',
          ].join(' · ');
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 20),
      leading: UserCircleAvatar(user: UserConverter.fromAdminDto(user), opacity: person.removed ? 0.5 : 1),
      title: Text(user.name, overflow: TextOverflow.ellipsis),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (user.isAdmin)
            Text(
              context.t.admin.admin_user,
              style: context.textTheme.labelSmall?.copyWith(color: context.primaryColor),
            ),
          Text(details),
          if (share != null && !person.removed) ...[
            const SizedBox(height: 4),
            LinearProgressIndicator(value: share, borderRadius: BorderRadius.circular(2)),
          ],
        ],
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AdminUserPage(userId: user.id))),
    );
  }
}
