<!-- SelfPhotos Adjust: the Filters tab. -->
<script lang="ts">
  import AdjustSlider from '#lib/ai-edit/adjust/AdjustSlider.svelte';
  import { FILTERS, initialState, shaderValues } from '#lib/ai-edit/adjust/adjust-params.ts';
  import { AdjustRenderer } from '#lib/ai-edit/adjust/adjust-renderer.ts';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  interface Props {
    image: ImageBitmap;
    filter: string | null;
    strength: number;
    disabled: boolean;
  }

  let { image, filter = $bindable(), strength = $bindable(), disabled }: Props = $props();

  const THUMB = 96;
  const choices = [null, ...FILTERS.map(({ id }) => id)];
  const canvases: Record<string, HTMLCanvasElement> = $state({});

  onMount(() => {
    let cancelled = false;
    void (async () => {
      const scale = (THUMB * 2) / Math.max(image.width, image.height);
      const size = {
        width: Math.max(1, Math.round(image.width * scale)),
        height: Math.max(1, Math.round(image.height * scale)),
      };
      const work = new OffscreenCanvas(size.width, size.height);
      let small: ImageBitmap | undefined;
      let renderer: AdjustRenderer | undefined;
      try {
        small = await createImageBitmap(image, {
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: 'high',
        });
        renderer = new AdjustRenderer(work);
        renderer.setImage(small);
        const whole = { x: 0, y: 0, ...size };
        for (const id of choices) {
          const canvas = canvases[id ?? 'none'];
          if (cancelled || !canvas) {
            continue;
          }
          const values = shaderValues({ ...initialState(), filter: id, strength: 1 });
          renderer.render({
            values,
            degrees: 0,
            source: size,
            output: size,
            tile: whole,
            texture: whole,
            onScreen: true,
          });
          canvas.width = size.width;
          canvas.height = size.height;
          canvas.getContext('2d')?.drawImage(work, 0, 0);
        }
      } catch {
      } finally {
        renderer?.dispose();
        small?.close();
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

<div class="mt-2 flex h-10 w-full items-center justify-between text-sm">
  <h2>{$t('filters')}</h2>
</div>
<div class="mb-4 grid grid-cols-3 gap-3" role="radiogroup" aria-label={$t('filters')}>
  {#each choices as id (id)}
    <button
      type="button"
      role="radio"
      aria-checked={filter === id}
      {disabled}
      class="flex flex-col items-center gap-1 text-sm text-white disabled:opacity-50"
      onclick={() => {
        filter = id;
        strength = 1;
      }}
    >
      <span
        class={[
          'flex size-24 items-center justify-center overflow-hidden rounded-xl bg-immich-dark-gray',
          filter === id ? 'ring-2 ring-immich-dark-primary' : 'ring-1 ring-white/20',
        ]}
      >
        <canvas bind:this={canvases[id ?? 'none']} class="size-full object-cover" aria-hidden="true"></canvas>
      </span>
      <span class={filter === id ? 'text-immich-dark-primary' : ''}
        >{$t(id ? (`editor_filter_${id}` as Translations) : 'none')}</span
      >
    </button>
  {/each}
</div>

{#if filter}
  <AdjustSlider
    label={$t('editor_filter_strength')}
    value={Math.round(strength * 100)}
    min={0}
    max={100}
    resetTo={100}
    format={(value) => `${value}%`}
    {disabled}
    onChange={(value) => (strength = value / 100)}
  />
{/if}
