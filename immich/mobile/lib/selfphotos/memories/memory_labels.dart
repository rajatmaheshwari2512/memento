// SelfPhotos themed memories: the titles Memento gave the memories it made, shown where Immich
// writes "N years ago" (presentation/widgets/memory/memory_title.widget.dart, getMemoryTitle).
// Not part of Immich.
//
// Never in the way: the providers that load memories (providers/infrastructure/
// memory.provider.dart) return them at once with the titles known so far, and ask for the
// titles in the background (at most once a minute); the strip's runs again only if the titles
// changed. If the service is down, the switch is off or a memory has no title, Immich's own
// title shows.
import 'dart:async';

import 'package:collection/collection.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/memories/memories.service.dart';

const _refreshEvery = Duration(minutes: 1);
const _timeout = Duration(seconds: 10);

// Read by getMemoryTitle, which has no provider ref; kept equal to memoryLabelsProvider's state.
Map<String, String> _known = const {};

/// Memento's title for this memory, if it made it.
String? mementoMemoryLabel(String memoryId) => _known[memoryId];

/// Where the titles come from: Memento's service, when an admin has themed memories switched
/// on (a fake in tests).
final memoryLabelsSourceProvider = Provider<Future<Map<String, String>> Function()>((_) => _fromService);

Future<Map<String, String>> _fromService() async {
  final flags = await MementoFlags.fetch(); // throws when the service is down: the last titles stay
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
      // Immich's own titles show; the last ones known stay until the next answer.
    }
  }
}

final memoryLabelsProvider = NotifierProvider<MemoryLabelsNotifier, Map<String, String>>(MemoryLabelsNotifier.new);

/// For the providers that load memories: asks for the titles in the background.
void askForMemoryLabels(Ref ref) => unawaited(ref.read(memoryLabelsProvider.notifier).refresh());

/// As askForMemoryLabels, and runs the provider again when the titles change. Only for the
/// strip, which keeps showing its memories meanwhile; the memories page would show a spinner.
void watchMemoryLabels(Ref ref) {
  ref.watch(memoryLabelsProvider);
  askForMemoryLabels(ref);
}
