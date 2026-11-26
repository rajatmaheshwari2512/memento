<!-- SelfPhotos editor: the editor's tabs, shown at the top of both Immich's editor (Crop) and -->
<!-- Adjust's pages (Adjustments, Filters, Straighten, Markup). -->
<script lang="ts" module>
  import type { AdjustTab } from '#lib/ai-edit/adjust/adjust-action.ts';

  export type EditorTab = AdjustTab | 'crop';
</script>

<script lang="ts">
  import { Button } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    active: EditorTab;
    // Immich's editor, when it opens for this photo (not for motion photos).
    showCrop: boolean;
    showAdjust: boolean;
    disabled?: boolean;
    onSelect: (tab: EditorTab) => void;
  }

  let { active, showCrop, showAdjust, disabled = false, onSelect }: Props = $props();

  const tabs = $derived([
    ...(showCrop ? [{ tab: 'crop' as const, label: $t('crop') }] : []),
    ...(showAdjust
      ? [
          { tab: 'adjust' as const, label: $t('editor_adjust') },
          { tab: 'filters' as const, label: $t('filters') },
          { tab: 'straighten' as const, label: $t('editor_straighten') },
          { tab: 'markup' as const, label: $t('editor_markup') },
        ]
      : []),
  ]);
</script>

<div class="@container mt-3 px-2 sm:px-3">
  <div class="flex gap-0.5 sm:gap-1" role="tablist">
    {#each tabs as { tab, label } (tab)}
      <Button
        size="small"
        shape="round"
        role="tab"
        aria-selected={tab === active}
        color={tab === active ? 'primary' : 'secondary'}
        variant={tab === active ? 'filled' : 'outline'}
        class="min-w-0 px-[min(0.5rem,2.25cqw)] text-[min(0.875rem,3.9cqw)]/5"
        {disabled}
        onclick={() => tab !== active && onSelect(tab)}
      >
        <span class="truncate">{label}</span>
      </Button>
    {/each}
  </div>
</div>
