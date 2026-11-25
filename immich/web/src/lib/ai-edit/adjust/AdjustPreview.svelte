<!--
  SelfPhotos Adjust: the live preview. Immich's screen-sized preview of the photo, drawn
  through the shared shader at the size it's shown, so moving a slider costs one GPU pass.
  The saved copy is rendered separately, at full size (adjust-export.ts). Not part of Immich.
-->
<script lang="ts">
  import { framing } from '#lib/ai-edit/adjust/adjust-geometry.ts';
  import { initialState, shaderValues, type AdjustState } from '#lib/ai-edit/adjust/adjust-params.ts';
  import { AdjustRenderer, AdjustUnsupportedError } from '#lib/ai-edit/adjust/adjust-renderer.ts';
  import { onMount, type Snippet } from 'svelte';

  interface Props {
    image: ImageBitmap;
    settings: AdjustState;
    // Show the photo as it was (while "compare" is held).
    original: boolean;
    // A 3×3 grid on top, for straightening.
    grid: boolean;
    alt: string;
    onUnsupported: () => void;
    // Drawn on top, in the photo's own box (Markup's layer).
    children?: Snippet;
  }

  let { image, settings, original, grid, alt, onUnsupported, children }: Props = $props();

  let container = $state<HTMLElement>();
  let canvas = $state<HTMLCanvasElement>();
  let renderer = $state.raw<AdjustRenderer>();
  let space = $state({ width: 0, height: 0 });
  let uploaded: ImageBitmap | undefined;

  const shownState = $derived(original ? initialState() : settings);

  // The picture fitted into the space, keeping its shape: the photo's (straightening keeps it),
  // or perspective's crop's, which may be another (so Markup's layer, in this box, follows it).
  const shown = $derived.by(() => {
    const view = framing(shownState.angle, image, shownState.perspective);
    const picture = view.toPhoto
      ? { width: image.width * view.scale[0], height: image.height * view.scale[1] }
      : { width: image.width, height: image.height };
    const scale = Math.min(space.width / picture.width, space.height / picture.height);
    return {
      width: Math.max(1, Math.floor(picture.width * scale)),
      height: Math.max(1, Math.floor(picture.height * scale)),
    };
  });

  onMount(() => {
    try {
      renderer = new AdjustRenderer(canvas!);
    } catch (error) {
      if (!(error instanceof AdjustUnsupportedError)) {
        throw error;
      }
      onUnsupported();
    }
    const observer = new ResizeObserver(([entry]) => {
      space = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    observer.observe(container!);
    return () => {
      observer.disconnect();
      renderer?.dispose();
    };
  });

  $effect(() => {
    const values = shaderValues(shownState);
    const degrees = shownState.angle;
    const perspective = shownState.perspective;
    const width = Math.round(shown.width * devicePixelRatio);
    const height = Math.round(shown.height * devicePixelRatio);
    if (!renderer || !canvas) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (uploaded !== image) {
        renderer!.setImage(image, true);
        uploaded = image;
      }
      if (canvas!.width !== width || canvas!.height !== height) {
        canvas!.width = width;
        canvas!.height = height;
      }
      const output = { width, height };
      renderer!.render({
        values,
        degrees,
        perspective,
        source: { width: image.width, height: image.height },
        output,
        tile: { x: 0, y: 0, ...output },
        texture: { x: 0, y: 0, width: image.width, height: image.height },
        onScreen: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<div bind:this={container} class="flex size-full items-center justify-center">
  <div class="relative" style:width="{shown.width}px" style:height="{shown.height}px" role="img" aria-label={alt}>
    <canvas bind:this={canvas} class="size-full" aria-hidden="true"></canvas>
    {#if grid}
      <div class="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3" aria-hidden="true">
        {#each { length: 9 } as _, i (i)}
          <div class="border-[0.5px] border-white/40"></div>
        {/each}
      </div>
    {/if}
    {@render children?.()}
  </div>
</div>
