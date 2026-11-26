// SelfPhotos themed memories.
import 'dart:async';

import 'package:collection/collection.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/memories/memories.service.dart';

const _refreshEvery = Duration(minutes: 1);
const _timeout = Duration(seconds: 10);

Map<String, String> _known = const {};

/// Memento's title for this memory, if it made it.
String? mementoMemoryLabel(String memoryId) => _known[memoryId];

/// Where the titles come from.
final memoryLabelsSourceProvider = Provider<Future<Map<String, String>> Function()>((_) => _fromService);

Future<Map<String, String>> _fromService() async {
  final flags = await MementoFlags.fetch();
  return flags.themedMemories ? const MemoriesService().labels() : const <String, String>{};
}

class MemoryLabelsNotifier extends Notifier<Map<String, String>> {
  DateTime? _askedAt;

  @override
  Map<String, String> build() => _known;

  Future<void> refresh() async {
    final now = DateTime.now();
    if (_askedAt != null && now.difference(_askedAt!) < _refreshEvery) {
      return;
    }
    _askedAt = now;
    try {
      final labels = await ref.read(memoryLabelsSourceProvider)().timeout(_timeout);
      if (!const MapEquality<String, String>().equals(labels, state)) {
        _known = labels;
        state = labels;
      }
    } catch (_) {
    }
  }
}

final memoryLabelsProvider = NotifierProvider<MemoryLabelsNotifier, Map<String, String>>(MemoryLabelsNotifier.new);

/// For the providers that load memories: asks for the titles in the background.
void askForMemoryLabels(Ref ref) => unawaited(ref.read(memoryLabelsProvider.notifier).refresh());

/// As askForMemoryLabels, and runs the provider again when the titles change.
void watchMemoryLabels(Ref ref) {
  ref.watch(memoryLabelsProvider);
  askForMemoryLabels(ref);
}
