<!-- SelfPhotos editor: Adjust's tabs inside Immich's own editor (EditorPanel.svelte), after its -->
<!-- crop tool. -->
<script lang="ts">
  import EditorTabs, { type EditorTab } from '#lib/ai-edit/adjust/EditorTabs.svelte';
  import { adjustPath, canAdjustAsset } from '#lib/ai-edit/adjust/adjust-action.ts';
  import { loadMementoFlags } from '#lib/ai-edit/flags.svelte.ts';
  import { editManager } from '#lib/managers/edit/edit-manager.svelte.ts';
  import type { AssetResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  onMount(() => void loadMementoFlags());

  const showAdjust = $derived(canAdjustAsset(asset));

  const open = async (tab: EditorTab) => {
    if (tab !== 'crop' && (await editManager.closeConfirm())) {
      await goto(adjustPath(asset.id, tab));
    }
  };
</script>

{#if showAdjust}
  <EditorTabs active="crop" showCrop {showAdjust} onSelect={open} />
{/if}
