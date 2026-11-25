<!--
  SelfPhotos AI tools: the photo in the editor, fitted to the space as Adjust's preview is, with
  the brush: while `brushing`, a finger or the mouse paints the area to change, shown tinted red
  as the AI will see it. Holding "compare" shows `original` instead. A pulse covers the photo
  while the AI works. Not part of Immich.
-->
<script lang="ts">
  import { drawStrokes, type Stroke } from '#lib/ai-edit/ai/ai-area.ts';
  import { AREA } from '#lib/ai-edit/ai/ai-tools.ts';
  import { captureDrawingPress, movedPast, pointOn } from '#lib/ai-edit/pointer.ts';
  import { IconButton, Text } from '@immich/ui';
  import { mdiCompare } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    src: string;
    // Shown while "compare" is held; none: no compare button.
    original?: string;
    // The photo's shape.
    width: number;
    height: number;
    strokes: Stroke[];
    // A share of the photo's longer side.
    brushRadius: number;
    brushing: boolean;
    working: boolean;
    alt: string;
  }

  let { src, original, width, height, strokes = $bindable(), brushRadius, brushing, working, alt }: Props = $props();

  let container = $state<HTMLElement>();
  let canvas = $state<HTMLCanvasElement>();
  let space = $state({ width: 0, height: 0 });
  let comparing = $state(false);
  let drawing = $state(false);
  let pointer = $state<{ x: number; y: number } | null>(null);

  const shown = $derived.by(() => {
    const scale = Math.min(space.width / width, space.height / height);
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  });
  const ring = $derived(brushRadius * 2 * Math.max(shown.width, shown.height));
  const [red, green, blue, alpha] = AREA.tint;

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      space = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    observer.observe(container!);
    return () => observer.disconnect();
  });

  $effect(() => {
    const size = {
      width: Math.round(shown.width * devicePixelRatio),
      height: Math.round(shown.height * devicePixelRatio),
    };
    if (!canvas) {
      return;
    }
    canvas.width = size.width; // also clears it
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context && !comparing) {
      drawStrokes(context, strokes, size, `rgb(${red}, ${green}, ${blue})`);
    }
  });

  const start = (event: PointerEvent) => {
    if (!brushing || !captureDrawingPress(canvas!, event)) {
      return;
    }
    drawing = true;
    strokes = [...strokes, { points: [pointOn(canvas!, event)], radius: brushRadius }];
  };

  const move = (event: PointerEvent) => {
    const box = canvas!.getBoundingClientRect();
    pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
    const last = strokes.at(-1);
    if (!drawing || !last) {
      return;
    }
    const point = pointOn(canvas!, event);
    // Only points a little apart, so a long stroke stays small.
    if (movedPast(last.points.at(-1)!, point, 0.002)) {
      strokes = [...strokes.slice(0, -1), { ...last, points: [...last.points, point] }];
    }
  };

  const end = () => {
    drawing = false;
  };
</script>

<div bind:this={container} class="flex size-full items-center justify-center">
  <div class="relative overflow-hidden" style:width="{shown.width}px" style:height="{shown.height}px">
    <img src={comparing && original ? original : src} {alt} class="size-full select-none" draggable="false" />
    <canvas
      bind:this={canvas}
      class={['absolute inset-0 size-full touch-none', brushing ? 'cursor-crosshair' : 'pointer-events-none']}
      style:opacity={alpha}
      aria-hidden="true"
      onpointerdown={start}
      onpointermove={move}
      onpointerup={end}
      onpointercancel={end}
      onpointerleave={() => (pointer = null)}
    ></canvas>
    {#if brushing && pointer && !drawing}
      <div
        class="pointer-events-none absolute rounded-full border border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
        style:width="{ring}px"
        style:height="{ring}px"
        style:left="{pointer.x - ring / 2}px"
        style:top="{pointer.y - ring / 2}px"
        aria-hidden="true"
      ></div>
    {/if}
    {#if working}
      <div class="absolute inset-0 flex animate-pulse items-center justify-center bg-black/50" aria-busy="true">
        <Text size="small" class="text-white">{$t('editor_ai_editing')}</Text>
      </div>
    {/if}
  </div>
</div>

{#if original && !working}
  <div class="absolute inset-e-0 bottom-0 me-4 mb-4">
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      class="text-white"
      icon={mdiCompare}
      aria-label={$t('editor_compare')}
      title={$t('editor_compare')}
      onpointerdown={() => (comparing = true)}
      onpointerup={() => (comparing = false)}
      onpointerleave={() => (comparing = false)}
    />
  </div>
{/if}
