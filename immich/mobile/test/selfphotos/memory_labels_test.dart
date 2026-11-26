import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/memory.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/memory/memory_title.widget.dart';
import 'package:immich_mobile/selfphotos/memories/memory_labels.dart';

Memory _memory(String id) => Memory(
  id: id,
  createdAt: DateTime(2026),
  updatedAt: DateTime(2026),
  ownerId: 'user-1',
  type: MemoryTypeEnum.onThisDay,
  data: const MemoryData(year: 2020),
  isSaved: false,
  memoryAt: DateTime(2026),
  assets: [],
);

void main() {
  test("Memento's title for the memories it made, Immich's for the rest; kept while the service is down", () async {
    var answer = Future.value({'made-by-memento': 'Spotlight: Mom'});
    var asked = 0;
    final container = ProviderContainer(
      overrides: [
        memoryLabelsSourceProvider.overrideWithValue(() {
          asked++;
          return answer;
        }),
      ],
    );
    addTearDown(container.dispose);
    final t = StaticTranslations.instance;
    final immichTitle = getMemoryTitle(t, _memory('made-by-memento'));
    var changes = 0;
    container.listen(memoryLabelsProvider, (_, _) => changes++);

    await container.read(memoryLabelsProvider.notifier).refresh();
    expect(getMemoryTitle(t, _memory('made-by-memento')), 'Spotlight: Mom');
    expect(getMemoryTitle(t, _memory('immich-own')), getMemoryTitle(t, _memory('immich-own')));
    expect(getMemoryTitle(t, _memory('immich-own')), isNot('Spotlight: Mom'));
    expect(changes, 1);

    await container.read(memoryLabelsProvider.notifier).refresh();
    expect(asked, 1);

    answer = Future.error(Exception('connection refused'));
    final restarted = ProviderContainer(overrides: [memoryLabelsSourceProvider.overrideWithValue(() => answer)]);
    addTearDown(restarted.dispose);
    await restarted.read(memoryLabelsProvider.notifier).refresh();
    expect(getMemoryTitle(t, _memory('made-by-memento')), 'Spotlight: Mom');

    final off = ProviderContainer(overrides: [memoryLabelsSourceProvider.overrideWithValue(() async => {})]);
    addTearDown(off.dispose);
    await off.read(memoryLabelsProvider.notifier).refresh();
    expect(getMemoryTitle(t, _memory('made-by-memento')), immichTitle);
  });
}
