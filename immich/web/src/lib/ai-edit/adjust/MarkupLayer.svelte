<!-- SelfPhotos Adjust's Markup. -->
<script lang="ts">
  import type { MarkupEditor } from '#lib/ai-edit/adjust/markup-editor.svelte.ts';
  import {
    HIGHLIGHTER,
    MARKUP_SIZES,
    MIN_STEP,
    drawMarkup,
    markupFontReady,
    textBox,
    type MarkupItem,
    type MarkupLine,
    type MarkupPoint,
    type MarkupShape,
    type MarkupText,
  } from '#lib/ai-edit/adjust/markup.ts';
  import { captureDrawingPress, movedPast, pointOn } from '#lib/ai-edit/pointer.ts';
  import { clamp } from 'lodash-es';
  import { onMount } from 'svelte';

  interface Props {
    editor: MarkupEditor;
    // The Markup tab is open: touches draw.
    active: boolean;
    // "Compare" is held: the photo as it was.
    hidden: boolean;
  }

  let { editor, active, hidden }: Props = $props();

  const TEXT_PADDING = 8;
  const HANDLE = 22;

  let canvas = $state<HTMLCanvasElement>();
  let space = $state({ width: 0, height: 0 });
  let fontReady = $state(false);

  type TextDrag = { index: number; item: MarkupText; shown: MarkupItem; moved: boolean };
  type Drag =
    | { kind: 'line'; pointerId: number; line: MarkupLine }
    | { kind: 'shape'; pointerId: number; start: MarkupPoint; shape: MarkupShape | null }
    | ({ kind: 'move'; pointerId: number; start: MarkupPoint } & TextDrag)
    | ({ kind: 'resize'; pointerId: number; centre: [number, number]; distance: number } & TextDrag)
    | { kind: 'leave'; pointerId: number }
    | ({ kind: 'pinch'; pointerIds: [number, number]; distance: number } & TextDrag);
  let drag: Drag | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const pointers = new Map<number, [number, number]>();

  function stop() {
    drag = null;
    pointers.clear();
  }

  $effect(() => {
    if (!active) {
      stop();
    }
  });

  onMount(() => {
    void markupFontReady().then(() => (fontReady = true));
    const observer = new ResizeObserver(([entry]) => {
      space = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    observer.observe(canvas!);
    return () => observer.disconnect();
  });

  $effect(() => {
    const size = {
      width: Math.round(space.width * devicePixelRatio),
      height: Math.round(space.height * devicePixelRatio),
    };
    const items = editor.items;
    if (!canvas || !fontReady) {
      return;
    }
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context && !hidden) {
      drawMarkup(context, items, size);
    }
  });

  const selectedBox = $derived.by(() => {
    const item = editor.selectedText;
    const context = canvas?.getContext('2d');
    if (!item || !context || !fontReady || hidden) {
      return null;
    }
    return boxOf(context, item);
  });

  function boxOf(context: CanvasRenderingContext2D, item: MarkupText) {
    const box = textBox(context, item, space);
    const width = Math.max(box.width, box.height / 2);
    return {
      x: box.x - (width - box.width) / 2 - TEXT_PADDING,
      y: box.y - TEXT_PADDING,
      width: width + TEXT_PADDING * 2,
      height: box.height + TEXT_PADDING * 2,
    };
  }

  const distance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function textAt(point: MarkupPoint): number | null {
    const context = canvas!.getContext('2d')!;
    const [x, y] = [point[0] * space.width, point[1] * space.height];
    for (let index = editor.items.length - 1; index >= 0; index--) {
      const item = editor.items[index];
      if (item.kind !== 'text') {
        continue;
      }
      const box = boxOf(context, item);
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        return index;
      }
    }
    return null;
  }

  const replaceLast = (item: MarkupItem) => editor.amend([...editor.items.slice(0, -1), item]);

  const isLast = (item: MarkupItem | null) => item !== null && editor.items.at(-1) === item;

  function press(event: PointerEvent) {
    if (!active || !captureDrawingPress(canvas!, event)) {
      return false;
    }
    event.preventDefault();
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (drag) {
      startPinch();
      return false;
    }
    return true;
  }

  const start = (event: PointerEvent) => {
    if (!press(event)) {
      return;
    }
    const point = pointOn(canvas!, event);
    const { pointerId } = event;
    const { width } = MARKUP_SIZES[editor.size];
    switch (editor.tool) {
      case 'pen':
      case 'highlighter': {
        const line: MarkupLine = {
          kind: editor.tool,
          colour: editor.colour,
          width: editor.tool === 'highlighter' ? width * HIGHLIGHTER.widthScale : width,
          points: [point],
        };
        editor.commit([...editor.items, line]);
        drag = { kind: 'line', pointerId, line };
        break;
      }
      case 'shapes': {
        drag = { kind: 'shape', pointerId, start: point, shape: null };
        break;
      }
      case 'text': {
        const hit = textAt(point);
        if (hit !== null) {
          editor.select(hit);
          const item = editor.selectedText;
          if (item && editor.selected !== null) {
            drag = { kind: 'move', pointerId, index: editor.selected, item, shown: item, start: point, moved: false };
          }
        } else if (editor.selected === null) {
          editor.addText(point);
        } else {
          drag = { kind: 'leave', pointerId };
        }
        break;
      }
    }
  };

  const startResize = (event: PointerEvent) => {
    const item = editor.selectedText;
    if (!item || editor.selected === null || !press(event)) {
      return;
    }
    event.stopPropagation();
    const box = canvas!.getBoundingClientRect();
    const centre: [number, number] = [box.left + item.at[0] * box.width, box.top + item.at[1] * box.height];
    drag = {
      kind: 'resize',
      pointerId: event.pointerId,
      index: editor.selected,
      item,
      shown: item,
      centre,
      distance: Math.max(1, distance([event.clientX, event.clientY], centre)),
      moved: false,
    };
  };

  function startPinch() {
    const item = editor.selectedText;
    const pointerIds = [...pointers.keys()];
    if (editor.tool !== 'text' || !item || editor.selected === null || pointerIds.length !== 2) {
      return;
    }
    const [a, b] = pointerIds.map((id) => pointers.get(id)!);
    drag = {
      kind: 'pinch',
      pointerIds: [pointerIds[0], pointerIds[1]],
      index: editor.selected,
      item,
      shown: item,
      distance: Math.max(1, distance(a, b)),
      moved: false,
    };
  }

  const isDrawing = (event: PointerEvent) =>
    drag?.kind === 'pinch' ? drag.pointerIds.includes(event.pointerId) : drag?.pointerId === event.pointerId;

  function dragText(drag: TextDrag, change: (index: number, item: MarkupText, newChange: boolean) => void) {
    if (editor.items[drag.index] !== drag.shown) {
      return false;
    }
    change(drag.index, drag.item, !drag.moved);
    drag.moved = true;
    drag.shown = editor.items[drag.index];
    return true;
  }

  const move = (event: PointerEvent) => {
    if (!active) {
      stop();
      return;
    }
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, [event.clientX, event.clientY]);
    }
    if (!drag || !isDrawing(event)) {
      return;
    }
    const point = pointOn(canvas!, event);
    let going = true;
    switch (drag.kind) {
      case 'line': {
        going = isLast(drag.line);
        if (going && movedPast(drag.line.points.at(-1)!, point, MIN_STEP)) {
          drag.line = { ...drag.line, points: [...drag.line.points, point] };
          replaceLast(drag.line);
        }
        break;
      }
      case 'shape': {
        const shape: MarkupShape = {
          kind: editor.shape,
          colour: editor.colour,
          width: MARKUP_SIZES[editor.size].width,
          from: drag.start,
          to: point,
        };
        if (drag.shape) {
          going = isLast(drag.shape);
          if (going) {
            replaceLast(shape);
            drag.shape = shape;
          }
        } else if (movedPast(drag.start, point, MIN_STEP * 5)) {
          editor.commit([...editor.items, shape]);
          drag.shape = shape;
        }
        break;
      }
      case 'move': {
        const { item, start } = drag;
        if (drag.moved || movedPast(start, point, MIN_STEP)) {
          const at: MarkupPoint = [
            clamp(item.at[0] + point[0] - start[0], 0, 1),
            clamp(item.at[1] + point[1] - start[1], 0, 1),
          ];
          going = dragText(drag, (index, text, newChange) => editor.moveText(index, text, at, newChange));
        }
        break;
      }
      case 'resize': {
        const scale = distance([event.clientX, event.clientY], drag.centre) / drag.distance;
        going = dragText(drag, (index, text, newChange) =>
          editor.resizeText(index, text, text.fontSize * scale, newChange),
        );
        break;
      }
      case 'pinch': {
        const [a, b] = drag.pointerIds.map((id) => pointers.get(id)!);
        const scale = distance(a, b) / drag.distance;
        going = dragText(drag, (index, text, newChange) =>
          editor.resizeText(index, text, text.fontSize * scale, newChange),
        );
        break;
      }
      case 'leave': {
        break;
      }
    }
    if (!going) {
      drag = null;
    }
  };

  const end = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (drag && isDrawing(event)) {
      if (drag.kind === 'leave' && event.type === 'pointerup') {
        editor.select(null);
      }
      drag = null;
    }
  };

  const cursor = $derived(editor.tool === 'text' ? 'cursor-text' : 'cursor-crosshair');
</script>

<canvas
  bind:this={canvas}
  class={['absolute inset-0 size-full touch-none', active ? cursor : 'pointer-events-none']}
  aria-hidden="true"
  onpointerdown={start}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
  onlostpointercapture={end}
></canvas>
{#if active && selectedBox}
  <div
    class="pointer-events-none absolute rounded-sm border border-dashed border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
    style:left="{selectedBox.x}px"
    style:top="{selectedBox.y}px"
    style:width="{selectedBox.width}px"
    style:height="{selectedBox.height}px"
    aria-hidden="true"
  ></div>
  <div
    class="absolute cursor-nwse-resize touch-none rounded-full border-2 border-white bg-immich-dark-primary shadow-sm"
    style:left="{selectedBox.x + selectedBox.width - HANDLE / 2}px"
    style:top="{selectedBox.y + selectedBox.height - HANDLE / 2}px"
    style:width="{HANDLE}px"
    style:height="{HANDLE}px"
    aria-hidden="true"
    onpointerdown={startResize}
  ></div>
{/if}
