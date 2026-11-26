<!-- SelfPhotos Adjust's Markup tab. -->
<script lang="ts">
  import type { MarkupEditor, MarkupShapeKind, MarkupTool } from '#lib/ai-edit/adjust/markup-editor.svelte.ts';
  import { MARKUP_COLOURS, MARKUP_SIZES, TEXT } from '#lib/ai-edit/adjust/markup.ts';
  import { Button, Icon, IconButton, Input, Text } from '@immich/ui';
  import {
    mdiArrowTopRight,
    mdiCircleOutline,
    mdiDeleteOutline,
    mdiFormatText,
    mdiMarker,
    mdiPen,
    mdiRectangleOutline,
    mdiRedo,
    mdiShapeOutline,
    mdiUndo,
  } from '@mdi/js';
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    editor: MarkupEditor;
    disabled: boolean;
  }

  let { editor, disabled }: Props = $props();

  const TOOLS: { tool: MarkupTool; icon: string; label: string }[] = $derived([
    { tool: 'pen', icon: mdiPen, label: $t('editor_markup_pen') },
    { tool: 'highlighter', icon: mdiMarker, label: $t('editor_markup_highlighter') },
    { tool: 'text', icon: mdiFormatText, label: $t('editor_markup_text') },
    { tool: 'shapes', icon: mdiShapeOutline, label: $t('editor_markup_shapes') },
  ]);

  const SHAPES: { shape: MarkupShapeKind; icon: string; label: string }[] = $derived([
    { shape: 'arrow', icon: mdiArrowTopRight, label: $t('editor_markup_arrow') },
    { shape: 'box', icon: mdiRectangleOutline, label: $t('editor_markup_box') },
    { shape: 'circle', icon: mdiCircleOutline, label: $t('editor_markup_circle') },
  ]);

  const DOTS = [6, 10, 16];

  let field = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (editor.newText > 0) {
      void tick().then(() => field?.focus());
    }
  });
</script>

<div class="mt-2 flex items-center gap-1">
  <Text size="small" color="muted" class="min-w-0 flex-1">
    {editor.tool === 'text' ? $t('editor_markup_text_description') : $t('editor_markup_draw_description')}
  </Text>
  <IconButton
    shape="round"
    variant="ghost"
    color="secondary"
    size="small"
    icon={mdiUndo}
    aria-label={$t('undo')}
    title={$t('undo')}
    disabled={disabled || !editor.canUndo}
    onclick={() => editor.undo()}
  />
  <IconButton
    shape="round"
    variant="ghost"
    color="secondary"
    size="small"
    icon={mdiRedo}
    aria-label={$t('editor_markup_redo')}
    title={$t('editor_markup_redo')}
    disabled={disabled || !editor.canRedo}
    onclick={() => editor.redo()}
  />
  <IconButton
    shape="round"
    variant="ghost"
    color="secondary"
    size="small"
    icon={mdiDeleteOutline}
    aria-label={$t('clear')}
    title={$t('clear')}
    disabled={disabled || editor.isEmpty}
    onclick={() => editor.clear()}
  />
</div>

<div class="-mx-2 mt-1 grid grid-cols-4" role="radiogroup" aria-label={$t('editor_markup')}>
  {#each TOOLS as { tool, icon, label } (tool)}
    <button
      type="button"
      role="radio"
      aria-checked={editor.tool === tool}
      class={[
        'flex w-full flex-col items-center gap-2 self-start rounded-xl px-0.5 py-3 text-sm font-medium hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent',
        editor.tool === tool ? 'text-immich-dark-primary' : 'text-immich-dark-fg',
      ]}
      {disabled}
      onclick={() => editor.setTool(tool)}
    >
      <Icon {icon} size="24" />
      <span class="line-clamp-2 text-center">{label}</span>
    </button>
  {/each}
</div>

{#if editor.tool === 'shapes'}
  <div class="mt-1 flex flex-wrap gap-1" role="radiogroup" aria-label={$t('editor_markup_shapes')}>
    {#each SHAPES as { shape, icon, label } (shape)}
      <Button
        size="small"
        shape="round"
        role="radio"
        aria-checked={editor.shape === shape}
        color={editor.shape === shape ? 'primary' : 'secondary'}
        variant={editor.shape === shape ? 'filled' : 'outline'}
        leadingIcon={icon}
        {disabled}
        onclick={() => (editor.shape = shape)}
      >
        {label}
      </Button>
    {/each}
  </div>
{/if}

{#if editor.tool === 'text' && editor.selectedText}
  <div class="mt-2 flex items-center gap-1">
    <Input
      bind:ref={field}
      value={editor.selectedText.text}
      maxlength={TEXT.maxLength}
      placeholder={$t('editor_markup_text_placeholder')}
      aria-label={$t('editor_markup_text')}
      {disabled}
      oninput={(event) => editor.setText(event.currentTarget.value)}
      onkeydown={(event) => event.key === 'Enter' && editor.select(null)}
    />
    <IconButton
      shape="round"
      variant="ghost"
      color="secondary"
      size="small"
      icon={mdiDeleteOutline}
      aria-label={$t('delete')}
      title={$t('delete')}
      {disabled}
      onclick={() => editor.deleteSelected()}
    />
  </div>
{/if}

<div class="mt-2 flex h-10 w-full items-center text-sm">
  <h2>{$t('color')}</h2>
</div>
<div class="flex flex-wrap gap-2.5" role="radiogroup" aria-label={$t('color')}>
  {#each MARKUP_COLOURS as { fill }, index (fill)}
    <button
      type="button"
      role="radio"
      aria-checked={editor.colour === fill}
      aria-label="{$t('color')} {index + 1}"
      title="{$t('color')} {index + 1}"
      class={[
        'size-8 rounded-full ring-offset-2 ring-offset-immich-dark-bg disabled:opacity-40',
        editor.colour === fill ? 'ring-2 ring-immich-dark-primary' : 'ring-1 ring-white/30',
      ]}
      style:background-color={fill}
      {disabled}
      onclick={() => editor.setColour(fill)}
    ></button>
  {/each}
</div>

<div class="mt-2 flex h-10 w-full items-center text-sm">
  <h2>{$t('size')}</h2>
</div>
<div class="mb-2 flex gap-2" role="radiogroup" aria-label={$t('size')}>
  {#each MARKUP_SIZES as _, index (index)}
    <button
      type="button"
      role="radio"
      aria-checked={editor.size === index}
      aria-label="{$t('size')} {index + 1}"
      title="{$t('size')} {index + 1}"
      class={[
        'flex size-10 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40',
        editor.size === index && 'ring-2 ring-immich-dark-primary',
      ]}
      {disabled}
      onclick={() => editor.setSize(index)}
    >
      <span
        class={['rounded-full', editor.size === index ? 'bg-immich-dark-primary' : 'bg-immich-dark-fg']}
        style:width="{DOTS[index]}px"
        style:height="{DOTS[index]}px"
      ></span>
    </button>
  {/each}
</div>
