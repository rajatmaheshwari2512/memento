import type { MementoFlags } from '#lib/ai-edit/ai-edit-api.ts';
import { mementoFlags } from '#lib/ai-edit/flags.svelte.ts';
import { loadMemoryLabels } from '#lib/ai-edit/memory-labels.svelte.ts';
import { memoryLaneTitle } from '#lib/utils.ts';
import { MemoryType, type MemoryResponseDto } from '@immich/sdk';
import { get } from 'svelte/store';

const memory = (id: string) =>
  ({
    id,
    type: MemoryType.OnThisDay,
    memoryAt: '2020-01-01T00:00:00.000Z',
    data: { year: 2020 },
    assets: [],
  }) as unknown as MemoryResponseDto;

const json = (body: unknown) => Response.json(body);
const flags = (themedMemories: boolean) => ({ themedMemories: { enabled: themedMemories } }) as unknown as MementoFlags;

describe('themed memory titles', () => {
  it("shows Memento's title for the memories it made and Immich's for the rest; keeps it while the service is down; none when switched off", async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input) =>
        Promise.resolve(
          String(input).endsWith('/flags')
            ? json({ flags: flags(true), defaults: flags(true) })
            : json({ memories: [{ memoryId: 'made-by-memento', label: 'Spotlight: Mom' }] }),
        ),
      );
    const title = get(memoryLaneTitle);
    const immichTitle = title(memory('made-by-memento'));

    await loadMemoryLabels();
    expect(title(memory('made-by-memento'))).toBe('Spotlight: Mom');
    expect(title(memory('immich-own'))).toBe(immichTitle);

    // Not asked again within a minute.
    const calls = fetch.mock.calls.length;
    await loadMemoryLabels();
    expect(fetch.mock.calls.length).toBe(calls);

    // The service down: the last titles stay, nothing breaks.
    now += 61_000;
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await loadMemoryLabels();
    expect(title(memory('made-by-memento'))).toBe('Spotlight: Mom');

    // Switched off by an admin: Immich's own titles.
    now += 61_000;
    mementoFlags.value = flags(false);
    await loadMemoryLabels();
    expect(title(memory('made-by-memento'))).toBe(immichTitle);
  });
});
