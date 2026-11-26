<!-- SelfPhotos Adjust: light and colour sliders, filters, straighten and markup, saved as a copy -->
<!-- stacked on the original (the same save as AI Edit). -->
<script lang="ts">
  import AdjustFilters from '#lib/ai-edit/adjust/AdjustFilters.svelte';
  import AdjustPerspective from '#lib/ai-edit/adjust/AdjustPerspective.svelte';
  import AdjustPreview from '#lib/ai-edit/adjust/AdjustPreview.svelte';
  import AdjustSliders from '#lib/ai-edit/adjust/AdjustSliders.svelte';
  import AdjustStraighten from '#lib/ai-edit/adjust/AdjustStraighten.svelte';
  import EditorShell from '#lib/ai-edit/adjust/EditorShell.svelte';
  import EditorTabs, { type EditorTab } from '#lib/ai-edit/adjust/EditorTabs.svelte';
  import MarkupLayer from '#lib/ai-edit/adjust/MarkupLayer.svelte';
  import MarkupTools from '#lib/ai-edit/adjust/MarkupTools.svelte';
  import { canAdjustAsset, type AdjustTab } from '#lib/ai-edit/adjust/adjust-action.ts';
  import { AdjustExportError, exportAdjusted, readImage } from '#lib/ai-edit/adjust/adjust-export.ts';
  import { initialState, isUnchanged, perspectiveOf, type AdjustState } from '#lib/ai-edit/adjust/adjust-params.ts';
  import { MarkupEditor } from '#lib/ai-edit/adjust/markup-editor.svelte.ts';
  import { saveCopy } from '#lib/ai-edit/adjust/save-copy.ts';
  import { saveAdjustedCopy } from '#lib/ai-edit/ai-edit-api.ts';
  import { isAdjustEnabled, loadMementoFlags } from '#lib/ai-edit/flags.svelte.ts';
  import { assetViewerManager } from '#lib/managers/asset-viewer-manager.svelte.ts';
  import { Route } from '#lib/route.ts';
  import { getAssetActions } from '#lib/services/asset.service.ts';
  import { getAssetMediaUrl } from '#lib/utils.ts';
  import { handleError } from '#lib/utils/handle-error.ts';
  import { AssetMediaSize } from '@immich/sdk';
  import {
    Alert,
    Button,
    ConfirmModal,
    IconButton,
    LoadingSpinner,
    ProgressBar,
    Text,
    modalManager,
    toastManager,
  } from '@immich/ui';
  import { mdiCompare } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const asset = $derived(data.adjustAsset);
  let tab = $state<AdjustTab>(data.tab);
  let editor = $state<AdjustState>(initialState());
  const markup = new MarkupEditor();
  let preview = $state.raw<ImageBitmap | null>(null);
  let previewFailed = $state(false);
  let unsupported = $state(false);
  let saving = $state(false);
  let progress = $state(0);
  let comparing = $state(false);
  let perspectiveMode = $state(false);
  const placingCorners = $derived(tab === 'straighten' && perspectiveMode);

  const allowed = $derived(canAdjustAsset(asset));
  const cropAvailable = $derived(getAssetActions($t, asset).Edit.$if?.() ?? false);
  const unchanged = $derived(isUnchanged(editor) && markup.isEmpty);
  const busy = $derived(saving || !allowed || unsupported);

  onMount(async () => {
    void loadMementoFlags();
    preview = await readImage(
      getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
    );
    previewFailed = !preview;
  });

  onDestroy(() => preview?.close());

  const confirmLeave = async () =>
    saving
      ? false
      : unchanged ||
        (await modalManager.show(ConfirmModal, {
          title: $t('editor_discard_edits_title'),
          prompt: $t('editor_discard_edits_prompt'),
          confirmText: $t('editor_discard_edits_confirm'),
        }));

  const close = async () => {
    if (await confirmLeave()) {
      await goto(Route.viewAsset({ id: asset.id }));
    }
  };

  const selectTab = async (next: EditorTab) => {
    markup.select(null);
    if (next !== 'crop') {
      tab = next;
      return;
    }
    if (!(await confirmLeave())) {
      return;
    }
    await goto(Route.viewAsset({ id: asset.id }));
    assetViewerManager.openEditor();
  };

  const failureMessage = (error: unknown) => {
    if (error instanceof AdjustExportError) {
      return $t(error.reason === 'unreadable' ? 'error_loading_image' : 'editor_copy_too_large');
    }
    return error instanceof Error ? error.message : String(error);
  };

  const save = async () => {
    if (unchanged || busy) {
      return;
    }
    saving = true;
    progress = 0;
    try {
      const copy = await exportAdjusted(asset, editor, (done, total) => (progress = done / total), markup.items);
      const assetId = await saveCopy(() => saveAdjustedCopy(asset.id, copy.blob));
      toastManager.primary($t('editor_copy_saved'));
      if (copy.fromPreview) {
        toastManager.warning($t('editor_copy_from_preview', { values: copy.size }));
      }
      editor = initialState();
      markup.reset();
      await goto(Route.viewAsset({ id: assetId }));
    } catch (error) {
      handleError(error, $t('editor_copy_failed', { values: { error: failureMessage(error) } }));
    } finally {
      saving = false;
    }
  };
</script>

<EditorShell {saving} canSave={!unchanged && !busy} onSave={save} onClose={close}>
  {#snippet photo()}
    {#if preview}
      <AdjustPreview
        image={preview}
        settings={placingCorners ? { ...editor, angle: 0, perspective: null } : editor}
        original={comparing}
        grid={tab === 'straighten' && !placingCorners}
        alt={asset.originalFileName}
        onUnsupported={() => (unsupported = true)}
      >
        <MarkupLayer editor={markup} active={tab === 'markup' && !busy} hidden={comparing || placingCorners} />
        {#if placingCorners}
          <AdjustPerspective
            corners={editor.perspective ?? null}
            disabled={busy}
            onChange={(corners) => (editor.perspective = perspectiveOf(corners))}
          />
        {/if}
      </AdjustPreview>
      <div class="absolute inset-e-0 bottom-0 me-4 mb-4">
        <IconButton
          shape="round"
          color="secondary"
          variant="ghost"
          class="text-white"
          icon={mdiCompare}
          aria-label={$t('editor_compare')}
          title={$t('editor_compare')}
          disabled={unchanged}
          onpointerdown={() => (comparing = true)}
          onpointerup={() => (comparing = false)}
          onpointerleave={() => (comparing = false)}
        />
      </div>
    {:else if previewFailed}
      <div class="flex size-full items-center justify-center text-white">{$t('error_loading_image')}</div>
    {:else}
      <div class="flex size-full items-center justify-center"><LoadingSpinner /></div>
    {/if}
  {/snippet}

  {#snippet tabs()}
    <EditorTabs active={tab} showCrop={cropAvailable} showAdjust disabled={saving} onSelect={selectTab} />
  {/snippet}

  {#snippet tool()}
    {#if !isAdjustEnabled()}
      <Alert color="warning" class="mb-4">{$t('editor_adjust_off')}</Alert>
    {:else if unsupported}
      <Alert color="warning" class="mb-4">{$t('editor_adjust_unsupported')}</Alert>
    {/if}
    {#if saving}
      <Text size="small" class="mb-2">{$t('editor_copy_saving')}</Text>
      <ProgressBar {progress} class="mb-4" />
    {/if}

    {#if tab === 'adjust'}
      <AdjustSliders bind:adjustments={editor.adjustments} image={preview} disabled={busy} />
    {:else if tab === 'filters' && preview}
      <AdjustFilters image={preview} bind:filter={editor.filter} bind:strength={editor.strength} disabled={busy} />
    {:else if tab === 'straighten'}
      <AdjustStraighten bind:angle={editor.angle} bind:perspective={perspectiveMode} disabled={busy} />
    {:else if tab === 'markup'}
      <MarkupTools editor={markup} disabled={busy} />
    {/if}
  {/snippet}

  {#snippet footer()}
    <Text size="tiny" color="muted" class="mb-3">{$t('editor_copy_note')}</Text>
    <Button
      variant="outline"
      onclick={() => {
        editor = initialState();
        markup.reset();
      }}
      disabled={unchanged || saving}
      class="self-start"
      shape="round"
      size="small"
    >
      {$t('editor_reset_all_changes')}
    </Button>
  {/snippet}
</EditorShell>
