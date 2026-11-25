<script lang="ts">
  // SelfPhotos Ask Photos: what the question was read as, in the same chips Immich's search
  // results show for its filters, plus any hints (e.g. how to make "me" work).
  import type { AskUnderstood } from '#lib/ai-edit/ask-api.ts';
  import { getSearchTypeTitle } from '#lib/components/shared-components/search-bar/search-bar-utils.ts';
  import { Icon, Text } from '@immich/ui';
  import { mdiCreationOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = { understood: AskUnderstood | null };
  let { understood }: Props = $props();

  const chips = $derived.by(() => {
    if (!understood) {
      return [];
    }
    const list: Array<{ key: string; label: string; value?: string }> = [];
    if (understood.people.length > 0) {
      list.push({ key: 'people', label: $t('people'), value: understood.people.map((p) => p.name).join(', ') });
    }
    if (understood.dates) {
      list.push({ key: 'date', label: $t('date'), value: understood.dates.label });
    }
    if (understood.place) {
      list.push({ key: 'place', label: $t('location'), value: understood.place.name });
    }
    if (understood.type) {
      list.push({
        key: 'type',
        label: $t('media_type'),
        value: understood.type === 'VIDEO' ? $t('video') : $t('image'),
      });
    }
    if (understood.favorite) {
      list.push({ key: 'favorite', label: $t('favorite') });
    }
    if (understood.order) {
      list.push({ key: 'order', label: understood.order === 'newest' ? $t('newest_first') : $t('oldest_first') });
    }
    if (understood.text) {
      list.push({ key: 'context', label: $t('context'), value: understood.text });
    }
    return list;
  });
</script>

{#if understood}
  <section id="search-chips" class="mx-auto mt-24 w-full max-w-7xl px-4 sm:px-8 lg:px-12">
    <div class="flex w-full flex-wrap place-content-center place-items-center gap-2.5 sm:gap-3">
      <span class="flex items-center gap-1 text-xs text-primary dark:text-immich-dark-primary">
        <Icon icon={mdiCreationOutline} size="16" />
        {getSearchTypeTitle('ask')}
      </span>
      {#each chips as chip (chip.key)}
        <!-- A copy of the filter chip on Immich's search page (+page.svelte, same classes), without
             the remove button. Immich has no chip component to reuse. -->
        <div
          class="inline-flex max-w-full items-center rounded-full bg-primary/10 py-1 ps-1 pe-1 text-xs text-primary ring-1 ring-primary/15 transition-shadow hover:ring-primary/25 dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary dark:ring-immich-dark-primary/20 dark:hover:ring-immich-dark-primary/30"
        >
          <span
            class="shrink-0 rounded-full bg-primary px-3 py-1.5 font-medium text-light dark:bg-immich-dark-primary dark:text-immich-dark-gray"
          >
            {chip.label}
          </span>
          {#if chip.value}
            <span class="max-w-[min(36rem,55vw)] min-w-0 truncate px-3 py-1.5 text-immich-fg dark:text-immich-dark-fg">
              {chip.value}
            </span>
          {/if}
        </div>
      {/each}
    </div>
    {#each understood.hints as hint (hint)}
      <Text size="small" color="muted" class="mt-3 text-center">{hint}</Text>
    {/each}
  </section>
{/if}
