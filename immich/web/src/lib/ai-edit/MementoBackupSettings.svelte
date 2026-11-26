<!-- SelfPhotos backup quality (Storage saver) for backups from Memento's phone app. -->
<script lang="ts">
  import { errorMessage } from '#lib/ai-edit/ai-edit-api.ts';
  import {
    getBackupSettings,
    updateBackupSettings,
    type BackupQuality,
    type BackupSettings,
  } from '#lib/ai-edit/backup-api.ts';
  import { isStorageSaverEnabled, loadMementoFlags, mementoFlags } from '#lib/ai-edit/flags.svelte.ts';
  import SettingAccordion from '#lib/components/shared-components/settings/SettingAccordion.svelte';
  import { Button, Field, LoadingSpinner, Select, Text, toastManager } from '@immich/ui';
  import { mdiCloudUploadOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let saved = $state<BackupQuality>();
  let quality = $state<BackupQuality>('original');
  let loadError = $state('');
  let saving = $state(false);

  const apply = (settings: BackupSettings) => {
    saved = settings.quality;
    quality = settings.quality;
  };

  onMount(async () => {
    await loadMementoFlags();
    if (mementoFlags.value === null) {
      return;
    }
    try {
      apply(await getBackupSettings());
    } catch (error) {
      loadError = errorMessage(error);
    }
  });

  const descriptions = $derived<Record<BackupQuality, string>>({
    original: $t('backup_quality_original_description'),
    saverHigh: $t('backup_quality_saver_high_description'),
    saver: $t('backup_quality_saver_description'),
  });

  const handleSave = async () => {
    saving = true;
    try {
      apply(await updateBackupSettings({ quality }));
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      toastManager.danger(errorMessage(error));
    } finally {
      saving = false;
    }
  };
</script>

{#if isStorageSaverEnabled()}
  <SettingAccordion
    icon={mdiCloudUploadOutline}
    key="memento-backup"
    title={$t('backup_quality')}
    subtitle={$t('backup_quality_description')}
  >
    <section class="my-4">
      {#if loadError}
        <Text color="danger" size="small">{loadError}</Text>
      {:else if !saved}
        <LoadingSpinner />
      {:else}
        <div class="flex flex-col gap-4 sm:ms-4 md:ms-8">
          <Field label={$t('backup_quality')} description={descriptions[quality]}>
            <Select
              options={[
                { label: $t('backup_quality_original'), value: 'original' },
                { label: $t('backup_quality_saver_high'), value: 'saverHigh' },
                { label: $t('backup_quality_saver'), value: 'saver' },
              ]}
              bind:value={quality}
            />
          </Field>
          <Text color="muted" size="small">{$t('backup_quality_note')}</Text>
          <div class="flex justify-end">
            <Button shape="round" size="small" loading={saving} disabled={quality === saved} onclick={handleSave}>
              {$t('save')}
            </Button>
          </div>
        </div>
      {/if}
    </section>
  </SettingAccordion>
{/if}
