<!--
  SelfPhotos themed memories: the person's own switches, a section of Account settings (one
  line in Immich's UserSettingsList.svelte). Built like Immich's own Features section: Field
  and Switch, saved with Save. Not part of Immich.

  Shown while an admin has themed memories switched on, or while this person's are on: with
  them switched off for everyone, the person can still turn theirs off (and their key goes),
  but not on. The collages switch shows while collages are switched on.
-->
<script lang="ts">
  import { errorMessage } from '#lib/ai-edit/ai-edit-api.ts';
  import {
    isCreationsEnabled,
    isThemedMemoriesEnabled,
    loadMementoFlags,
    mementoFlags,
  } from '#lib/ai-edit/flags.svelte.ts';
  import { getMemorySettings, updateMemorySettings, type MemorySettings } from '#lib/ai-edit/memories-api.ts';
  import SettingAccordion from '#lib/components/shared-components/settings/SettingAccordion.svelte';
  import { Button, Field, LoadingSpinner, Switch, Text, toastManager } from '@immich/ui';
  import { mdiCardsOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let saved = $state<MemorySettings>();
  let enabled = $state(false);
  let creations = $state(true);
  let loadError = $state('');
  let saving = $state(false);

  const apply = (settings: MemorySettings) => {
    saved = settings;
    enabled = settings.enabled;
    creations = settings.creations;
  };

  onMount(async () => {
    await loadMementoFlags();
    if (mementoFlags.value === null) {
      return; // the service can't be reached: nothing to show
    }
    try {
      apply(await getMemorySettings());
    } catch (error) {
      loadError = errorMessage(error);
    }
  });

  const adminOn = $derived(isThemedMemoriesEnabled());
  const shown = $derived(adminOn || saved?.enabled === true);
  // Paused (e.g. their key was deleted in Immich): saving with them on makes a new key.
  const fixesPause = $derived(adminOn && enabled && !!saved?.pausedReason);
  const changed = $derived(!!saved && (enabled !== saved.enabled || creations !== saved.creations || fixesPause));

  const handleSave = async () => {
    if (!saved) {
      return;
    }
    saving = true;
    try {
      // Only what changed: turning memories on makes a key, so it isn't sent again needlessly.
      apply(
        await updateMemorySettings({
          ...((enabled !== saved.enabled || fixesPause) && { enabled }),
          ...(creations !== saved.creations && { creations }),
        }),
      );
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      toastManager.danger(errorMessage(error));
    } finally {
      saving = false;
    }
  };
</script>

{#if shown || (adminOn && (loadError || !saved))}
  <SettingAccordion
    icon={mdiCardsOutline}
    key="memento-memories"
    title={$t('themed_memories')}
    subtitle={$t('themed_memories_description')}
  >
    <section class="my-4">
      {#if loadError}
        <Text color="danger" size="small">{loadError}</Text>
      {:else if !saved}
        <LoadingSpinner />
      {:else}
        <div class="flex flex-col gap-4 sm:ms-4 md:ms-8">
          <Field label={$t('themed_memories')} description={$t('themed_memories_enable_description')}>
            <!-- Switched off for everyone: theirs can only be turned off. -->
            <Switch bind:checked={enabled} disabled={!adminOn && !enabled} />
          </Field>
          {#if !adminOn}
            <Text color="muted" size="small">{$t('themed_memories_paused_by_admin')}</Text>
          {:else if saved.pausedReason}
            <Text color="warning" size="small">{saved.pausedReason}</Text>
          {/if}
          {#if adminOn && isCreationsEnabled()}
            <Field label={$t('themed_memories_creations')} description={$t('themed_memories_creations_description')}>
              <Switch bind:checked={creations} />
            </Field>
          {/if}
          <div class="flex justify-end">
            <Button shape="round" size="small" loading={saving} disabled={!changed} onclick={handleSave}>
              {$t('save')}
            </Button>
          </div>
        </div>
      {/if}
    </section>
  </SettingAccordion>
{/if}
