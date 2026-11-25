<!--
  SelfPhotos Adjust: the Straighten tab, in two modes. Straighten: one angle slider; the photo is
  cropped to the largest rectangle of its own shape so no empty corners show
  (adjust-geometry.ts). Perspective: four corners on the photo (AdjustPerspective.svelte), shown
  whole while they're moved; the result shows back in Straighten. The modes are buttons like the
  editor's tabs. Not part of Immich.
-->
<script lang="ts">
  import AdjustSlider from '#lib/ai-edit/adjust/AdjustSlider.svelte';
  import { MAX_ANGLE } from '#lib/ai-edit/adjust/adjust-params.ts';
  import { Button, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    angle: number;
    // The Perspective mode is chosen.
    perspective: boolean;
    disabled: boolean;
  }

  let { angle = $bindable(), perspective = $bindable(), disabled }: Props = $props();

  const modes = $derived([
    { perspective: false, label: $t('editor_straighten') },
    { perspective: true, label: $t('editor_perspective') },
  ]);
</script>

<div class="mt-2 mb-3 flex gap-1" role="radiogroup" aria-label={$t('editor_straighten')}>
  {#each modes as mode (mode.perspective)}
    <Button
      size="small"
      shape="round"
      role="radio"
      aria-checked={mode.perspective === perspective}
      color={mode.perspective === perspective ? 'primary' : 'secondary'}
      variant={mode.perspective === perspective ? 'filled' : 'outline'}
      {disabled}
      onclick={() => (perspective = mode.perspective)}
    >
      {mode.label}
    </Button>
  {/each}
</div>
{#if perspective}
  <Text size="small" color="muted" class="mb-4">{$t('editor_perspective_description')}</Text>
{:else}
  <Text size="small" color="muted" class="mb-4">{$t('editor_straighten_description')}</Text>
  <AdjustSlider
    label={$t('editor_straighten')}
    value={angle}
    min={-MAX_ANGLE}
    max={MAX_ANGLE}
    step={0.1}
    format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}°`}
    {disabled}
    onChange={(value) => (angle = value)}
  />
{/if}
