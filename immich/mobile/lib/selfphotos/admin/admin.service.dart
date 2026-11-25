// SelfPhotos: Memento admin on the phone (Settings → Memento admin, admins only). People,
// storage and logins come from Immich's own admin API, the same one its web admin pages
// use; AI-edit usage, per-person limits and Memento's switches come from Memento's extras
// service (/admin/*). Not part of Immich. See SelfPhotos DECISIONS.md, "Memento admin on
// the Android app".
import 'dart:math';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:immich_mobile/utils/bytes_units.dart';
import 'package:openapi/api.dart';

/// One person's AI edits (GET /admin/usage).
class PersonAiEdits {
  final int today;
  final int thisMonth;
  final double costUsd;
  final int dailyLimit; // in force: their own, or everyone's default
  final int? ownDailyLimit; // set just for them; null follows the default

  const PersonAiEdits({
    required this.today,
    required this.thisMonth,
    required this.costUsd,
    required this.dailyLimit,
    required this.ownDailyLimit,
  });

  factory PersonAiEdits.fromJson(Map json) => PersonAiEdits(
    today: (json['today'] as num?)?.toInt() ?? 0,
    thisMonth: (json['thisMonth'] as num?)?.toInt() ?? 0,
    costUsd: (json['costUsd'] as num?)?.toDouble() ?? 0,
    dailyLimit: (json['dailyLimit'] as num?)?.toInt() ?? 0,
    ownDailyLimit: (json['ownDailyLimit'] as num?)?.toInt(),
  );
}

/// Everyone's AI edits this month, against the server's monthly limit.
class AiEditMonth {
  final int used;
  final int limit;
  final double costUsd;
  final int defaultDailyLimit;

  const AiEditMonth({required this.used, required this.limit, required this.costUsd, required this.defaultDailyLimit});
}

String usd(double amount) => '\$${amount.toStringAsFixed(2)}';

/// Storage limits are in GiB, as on Immich's web admin ("Quota Size (GiB)").
const gib = 1024 * 1024 * 1024;

/// A random password for a new person or a reset: 16 letters and digits that are easy to
/// read out (no 0/O, 1/l/I), about 92 bits. Never logged or stored.
String newPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  final random = Random.secure();
  return List.generate(16, (_) => letters[random.nextInt(letters.length)]).join();
}

/// A person on the server, with what the admin pages show about them.
class AdminUser {
  final UserAdminResponseDto user;
  final PersonAiEdits? aiEdits; // null when Memento's service couldn't be reached

  const AdminUser({required this.user, required this.aiEdits});

  bool get removed => user.deletedAt != null;

  /// Bytes used, as Immich counts them against the quota (its web admin shows the same).
  int get used => user.quotaUsageInBytes ?? 0;

  /// Share of the quota used, or null with no quota.
  double? get quotaShare {
    final quota = user.quotaSizeInBytes;
    return quota == null || quota == 0 ? null : (used / quota).clamp(0, 1).toDouble();
  }

  String get usedText => formatBytes(used);
  String? get quotaText => user.quotaSizeInBytes == null ? null : formatBytes(user.quotaSizeInBytes!);
}

class AdminOverview {
  final List<AdminUser> users;
  final AiEditMonth? month; // null when Memento's service couldn't be reached

  const AdminOverview({required this.users, required this.month});
}

/// One setting an admin can change, as Memento's service describes it (GET /admin/settings),
/// so this screen shows the same list as the web's without an app update.
class MementoSetting {
  final String key; // "gemini.enabled"
  final String section; // "Gemini AI Edits"
  final String title;
  final String subtitle;
  final bool isSwitch; // else a whole number from min to max
  final int min;
  final int max;

  const MementoSetting({
    required this.key,
    required this.section,
    required this.title,
    required this.subtitle,
    required this.isSwitch,
    required this.min,
    required this.max,
  });

  factory MementoSetting.fromJson(Map json) => MementoSetting(
    key: json['key'] as String,
    section: json['section'] as String,
    title: json['title'] as String,
    subtitle: (json['subtitle'] as String?) ?? '',
    isSwitch: json['kind'] == 'boolean',
    min: (json['min'] as num?)?.toInt() ?? 0,
    max: (json['max'] as num?)?.toInt() ?? 0,
  );
}

/// The settings and their values ("gemini.enabled" → true).
class MementoSettings {
  final List<MementoSetting> settings;
  final Map<String, Object?> values;

  const MementoSettings({required this.settings, required this.values});

  factory MementoSettings.fromJson(Object? json) {
    final body = json is Map ? json : const {};
    final flags = body['flags'] is Map ? body['flags'] as Map : const {};
    return MementoSettings(
      settings: [
        for (final s in (body['settings'] as List? ?? const []))
          if (s is Map) MementoSetting.fromJson(s),
      ],
      values: {
        for (final group in flags.entries)
          if (group.value is Map)
            for (final entry in (group.value as Map).entries) '${group.key}.${entry.key}': entry.value,
      },
    );
  }
}

class AdminService {
  static const _client = ExtrasClient();
  final Ref _ref;

  AdminService(this._ref);

  ApiService get _api => _ref.read(apiServiceProvider);
  UsersAdminApi get _users => UsersAdminApi(_api.apiClient);

  /// People from Immich; their AI edits from Memento's service, if it answers. Immich's part
  /// works on its own, so the list still shows when the service is down.
  Future<AdminOverview> overview() async {
    final users = await _users.searchUsersAdmin(withDeleted: true) ?? const <UserAdminResponseDto>[];
    Map? usage;
    try {
      final body = await _client.send('GET', '/admin/usage');
      usage = body is Map ? body : null;
    } catch (_) {
      usage = null;
    }
    final byUser = {
      for (final u in (usage?['users'] as List? ?? const []))
        if (u is Map && u['userId'] is String) u['userId'] as String: PersonAiEdits.fromJson(u),
    };
    final month = usage?['month'] is Map ? usage!['month'] as Map : null;
    final defaultDailyLimit = (usage?['defaultDailyLimit'] as num?)?.toInt() ?? 0;
    return AdminOverview(
      users: [
        for (final u in users)
          AdminUser(
            user: u,
            aiEdits: usage == null
                ? null
                : byUser[u.id] ??
                      PersonAiEdits(
                        today: 0,
                        thisMonth: 0,
                        costUsd: 0,
                        dailyLimit: defaultDailyLimit,
                        ownDailyLimit: null,
                      ),
          ),
      ]..sort((a, b) => (a.removed ? 1 : 0) - (b.removed ? 1 : 0)),
      month: month == null
          ? null
          : AiEditMonth(
              used: (month['used'] as num?)?.toInt() ?? 0,
              limit: (month['limit'] as num?)?.toInt() ?? 0,
              costUsd: (month['costUsd'] as num?)?.toDouble() ?? 0,
              defaultDailyLimit: defaultDailyLimit,
            ),
    );
  }

  Future<AssetStatsResponseDto?> statistics(String userId) => _users.getUserStatisticsAdmin(userId);

  Future<List<SessionResponseDto>> sessions(String userId) async =>
      await _users.getUserSessionsAdmin(userId) ?? const [];

  Future<MementoSettings> settings() async => MementoSettings.fromJson(await _client.send('GET', '/admin/settings'));

  /// Changes one setting, e.g. ("gemini.enabled", false). The pages showing it load again
  /// (also after the admin has left the screen), and so do the app's switched-off features.
  Future<void> changeSetting(String key, Object value) async {
    final [group, name] = key.split('.');
    await _client.send(
      'PUT',
      '/flags',
      body: {
        group: {name: value},
      },
    );
    _ref
      ..invalidate(adminSettingsProvider)
      ..invalidate(adminOverviewProvider)
      ..invalidate(mementoFlagsProvider);
  }

  /// Adds a person, never as an admin: Immich only makes non-admins choose their own
  /// password at first login, so admin rights are given afterwards, with a confirmation.
  /// Immich sends no email here; the admin passes the password on.
  Future<void> createUser({
    required String name,
    required String email,
    required String password,
    required int? quotaBytes,
  }) async {
    await _users.createUserAdmin(
      UserAdminCreateDto(
        name: name,
        email: email,
        password: password,
        quotaSizeInBytes: Optional.present(quotaBytes),
        isAdmin: const Optional.present(false),
        shouldChangePassword: const Optional.present(true),
        notify: const Optional.present(false),
      ),
    );
    _ref.invalidate(adminOverviewProvider);
  }

  Future<void> _update(String userId, UserAdminUpdateDto change) async {
    await _users.updateUserAdmin(userId, change);
    _ref.invalidate(adminOverviewProvider);
  }

  /// Storage limit in bytes, or null for none.
  Future<void> setQuota(String userId, int? bytes) =>
      _update(userId, UserAdminUpdateDto(quotaSizeInBytes: Optional.present(bytes)));

  Future<void> setAdmin(String userId, bool isAdmin) =>
      _update(userId, UserAdminUpdateDto(isAdmin: Optional.present(isAdmin)));

  /// A new password they must change at their next login. Phones already logged in stay
  /// logged in: Immich doesn't end their sessions.
  Future<void> resetPassword(String userId, String password) => _update(
    userId,
    UserAdminUpdateDto(password: Optional.present(password), shouldChangePassword: const Optional.present(true)),
  );

  /// Signs them out everywhere at once; Immich deletes the account and its photos after
  /// [deleteDelayDays], until then [restore] undoes it.
  Future<void> remove(String userId) async {
    await _users.deleteUserAdmin(userId, UserAdminDeleteDto(force: const Optional.present(false)));
    _ref.invalidate(adminOverviewProvider);
  }

  Future<void> restore(String userId) async {
    await _users.restoreUserAdmin(userId);
    _ref.invalidate(adminOverviewProvider);
  }

  /// Days a removed person can be restored (Immich's setting).
  Future<int> deleteDelayDays() async => (await _api.serverInfoApi.getServerConfig())?.userDeleteDelay ?? 7;

  /// One person's AI-edit daily limit, or null for everyone's default.
  Future<void> setDailyLimit(String userId, int? dailyEdits) async {
    await _client.send('PUT', '/admin/users/$userId/limits', body: {'dailyEdits': dailyEdits});
    _ref.invalidate(adminOverviewProvider);
  }
}

final adminServiceProvider = Provider((ref) => AdminService(ref));

final adminOverviewProvider = FutureProvider.autoDispose((ref) => ref.watch(adminServiceProvider).overview());

final adminSettingsProvider = FutureProvider.autoDispose((ref) => ref.watch(adminServiceProvider).settings());

final adminStatisticsProvider = FutureProvider.autoDispose.family<AssetStatsResponseDto?, String>(
  (ref, userId) => ref.watch(adminServiceProvider).statistics(userId),
);

final adminDeleteDelayProvider = FutureProvider.autoDispose((ref) => ref.watch(adminServiceProvider).deleteDelayDays());

final adminSessionsProvider = FutureProvider.autoDispose.family<List<SessionResponseDto>, String>(
  (ref, userId) => ref.watch(adminServiceProvider).sessions(userId),
);
