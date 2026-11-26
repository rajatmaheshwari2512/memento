// SelfPhotos themed memories.
import 'package:immich_mobile/selfphotos/extras_client.dart';

/// The person's own choices.
class MemorySettings {
  final bool enabled;
  final bool creations;
  final String? pausedReason;

  const MemorySettings({required this.enabled, required this.creations, this.pausedReason});

  factory MemorySettings.fromJson(Object? json) {
    final map = json is Map ? json : const {};
    return MemorySettings(
      enabled: map['enabled'] == true,
      creations: map['creations'] != false,
      pausedReason: map['pausedReason'] is String ? map['pausedReason'] as String : null,
    );
  }
}

class MemoriesService {
  const MemoriesService();

  static const _client = ExtrasClient();

  /// Memento's title for each memory it made, by Immich's memory id.
  Future<Map<String, String>> labels() async {
    final data = await _client.send('GET', '/memories/labels');
    final list = data is Map && data['memories'] is List ? data['memories'] as List : const [];
    return {
      for (final entry in list)
        if (entry is Map && entry['memoryId'] is String && entry['label'] is String)
          entry['memoryId'] as String: entry['label'] as String,
    };
  }

  Future<MemorySettings> settings() async => MemorySettings.fromJson(await _client.send('GET', '/memories/settings'));

  /// Turning [enabled] on makes a key in the person's name in Immich.
  Future<MemorySettings> change({bool? enabled, bool? creations}) async => MemorySettings.fromJson(
    await _client.send('PUT', '/memories/settings', body: {'enabled': ?enabled, 'creations': ?creations}),
  );
}
