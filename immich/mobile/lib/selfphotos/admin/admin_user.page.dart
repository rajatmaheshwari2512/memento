// SelfPhotos: Memento admin, one person: storage and its limit, photos, AI edits and their
// own daily limit, logged-in devices, and what an admin can do (admin rights, a new
// password, remove or restore). One action at a time. Data: admin.service.dart.
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/datetime_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/selfphotos/admin/admin.page.dart';
import 'package:immich_mobile/selfphotos/admin/admin.service.dart';
import 'package:immich_mobile/selfphotos/admin/admin_widgets.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:openapi/api.dart';

class AdminUserPage extends ConsumerStatefulWidget {
  final String userId;

  const AdminUserPage({super.key, required this.userId});

  @override
  ConsumerState<AdminUserPage> createState() => _AdminUserPageState();
}

class _AdminUserPageState extends ConsumerState<AdminUserPage> {
  bool _busy = false; // an action is running: the others wait, so nothing runs twice

  String get _userId => widget.userId;
  AdminService get _service => ref.read(adminServiceProvider);

  /// Runs one admin action at a time; says what went wrong if it fails.
  Future<void> _act(Future<void> Function() action) async {
    if (_busy) {
      return;
    }
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      if (mounted) {
        ImmichToast.show(context: context, msg: adminError(context, error), toastType: ToastType.error);
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  Future<bool> _confirm(String title, String content, String ok) async =>
      await showDialog<bool>(
        context: context,
        builder: (_) => ConfirmDialog(title: title, content: content, ok: ok),
      ) ==
      true;

  Future<void> _editDailyLimit(PersonAiEdits ai) => _act(() async {
    final value = await showDialog<int>(
      context: context,
      builder: (_) => NumberDialog(
        title: 'AI edits a day for this person',
        value: ai.ownDailyLimit ?? ai.dailyLimit,
        min: 0,
        max: 1000,
        resetText: "Everyone's default",
      ),
    );
    if (value != null) {
      await _service.setDailyLimit(_userId, value < 0 ? null : value);
    }
  });

  Future<void> _editQuota(AdminUser person) => _act(() async {
    final quota = person.user.quotaSizeInBytes;
    final value = await showDialog<int>(
      context: context,
      builder: (_) => NumberDialog(
        title: context.t.admin.quota_size_gib,
        value: quota == null ? 100 : (quota / gib).round(),
        min: 1,
        max: 100000,
        resetText: context.t.unlimited,
      ),
    );
    if (value != null) {
      await _service.setQuota(_userId, value < 0 ? null : value * gib);
    }
  });

  Future<void> _setAdmin(AdminUser person, bool isAdmin) => _act(() async {
    final name = person.user.name;
    final ok = await _confirm(
      isAdmin ? 'Make $name an admin?' : 'Remove $name as admin?',
      isAdmin
          ? "Admins can see everyone's storage, add and remove people, and change Memento's settings. "
                'They still only see their own photos.'
          : "They keep their account and photos; they just can't use the admin pages any more.",
      isAdmin ? 'Make admin' : 'Remove admin',
    );
    if (ok) {
      await _service.setAdmin(_userId, isAdmin);
    }
  });

  Future<void> _resetPassword(AdminUser person) => _act(() async {
    final name = person.user.name;
    final ok = await _confirm(
      '${context.t.reset_password}: $name?',
      "They'll need the new password the next time they log in. Phones and browsers already logged in "
          "stay logged in: a new password doesn't sign anyone out. To sign them out everywhere, remove them instead.",
      context.t.reset_password,
    );
    if (!ok || !mounted) {
      return;
    }
    final password = newPassword();
    await _service.resetPassword(_userId, password);
    if (mounted) {
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => PasswordOnceDialog(name: name, password: password, isAdmin: person.user.isAdmin),
      );
    }
  });

  Future<void> _remove(AdminUser person) => _act(() async {
    final name = person.user.name;
    final days = await ref.read(adminDeleteDelayProvider.future);
    if (!mounted) {
      return;
    }
    final ok = await _confirm(
      'Remove $name?',
      "They're signed out everywhere straight away, and their logins and keys stop working. Albums they "
          'own disappear for everyone they shared them with. Their account and all their photos are deleted '
          'for good after $days days; until then you can restore them here.',
      context.t.remove_user,
    );
    if (ok) {
      await _service.remove(_userId);
    }
  });

  Future<void> _restore(AdminUser person) => _act(() async {
    final ok = await _confirm(
      '${context.t.restore_user}: ${person.user.name}?',
      'Their account, photos and albums come back, and they can log in again.',
      context.t.restore,
    );
    if (ok) {
      await _service.restore(_userId);
    }
  });

  @override
  Widget build(BuildContext context) {
    final overview = ref.watch(adminOverviewProvider);
    final person = overview.valueOrNull?.users.where((p) => p.user.id == _userId).firstOrNull;
    if (person == null) {
      return Scaffold(
        appBar: AppBar(),
        body: overview.isLoading
            ? const Center(child: CircularProgressIndicator())
            : AdminNotice(overview.hasError ? overview.error.toString() : 'This person is no longer on the server.'),
      );
    }
    final user = person.user;
    final share = person.quotaShare;
    final ai = person.aiEdits;
    final stats = ref.watch(adminStatisticsProvider(_userId)).valueOrNull;
    final days = ref.watch(adminDeleteDelayProvider).valueOrNull;
    // Immich refuses these for your own account anyway.
    final isMe = ref.watch(currentUserProvider)?.id == _userId;
    // Only a removed person whose deletion hasn't started can come back.
    final restorable = person.removed && user.status == UserStatus.deleted;
    return Scaffold(
      appBar: AppBar(
        title: Text(user.name),
        bottom: _busy
            ? const PreferredSize(preferredSize: Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2))
            : null,
      ),
      body: AbsorbPointer(
        absorbing: _busy,
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: 8),
          children: [
            SettingListTile(
              leading: const Icon(Icons.person_outline),
              title: user.email,
              subtitle: [
                if (user.isAdmin) context.t.admin.admin_user,
                if (person.removed) context.t.user_has_been_deleted,
              ].join(' · '),
            ),
            if (restorable)
              SettingListTile(
                leading: const Icon(Icons.restore),
                title: context.t.restore_user,
                subtitle: 'Their account, photos and albums come back, and they can log in again.',
                onTap: () => _restore(person),
              ),
            if (!person.removed) ...[
              SettingGroupTitle(title: context.t.storage, icon: Icons.storage_outlined),
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                title: Text(storageText(context, person)),
                trailing: const Icon(Icons.edit_outlined),
                onTap: () => _editQuota(person),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (share != null) ...[
                      const SizedBox(height: 6),
                      LinearProgressIndicator(value: share, borderRadius: BorderRadius.circular(2)),
                      const SizedBox(height: 6),
                    ],
                    if (stats != null)
                      Text('${context.t.photos} ${stats.images} · ${context.t.videos} ${stats.videos}'),
                  ],
                ),
              ),
              const SettingGroupTitle(title: 'AI edits', icon: Icons.auto_fix_high_outlined),
              if (ai == null)
                const AdminNotice("Unavailable: Memento's service didn't answer.")
              else
                SettingListTile(
                  title: 'Today ${ai.today} of ${ai.dailyLimit}',
                  subtitle:
                      '${ai.thisMonth} this month · ≈ ${usd(ai.costUsd)}\n'
                      '${ai.ownDailyLimit == null ? "Daily limit: everyone's default" : 'Daily limit set for this person'}',
                  trailing: const Icon(Icons.edit_outlined),
                  onTap: () => _editDailyLimit(ai),
                ),
              SettingGroupTitle(title: context.t.authorized_devices, icon: Icons.devices_outlined),
              _Sessions(userId: _userId),
              if (!isMe) ...[
                const SettingGroupTitle(title: 'Access', icon: Icons.admin_panel_settings_outlined),
                SwitchListTile.adaptive(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                  title: Text(context.t.admin.admin_user),
                  value: user.isAdmin,
                  onChanged: (value) => _setAdmin(person, value),
                ),
                SettingListTile(
                  leading: const Icon(Icons.password_outlined),
                  title: context.t.reset_password,
                  subtitle: "For a forgotten password. Doesn't sign them out.",
                  onTap: () => _resetPassword(person),
                ),
                SettingListTile(
                  leading: Icon(Icons.person_remove_outlined, color: context.colorScheme.error),
                  title: context.t.remove_user,
                  subtitle: days == null
                      ? 'Signs them out everywhere now; restorable for a few days.'
                      : 'Signs them out everywhere now; restorable for $days days.',
                  onTap: () => _remove(person),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _Sessions extends ConsumerWidget {
  final String userId;

  const _Sessions({required this.userId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref
        .watch(adminSessionsProvider(userId))
        .when(
          loading: () => const Padding(padding: EdgeInsets.all(20), child: LinearProgressIndicator()),
          error: (error, _) => AdminNotice(error.toString()),
          data: (sessions) => sessions.isEmpty
              ? AdminNotice(context.t.no_devices)
              : Column(
                  children: [
                    for (final session in sessions)
                      SettingListTile(
                        leading: Icon(
                          session.deviceType == 'Android' ? Icons.phone_android_outlined : Icons.computer_outlined,
                        ),
                        title: [session.deviceType, session.deviceOS].where((s) => s.isNotEmpty).join(' · '),
                        subtitle: DateTime.tryParse(session.updatedAt)?.toLocal().formatDate(),
                      ),
                  ],
                ),
        );
  }
}
