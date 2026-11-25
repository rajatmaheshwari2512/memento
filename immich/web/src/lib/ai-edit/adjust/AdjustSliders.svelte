<!--
  SelfPhotos Adjust: the Adjustments tab. Auto first (AdjustAuto.svelte), then the sliders under
  Immich's own headings ("Light", "Color"), laid out like its crop tool. Not part of Immich.
-->
<script lang="ts">
  import AdjustAuto from '#lib/ai-edit/adjust/AdjustAuto.svelte';
  import AdjustSlider from '#lib/ai-edit/adjust/AdjustSlider.svelte';
  import { SLIDERS, type Adjustments } from '#lib/ai-edit/adjust/adjust-params.ts';
  import { t } from 'svelte-i18n';

  interface Props {
    adjustments: Adjustments;
    // The photo Auto looks at (Immich's preview), once loaded.
    image: ImageBitmap | null;
    disabled: boolean;
  }

  let { adjustments = $bindable(), image, disabled }: Props = $props();

  const groups = [
    { heading: 'light', sliders: SLIDERS.filter(({ group }) => group === 'light') },
    { heading: 'color', sliders: SLIDERS.filter(({ group }) => group === 'color') },
  ] as const;
</script>

<div class="mt-2 flex">
  <AdjustAuto {image} {disabled} onAuto={(values) => Object.assign(adjustments, values)} />
</div>
{#each groups as { heading, sliders } (heading)}
  <div class="mt-2 flex h-10 w-full items-center justify-between text-sm">
    <h2>{$t(heading)}</h2>
  </div>
  {#each sliders as { key, label } (key)}
    <AdjustSlider
      label={$t(label)}
      value={Math.round(adjustments[key] * 100)}
      min={-100}
      max={100}
      {disabled}
      onChange={(value) => (adjustments[key] = value / 100)}
    />
  {/each}
{/each}
