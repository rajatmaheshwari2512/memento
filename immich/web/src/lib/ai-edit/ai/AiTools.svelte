<!--
  SelfPhotos AI tools: the presets (ai-tools.json) as buttons like the Android app's (Immich's
  column buttons: icon above its name, up to two lines, no border, the selected ones in the
  primary colour), in two sections, each under its heading: Fixes, then Styles, each an even grid
  that wraps onto as many rows as needed (no sideways scrolling). Tapping a preset only selects or
  unselects it (the rules: ai-tools.ts toggleTool); Generate sends them. And the brush as an
  accordion: "Highlight" with undo and clear; opened, how it works and the brush size. A tool that
  needs a highlight (Move) waits for one; a tool that always changes the whole photo (styles, Auto
  frame) waits for the highlight to be cleared, and while one is selected brushing does nothing,
  so what's charged is what it does. A preset that can't be picked looks greyed, and tapping it
  says why (as the Android app does). A selected tool can always be unselected. Not part of Immich.
-->
<script lang="ts">
  import AdjustSlider from '#lib/ai-edit/adjust/AdjustSlider.svelte';
  import {
    AI_TOOLS,
    MAX_SELECTED,
    TOOL_GROUPS,
    blockedReason,
    has,
    toolLabelKey,
    type AiTool,
  } from '#lib/ai-edit/ai/ai-tools.ts';
  import { Icon, IconButton, Text, toastManager } from '@immich/ui';
  import {
    mdiAutoFix,
    mdiBlurOff,
    mdiChevronDown,
    mdiCropFree,
    mdiCursorMove,
    mdiDeleteOutline,
    mdiEraser,
    mdiLightbulbOnOutline,
    mdiMirror,
    mdiPalette,
    mdiPencilOutline,
    mdiUndo,
    mdiWaterOutline,
    mdiWeatherPartlyCloudy,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';
  import { slide } from 'svelte/transition';

  interface Props {
    disabled: boolean;
    hasHighlight: boolean;
    // The tools selected for the next edit, in ai-tools.json's order.
    selected: AiTool[];
    // A selected tool changes the whole photo (a style, Auto frame): brushing does nothing meanwhile.
    wholePhoto: boolean;
    brushRadius: number;
    // The Highlight accordion is open (the page keeps it: closed each time the page opens).
    open: boolean;
    onToggle: (tool: AiTool) => void;
    onUndo: () => void;
    onClear: () => void;
  }

  let {
    disabled,
    hasHighlight,
    selected,
    wholePhoto,
    brushRadius = $bindable(),
    open = $bindable(),
    onToggle,
    onUndo,
    onClear,
  }: Props = $props();

  // Each tool's icon; the Android app has its own (ai_tools.dart).
  const ICONS: Record<string, string> = {
    enhance: mdiAutoFix,
    unblur: mdiBlurOff,
    relight: mdiLightbulbOnOutline,
    sky: mdiWeatherPartlyCloudy,
    erase: mdiEraser,
    reflections: mdiMirror,
    glare: mdiWhiteBalanceSunny,
    move: mdiCursorMove,
    reframe: mdiCropFree,
    watercolour: mdiWaterOutline,
    sketch: mdiPencilOutline,
    painting: mdiPalette,
  };

  // Why a tool can't be picked now, if it can't (a selected one can always be unselected).
  const blocked = (tool: AiTool) => {
    const reason = blockedReason(tool, selected, hasHighlight);
    return reason ? $t(reason, { values: { count: MAX_SELECTED } }) : null;
  };
</script>

{#each TOOL_GROUPS as { group, labelKey } (group)}
  <!-- Immich's editor section heading (TransformTool, Adjust's pages), in the weight of the
       Highlight header and the preset names. -->
  <div class="mt-2 flex h-10 w-full items-center justify-between text-sm font-medium">
    <h2>{$t(labelKey)}</h2>
  </div>
  <!-- Equal columns, the same in both sections so they line up: 4 in the side panel, 3 on a
       phone. Buttons sit at the top of their cells, so a row's icons are level. -->
  <div class="-mx-2 grid grid-cols-3 min-[25rem]:grid-cols-4">
    {#each AI_TOOLS.filter((tool) => tool.group === group) as tool (tool.id)}
      {const chosen = $derived(has(selected, tool))}
      {const reason = $derived(blocked(tool))}
      <button
        type="button"
        aria-pressed={chosen}
        class={[
          'flex w-full flex-col items-center gap-2 self-start rounded-xl px-0.5 py-3 text-sm font-medium hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent aria-disabled:opacity-40 aria-disabled:hover:bg-transparent',
          chosen ? 'text-immich-dark-primary' : 'text-immich-dark-fg',
        ]}
        {disabled}
        aria-disabled={reason !== null}
        title={reason ?? undefined}
        onclick={() => (reason === null ? onToggle(tool) : toastManager.info(reason))}
      >
        <Icon icon={ICONS[tool.id]} size="24" />
        <span class="line-clamp-2 text-center">{$t(toolLabelKey(tool) as Translations)}</span>
      </button>
    {/each}
  </div>
{/each}

<!--
  The brush, as an accordion (like Immich's SettingAccordion, without its card): "Highlight" with
  undo and clear, needed while brushing, open or closed; opened, how it works and the brush size.
  Brushing on the photo works either way.
-->
<div class="mt-1 flex items-center gap-2">
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 self-stretch text-start text-sm font-medium"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Icon
      icon={mdiChevronDown}
      size="24"
      flopped={open}
      class="shrink-0 transition-transform {open ? 'text-immich-dark-primary' : 'text-gray-400'}"
      aria-hidden
    />
    <span class="flex min-w-0 flex-col">
      {$t('editor_ai_highlight')}
      {#if wholePhoto}
        <Text inline size="tiny" color="muted">{$t('editor_ai_brush_whole_photo')}</Text>
      {/if}
    </span>
  </button>
  <IconButton
    shape="round"
    variant="ghost"
    color="secondary"
    size="small"
    icon={mdiUndo}
    aria-label={$t('undo')}
    title={$t('undo')}
    disabled={disabled || !hasHighlight}
    onclick={onUndo}
  />
  <IconButton
    shape="round"
    variant="ghost"
    color="secondary"
    size="small"
    icon={mdiDeleteOutline}
    aria-label={$t('clear')}
    title={$t('clear')}
    disabled={disabled || !hasHighlight}
    onclick={onClear}
  />
</div>
{#if open}
  <div class="flex flex-col gap-2 pt-1 pb-2" transition:slide={{ duration: 150 }}>
    <Text size="tiny" color="muted">{$t('editor_ai_highlight_description')}</Text>
    <AdjustSlider
      label={$t('editor_ai_brush_size')}
      hideLabel
      value={Math.round(brushRadius * 100)}
      min={1}
      max={10}
      resetTo={4}
      {disabled}
      onChange={(value) => (brushRadius = value / 100)}
    />
  </div>
{/if}
