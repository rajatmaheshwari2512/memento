<!--
  SelfPhotos editor pages (Adjust, AI Edit): laid out like Immich's own editor. The photo on
  black, and its dark side panel (EditorPanel.svelte) with close, the title and Save, the
  editor's tabs (Adjust's pages: Crop opens Immich's own editor), the tool, and a footer at the
  bottom. On narrow screens the panel goes under the photo instead of beside it, so the photo
  stays visible; a compact panel (AI Edit's) is only as tall as its tools there, so the photo
  gets about two thirds of the height. Not part of Immich.
-->
<script lang="ts">
  import { focusTrap } from '#lib/actions/focus-trap.ts';
  import { shortcuts } from '#lib/actions/shortcut.ts';
  import { Button, HStack, IconButton } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    // The header's title: "Editor" unless given.
    title?: string;
    // On narrow screens, a panel under the photo only as tall as its tools (at most half the
    // height; what doesn't fit scrolls inside it), so the photo gets the rest.
    compact?: boolean;
    saving: boolean;
    canSave: boolean;
    onSave: () => void;
    onClose: () => void;
    photo: Snippet;
    // The editor's tabs (EditorTabs.svelte), if the page has them.
    tabs?: Snippet;
    tool: Snippet;
    footer: Snippet;
  }

  let { title, compact = false, saving, canSave, onSave, onClose, photo, tabs, tool, footer }: Props = $props();
</script>

<svelte:document use:shortcuts={[{ shortcut: { key: 'Escape' }, onShortcut: onClose }]} />

<section
  class="fixed inset-s-0 top-0 z-1 flex size-full flex-col overflow-hidden bg-black md:flex-row"
  use:focusTrap
  aria-label={title ?? $t('editor')}
>
  <div class="relative min-h-0 flex-1 p-4 md:p-8">
    {@render photo()}
  </div>

  <div
    class={[
      'shrink-0 overflow-y-auto bg-light md:h-full md:w-100 dark:border-l dark:border-s-immich-dark-gray',
      compact ? 'max-h-[50%] md:max-h-none' : 'h-[55%]',
    ]}
  >
    <section class="dark relative flex min-h-full flex-col p-2 pt-3 dark:bg-immich-dark-bg dark:text-immich-dark-fg">
      <HStack class="me-4 justify-between">
        <HStack>
          <IconButton
            shape="round"
            variant="ghost"
            color="secondary"
            icon={mdiClose}
            aria-label={$t('close')}
            onclick={onClose}
          />
          <p class="text-lg text-immich-fg capitalize dark:text-immich-dark-fg">{title ?? $t('editor')}</p>
        </HStack>
        <Button shape="round" size="small" onclick={onSave} loading={saving} disabled={!canSave || saving}>
          {$t('editor_save_copy')}
        </Button>
      </HStack>

      {@render tabs?.()}

      <section class={['px-4', compact ? 'mt-2' : 'mt-3']}>
        {@render tool()}
      </section>

      <div class="flex-1"></div>
      <section class={compact ? 'px-4 pt-2' : 'p-4'}>
        {@render footer()}
      </section>
    </section>
  </div>
</section>
