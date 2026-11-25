<!--
  SelfPhotos editor: the editor's tabs, shown at the top of both Immich's editor (Crop) and
  Adjust's pages (Adjustments, Filters, Straighten, Markup), so they read as one editor. The same
  buttons as Immich's crop ratios: filled when chosen, outlined otherwise. Adjust's tabs show
  only when Adjust is on for this photo. AI Edit isn't a tab: it opens only from its own button
  and has the whole editor to itself. Not part of Immich.
-->
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

<!-- Immich's pills, a little narrower, on one row. In the editor's 400 px panel they have Immich's
     own text size and gaps. Narrower (a phone 360 or 375 wide, or a larger font) the names and
     the room around them get smaller together, so all five still fit side by side; a name that
     still doesn't fit ends in "…" rather than wrapping. The sizes are shares of the row's width
     (cqw): 3.9% is 14 px and 2.25% is 8 px in the panel's 360 px row. -->
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
