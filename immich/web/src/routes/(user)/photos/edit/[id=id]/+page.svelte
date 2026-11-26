<!-- SelfPhotos AI edits: AI Edit, opened only by its button. -->
<script lang="ts">
  import EditorShell from '#lib/ai-edit/adjust/EditorShell.svelte';
  import { readImage } from '#lib/ai-edit/adjust/adjust-export.ts';
  import { saveCopy } from '#lib/ai-edit/adjust/save-copy.ts';
  import { AI_EDIT_TITLE, canAiEditAsset } from '#lib/ai-edit/ai-edit-action.ts';
  import {
    AiEditError,
    createAiEdit,
    discardAiEdit,
    editsLeft,
    getAiEditImage,
    getAiEditUsage,
    reportAlignment,
    saveAiEdit,
    saveAiEditArea,
    type AiEditUsage,
  } from '#lib/ai-edit/ai-edit-api.ts';
  import AiPhoto from '#lib/ai-edit/ai/AiPhoto.svelte';
  import AiTools from '#lib/ai-edit/ai/AiTools.svelte';
  import type { Alignment } from '#lib/ai-edit/ai/ai-align.ts';
  import {
    ShapeChangedError,
    alignFor,
    markedCopy,
    pasteBack,
    pasteOnto,
    refusalOf,
    uprightPhoto,
    type Stroke,
  } from '#lib/ai-edit/ai/ai-area.ts';
  import { failureMessage, tooLargeMessage } from '#lib/ai-edit/ai/ai-failure.ts';
  import {
    MAX_ASK_WORDS,
    MAX_WORDS,
    canGenerate,
    changesWholePhoto,
    combinedInstruction,
    combinedLabel,
    toggleTool,
    tooLargeForAi,
    toolLabelKey,
    type AiTool,
  } from '#lib/ai-edit/ai/ai-tools.ts';
  import { isAiToolsEnabled, isGeminiEnabled, loadMementoFlags } from '#lib/ai-edit/flags.svelte.ts';
  import { Route } from '#lib/route.ts';
  import { getAssetMediaUrl } from '#lib/utils.ts';
  import { AssetMediaSize } from '@immich/sdk';
  import {
    Alert,
    Button,
    ConfirmModal,
    HStack,
    LoadingSpinner,
    Text,
    Textarea,
    modalManager,
    toastManager,
  } from '@immich/ui';
  import { mdiClose, mdiCreationOutline, mdiDeleteOutline, mdiPencilPlusOutline } from '@mdi/js';
  import { onDestroy, onMount, tick } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  type Run = {
    tools: AiTool[];
    prompt: string;
    label: string;
    highlight: Stroke[];
    from: Result | null;
  };

  type Result = {
    editId: string;
    label: string;
    image: ImageBitmap;
    url: string;
    marked: boolean;
    area: { strokes: Stroke[]; alignment: Alignment } | null;
    shown: { url: string; image: ImageBitmap };
  };

  type Refused = { result: Result; reason: 'shape' | 'failed'; run: Run | null };

  const refusedNote = ({ reason, run }: Refused) =>
    run === null
      ? 'editor_ai_save_paste_failed'
      : reason === 'shape'
        ? 'editor_ai_shape_note'
        : 'editor_ai_paste_failed';

  type Unloaded = { editId: string; run: Run; again: boolean };

  const asset = $derived(data.editAsset);
  const previewUrl = $derived(
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
  );
  let preview = $state.raw<ImageBitmap | null>(null);
  let previewFailed = $state(false);
  let strokes = $state.raw<Stroke[]>([]);
  let brushRadius = $state(0.04);
  let highlightOpen = $state(false);
  let words = $state('');
  let selected = $state.raw<AiTool[]>([]);
  let result = $state.raw<Result | null>(null);
  let refining = $state(false);
  let phase = $state<'idle' | 'working' | 'saving'>('idle');
  let usage = $state<AiEditUsage | null>(null);
  let error = $state<string | null>(null);
  let refused = $state.raw<Refused | null>(null);
  let unloaded = $state.raw<Unloaded | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);

  const allowed = $derived(canAiEditAsset(asset));
  const tooLarge = $derived(tooLargeForAi(asset));
  const tools = $derived(isAiToolsEnabled());
  const asking = $derived(selected.find(({ ask }) => ask) ?? null);
  const wholePhoto = $derived(changesWholePhoto(selected));
  const wordLimit = $derived(asking ? MAX_ASK_WORDS : MAX_WORDS);
  const composing = $derived(
    allowed &&
      !tooLarge &&
      !!preview &&
      phase === 'idle' &&
      refused === null &&
      unloaded === null &&
      (result === null || refining),
  );
  const highlighted = $derived(tools && strokes.length > 0);
  const ready = $derived(composing && canGenerate(selected, words, highlighted));

  onMount(async () => {
    void loadMementoFlags();
    void getAiEditUsage()
      .then((answer) => (usage = answer))
      .catch(() => {});
    preview = await readImage(previewUrl);
    previewFailed = !preview;
    if (previewFailed) {
      console.error('AI Edit: loading the photo’s preview failed');
    }
  });

  const freePaste = ({ image, shown }: Result) => {
    if (shown.image !== image) {
      shown.image.close();
      URL.revokeObjectURL(shown.url);
    }
  };

  const release = (old: Result) => {
    freePaste(old);
    old.image.close();
    URL.revokeObjectURL(old.url);
  };

  const asWhole = (kept: Result): Result => {
    freePaste(kept);
    return { ...kept, marked: true, area: null, shown: { url: kept.url, image: kept.image } };
  };

  const discardOnServer = (editId: string) => {
    void discardAiEdit(editId).catch(() => {});
  };

  const dropRefused = () => {
    if (refused) {
      release(refused.result);
      discardOnServer(refused.result.editId);
      refused = null;
    }
  };

  let left = false;

  const discardIfLeft = (editId: string, made?: Result) => {
    if (left) {
      if (made) {
        release(made);
      }
      discardOnServer(editId);
    }
    return left;
  };

  onDestroy(() => {
    left = true;
    preview?.close();
    dropRefused();
    if (unloaded) {
      discardOnServer(unloaded.editId);
    }
    if (result) {
      if (phase !== 'saving') {
        discardOnServer(result.editId);
      }
      release(result);
    }
  });

  const confirmLeave = async () =>
    phase === 'saving'
      ? false
      : (phase !== 'working' && result === null && refused === null && unloaded === null && strokes.length === 0) ||
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

  const install = (made: Result) => {
    const previous = result;
    result = made;
    strokes = [];
    words = '';
    selected = [];
    refining = false;
    if (previous) {
      release(previous);
      discardOnServer(previous.editId);
    }
  };

  async function run(spec: Run) {
    if (!preview || phase !== 'idle') {
      return;
    }
    error = null;
    dropRefused();
    phase = 'working';
    try {
      let mark: Blob | undefined;
      let photo: Blob | undefined;
      if (spec.highlight.length > 0 && spec.from) {
        mark = await markedCopy(spec.from.shown.image, spec.highlight);
      } else if (spec.highlight.length > 0) {
        const upright = await uprightPhoto(asset);
        try {
          mark = await markedCopy(upright.image, spec.highlight);
        } finally {
          upright.image.close();
        }
        photo = upright.blob;
      }
      if (left) {
        return;
      }
      const created = await createAiEdit(asset.id, spec.prompt, {
        fromEditId: spec.from?.editId,
        tools: spec.tools.map(({ id }) => id),
        mark,
        photo,
      });
      usage = created.usage;
      await show(created.editId, spec, preview);
    } catch (error_) {
      console.error('AI Edit: making the edit failed', error_);
      if (error_ instanceof AiEditError && error_.usage) {
        usage = error_.usage;
      }
      error = failureMessage(error_, $t);
    } finally {
      phase = 'idle';
    }
  }

  async function show(editId: string, spec: Run, base: ImageBitmap, again = false) {
    if (discardIfLeft(editId)) {
      return;
    }
    let image: ImageBitmap;
    let url: string;
    try {
      const blob = await getAiEditImage(editId);
      image = await createImageBitmap(blob);
      url = URL.createObjectURL(blob);
    } catch (error_) {
      console.error('AI Edit: loading the edit’s picture failed', error_);
      if (!discardIfLeft(editId)) {
        unloaded = { editId, run: spec, again };
      }
      return;
    }
    const whole: Result = {
      editId,
      label: spec.label,
      image,
      url,
      marked: spec.highlight.length > 0,
      area: null,
      shown: { url, image },
    };
    if (discardIfLeft(editId, whole)) {
      return;
    }
    const pasted =
      spec.highlight.length > 0 && spec.tools.every(({ pasteBack }) => pasteBack) && spec.from?.area !== null;
    if (!pasted) {
      install(whole);
      return;
    }
    const pasting = [...(spec.from?.area?.strokes ?? []), ...spec.highlight];
    let made: Result;
    try {
      const alignment = await alignFor(base, image, pasting);
      void reportAlignment(editId, { ...alignment, refused: false });
      const paste = await pasteOnto(base, image, pasting, 'image/jpeg', alignment);
      const shown = await createImageBitmap(paste.blob);
      made = {
        ...whole,
        area: { strokes: pasting, alignment },
        shown: { url: URL.createObjectURL(paste.blob), image: shown },
      };
    } catch (error_) {
      console.error('AI Edit: pasting the highlighted area failed', error_);
      if (error_ instanceof ShapeChangedError && error_.alignment) {
        void reportAlignment(editId, { ...error_.alignment, refused: true });
      }
      if (!discardIfLeft(editId, whole)) {
        refused = { result: whole, reason: refusalOf(error_), run: spec };
      }
      return;
    }
    if (!discardIfLeft(editId, made)) {
      install(made);
    }
  }

  const loadAgain = async () => {
    const kept = unloaded;
    if (!kept || !preview || phase !== 'idle') {
      return;
    }
    unloaded = null;
    error = null;
    phase = 'working';
    try {
      await show(kept.editId, kept.run, preview, true);
    } finally {
      phase = 'idle';
    }
  };

  const discardUnloaded = () => {
    const kept = unloaded;
    if (!kept || phase !== 'idle') {
      return;
    }
    unloaded = null;
    error = null;
    discardOnServer(kept.editId);
  };

  const useWhole = () => {
    const kept = refused;
    if (!kept || phase !== 'idle') {
      return;
    }
    refused = null;
    install(asWhole(kept.result));
  };

  const tryAgain = () => {
    const kept = refused;
    if (!kept || phase !== 'idle') {
      return;
    }
    if (kept.run) {
      const again = kept.run;
      dropRefused();
      void run(again);
      return;
    }
    refused = null;
    result = kept.result;
    void save();
  };

  const toggle = async (tool: AiTool) => {
    selected = toggleTool(selected, tool);
    if (asking?.id === tool.id) {
      await tick();
      textarea?.focus();
    }
  };

  const generate = async () => {
    if (!ready) {
      return;
    }
    await run({
      tools: selected,
      prompt: combinedInstruction(selected, words),
      label: combinedLabel(selected, words, (tool) => $t(toolLabelKey(tool) as Translations)),
      highlight: tools && !wholePhoto ? strokes : [],
      from: refining ? result : null,
    });
  };

  async function save() {
    const current = result;
    if (!current || phase !== 'idle') {
      return;
    }
    error = null;
    phase = 'saving';
    let copy: Blob | undefined;
    if (current.area) {
      try {
        copy = await pasteBack(asset, current.image, current.area.strokes, current.area.alignment);
      } catch (error_) {
        console.error('AI Edit: pasting the highlighted area at full size failed', error_);
        if (discardIfLeft(current.editId)) {
          return;
        }
        if (result === current && !refused && !unloaded) {
          result = null;
          refused = { result: current, reason: 'failed', run: null };
        } else {
          error = failureMessage(error_, $t);
        }
        phase = 'idle';
        return;
      }
    }
    try {
      const assetId = await saveCopy(() =>
        copy ? saveAiEditArea(current.editId, copy) : saveAiEdit(current.editId, current.marked),
      );
      result = null;
      release(current);
      toastManager.primary($t('editor_copy_saved'));
      await goto(Route.viewAsset({ id: assetId }));
    } catch (error_) {
      console.error('AI Edit: saving the edit failed', error_);
      if (discardIfLeft(current.editId)) {
        return;
      }
      error = failureMessage(error_, $t);
      phase = 'idle';
    }
  }

  const discard = () => {
    const current = result;
    if (!current) {
      return;
    }
    result = null;
    refining = false;
    error = null;
    release(current);
    discardOnServer(current.editId);
  };

  const editMore = () => {
    refining = true;
    error = null;
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (words.trim() !== '') {
        void generate();
      }
    }
  };
</script>

<EditorShell
  title={AI_EDIT_TITLE}
  compact
  saving={phase === 'saving'}
  canSave={!!result && phase === 'idle'}
  onSave={save}
  onClose={close}
>
  {#snippet photo()}
    {#if preview}
      <AiPhoto
        src={refused?.result.url ?? result?.shown.url ?? previewUrl}
        original={result || refused ? previewUrl : undefined}
        width={(refused?.result.image ?? result?.shown.image ?? preview).width}
        height={(refused?.result.image ?? result?.shown.image ?? preview).height}
        bind:strokes
        {brushRadius}
        brushing={composing && tools && !wholePhoto}
        working={phase === 'working'}
        alt={asset.originalFileName}
      />
    {:else if previewFailed}
      <div class="flex size-full items-center justify-center text-white">{$t('error_loading_image')}</div>
    {:else}
      <div class="flex size-full items-center justify-center"><LoadingSpinner /></div>
    {/if}
  {/snippet}

  {#snippet tool()}
    {#if !isGeminiEnabled()}
      <Alert color="warning" class="mb-4">{$t('editor_ai_off')}</Alert>
    {/if}
    {#if error}
      <Alert color="danger" class="mb-4" closable onClose={() => (error = null)}>
        {$t('editor_ai_failed', { values: { error } })}
      </Alert>
    {/if}
    {#if refused}
      {const kept = $derived(refused)}
      <Alert color="warning" class="mb-4">
        <p>{$t(refusedNote(kept))}</p>
        <HStack gap={2} class="mt-2 flex-wrap">
          <Button size="small" shape="round" disabled={phase !== 'idle'} onclick={useWhole}>
            {$t('editor_ai_use_whole')}
          </Button>
          <Button size="small" shape="round" variant="outline" disabled={phase !== 'idle'} onclick={tryAgain}>
            {$t('editor_ai_try_again')}
          </Button>
        </HStack>
      </Alert>
    {/if}
    {#if unloaded}
      <Alert color="warning" class="mb-4">
        <p>{$t(unloaded.again ? 'editor_ai_load_failed_again' : 'editor_ai_load_failed')}</p>
        <HStack gap={2} class="mt-2 flex-wrap">
          <Button size="small" shape="round" disabled={phase !== 'idle'} onclick={loadAgain}>
            {$t('editor_ai_load_again')}
          </Button>
          <Button size="small" shape="round" variant="outline" disabled={phase !== 'idle'} onclick={discardUnloaded}>
            {$t('editor_ai_discard')}
          </Button>
        </HStack>
      </Alert>
    {/if}
    {#if phase === 'saving'}
      <Text size="small" class="mb-4">{$t('editor_copy_saving')}</Text>
    {/if}

    {#if result && !refining}
      <Text size="small" class="mb-1">“{result.label}”</Text>
      <Text size="tiny" color="muted" class="mb-4">
        {$t(result.area ? 'editor_ai_area_note' : 'editor_ai_whole_note')}
      </Text>
      <HStack gap={2}>
        <Button
          size="small"
          shape="round"
          variant="outline"
          color="secondary"
          leadingIcon={mdiDeleteOutline}
          disabled={phase !== 'idle'}
          onclick={discard}
        >
          {$t('editor_ai_discard')}
        </Button>
        <Button
          size="small"
          shape="round"
          variant="outline"
          leadingIcon={mdiPencilPlusOutline}
          disabled={phase !== 'idle'}
          onclick={editMore}
        >
          {$t('editor_ai_edit_more')}
        </Button>
      </HStack>
    {:else if allowed && !tooLarge}
      {#if refining}
        <Text size="tiny" color="muted" class="mb-2">{$t('editor_ai_edit_more_note')}</Text>
      {/if}
      {#if tools}
        <AiTools
          disabled={!composing}
          hasHighlight={highlighted}
          {selected}
          {wholePhoto}
          bind:brushRadius
          bind:open={highlightOpen}
          onToggle={toggle}
          onUndo={() => (strokes = strokes.slice(0, -1))}
          onClear={() => (strokes = [])}
        />
      {/if}

      <form
        class="mt-2 flex flex-col gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        {#if asking}
          <HStack class="justify-between">
            <Text size="small">{$t(toolLabelKey(asking) as Translations)}</Text>
            <Button
              size="tiny"
              shape="round"
              variant="ghost"
              color="secondary"
              leadingIcon={mdiClose}
              onclick={() => (selected = selected.filter(({ ask }) => !ask))}
            >
              {$t('cancel')}
            </Button>
          </HStack>
        {/if}
        <Textarea
          bind:value={words}
          bind:ref={textarea}
          rows={3}
          class="block py-2"
          maxlength={wordLimit}
          disabled={!composing}
          placeholder={asking
            ? $t(`${toolLabelKey(asking)}_ask` as Translations)
            : $t(tools ? 'editor_ai_describe_or_brush' : 'editor_ai_describe')}
          onkeydown={onKeydown}
        />
        <HStack class="justify-between">
          <div class="flex min-w-0 flex-wrap gap-x-1">
            <Text size="tiny" color="muted">{words.length}/{wordLimit}</Text>
            {#if usage}
              <Text size="tiny" color="muted" aria-hidden="true">·</Text>
              {@render editsLeftToday(usage)}
            {/if}
          </div>
          <Button
            type="submit"
            size="small"
            shape="round"
            leadingIcon={mdiCreationOutline}
            loading={phase === 'working'}
            disabled={!ready}
          >
            {$t(refining ? 'editor_ai_edit_result' : 'editor_ai_generate')}
          </Button>
        </HStack>
      </form>
    {:else}
      <Alert color="warning">{allowed ? tooLargeMessage($t) : $t('editor_ai_cant_edit')}</Alert>
    {/if}
  {/snippet}

  {#snippet footer()}
    {#if allowed && usage && result && !refining}
      {@render editsLeftToday(usage)}
    {/if}
  {/snippet}
</EditorShell>

{#snippet editsLeftToday(usage: AiEditUsage)}
  <Text size="tiny" color="muted">{$t('editor_ai_left_today', { values: { count: editsLeft(usage) } })}</Text>
{/snippet}
