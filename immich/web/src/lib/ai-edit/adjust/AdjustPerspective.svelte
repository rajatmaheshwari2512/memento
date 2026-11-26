<!-- SelfPhotos Adjust: Perspective's four corners, on the photo shown whole and unwarped. -->
<script lang="ts">
  import { isValidPerspective, photoCorners, type Point, type Quad } from '#lib/ai-edit/adjust/adjust-geometry.ts';
  import { clamp } from 'lodash-es';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    corners: Quad | null;
    disabled: boolean;
    onChange: (corners: Quad) => void;
  }

  let { corners, disabled, onChange }: Props = $props();

  const NAMES = ['top_left', 'top_right', 'bottom_right', 'bottom_left'] as const;

  const shown = $derived(corners ?? photoCorners());
  let box = $state<HTMLElement>();
  let drag = $state<{ index: number; offset: Point } | null>(null);

  let refused = $state(false);
  let hideHint: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(hideHint));

  const move = (index: number, [x, y]: Point) => {
    const next = shown.map((corner, i) => (i === index ? [clamp(x, 0, 1), clamp(y, 0, 1)] : corner)) as Quad;
    if (isValidPerspective(next)) {
      onChange(next);
      return;
    }
    refused = true;
    clearTimeout(hideHint);
    hideHint = setTimeout(() => (refused = false), 2500);
  };

  const pointerAt = (event: PointerEvent): Point => {
    const { left, top, width, height } = box!.getBoundingClientRect();
    return [(event.clientX - left) / width, (event.clientY - top) / height];
  };

  const start = (event: PointerEvent, index: number) => {
    const [x, y] = pointerAt(event);
    drag = { index, offset: [shown[index][0] - x, shown[index][1] - y] };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const follow = (event: PointerEvent) => {
    if (drag) {
      const [x, y] = pointerAt(event);
      move(drag.index, [x + drag.offset[0], y + drag.offset[1]]);
    }
  };

  const STEPS: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  const nudge = (event: KeyboardEvent, index: number) => {
    const step = STEPS[event.key];
    if (step) {
      event.preventDefault();
      const size = event.shiftKey ? 0.02 : 0.005;
      move(index, [shown[index][0] + step[0] * size, shown[index][1] + step[1] * size]);
    }
  };

  const outline = $derived(shown.map(([x, y]) => `${x},${y}`).join(' '));
</script>

<div bind:this={box} class="absolute inset-0 touch-none select-none">
  <svg
    class="pointer-events-none absolute inset-0 size-full"
    viewBox="0 0 1 1"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path d="M0 0H1V1H0Z M{outline.replaceAll(' ', ' L')}Z" fill="rgb(0 0 0 / 0.45)" fill-rule="evenodd" />
    <polygon
      points={outline}
      fill="none"
      stroke="black"
      stroke-opacity="0.5"
      stroke-width="3"
      vector-effect="non-scaling-stroke"
    />
    <polygon points={outline} fill="none" stroke="white" stroke-width="1.5" vector-effect="non-scaling-stroke" />
  </svg>
  <p class="pointer-events-none absolute inset-x-0 top-3 flex justify-center" role="status">
    {#if refused}
      <span class="rounded-full bg-black/75 px-3 py-1 text-sm whitespace-nowrap text-white">
        {$t('editor_perspective_too_small')}
      </span>
    {/if}
  </p>
  {#each shown as [x, y], index (index)}
    <button
      type="button"
      class="absolute flex size-11 -translate-1/2 cursor-grab items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white active:cursor-grabbing disabled:cursor-default"
      style:left="{x * 100}%"
      style:top="{y * 100}%"
      aria-label={$t('editor_handle_corner', { values: { corner: NAMES[index] } })}
      {disabled}
      onpointerdown={(event) => start(event, index)}
      onpointermove={follow}
      onpointerup={() => (drag = null)}
      onpointercancel={() => (drag = null)}
      onkeydown={(event) => nudge(event, index)}
    >
      <span
        class={[
          'rounded-full border-2 border-white shadow-[0_0_0_1.5px_rgb(0_0_0/0.7)]',
          drag?.index === index ? 'size-8' : 'size-5 bg-immich-dark-primary',
        ]}
      ></span>
    </button>
  {/each}
</div>
