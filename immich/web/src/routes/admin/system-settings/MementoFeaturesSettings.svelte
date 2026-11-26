<!-- SelfPhotos: Memento's own features, switched on or off for everyone. -->
<script lang="ts">
  import { errorMessage, getMementoFlags, updateMementoFlags, type MementoFlags } from '#lib/ai-edit/ai-edit-api.ts';
  import { mementoFlags } from '#lib/ai-edit/flags.svelte.ts';
  import SettingAccordion from '#lib/components/shared-components/settings/SettingAccordion.svelte';
  import SettingInputField from '#lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '#lib/components/shared-components/settings/SettingSwitch.svelte';
  import { SettingInputFieldType } from '#lib/constants.ts';
  import { Button, LoadingSpinner, toastManager } from '@immich/ui';
  import { cloneDeep, isEqual } from 'lodash-es';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  let saved = $state<MementoFlags | null>(null);
  let defaults = $state<MementoFlags | null>(null);
  let edit = $state<MementoFlags | null>(null);
  let loadError = $state('');
  let saving = $state(false);

  const apply = (response: { flags: MementoFlags; defaults: MementoFlags }) => {
    saved = response.flags;
    defaults = response.defaults;
    edit = cloneDeep(response.flags);
    mementoFlags.value = response.flags;
  };

  onMount(async () => {
    try {
      apply(await getMementoFlags());
    } catch (error) {
      loadError = errorMessage(error);
    }
  });

  const showResetToDefault = $derived(!!saved && !!defaults && !isEqual(saved, defaults));

  const handleReset = () => {
    edit = cloneDeep(saved);
    toastManager.info($t('admin.reset_settings_to_recent_saved'));
  };

  const handleResetToDefault = () => {
    edit = cloneDeep(defaults);
    toastManager.info($t('admin.reset_settings_to_default'));
  };

  const handleSave = async () => {
    if (!edit) {
      return;
    }
    saving = true;
    try {
      apply(await updateMementoFlags(edit));
      toastManager.primary($t('settings_saved'));
    } catch (error) {
      toastManager.danger(errorMessage(error));
    } finally {
      saving = false;
    }
  };
</script>

<div class="mt-2">
  <div in:fade={{ duration: 500 }}>
    {#if loadError}
      <p class="text-sm text-red-600 dark:text-red-400">Couldn't load Memento's features: {loadError}</p>
    {:else if !edit || !saved}
      <LoadingSpinner />
    {:else}
      <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
        <div class="flex flex-col gap-4">
          <SettingAccordion
            key="memento-gemini"
            title="Gemini AI Edits"
            subtitle="AI Edit, and every edit made by Google's Gemini. When off, nothing is sent to Google."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Enable Gemini AI edits"
                subtitle="Off hides the AI Edit button on the web and in the app, and the server refuses AI edits. Saved edits stay."
                bind:checked={edit.gemini.enabled}
                isEdited={edit.gemini.enabled !== saved.gemini.enabled}
              />

              <SettingSwitch
                title="Enable AI tools: presets and highlighting"
                subtitle="Preset edits in the photo editor (Unblur, Enhance, Better sky, styles and more; up to 3 in one edit), and brushing over an area to edit just that area; only the brushed area is pasted onto the original. Each costs like any AI edit. Off hides them, and the server refuses highlighted edits. Typed instructions still work while AI edits are on."
                disabled={!edit.gemini.enabled}
                bind:checked={edit.gemini.tools}
                isEdited={edit.gemini.tools !== saved.gemini.tools}
              />

              <hr />

              <SettingSwitch
                title="Allow full quality (4K)"
                subtitle="Edits are 2K, about 4 megapixels (about ₹5.4). With this on, the Full quality switch and edits of a highlighted area use 4K for phone photos (about ₹12). Off: every edit is 2K."
                disabled={!edit.gemini.enabled}
                bind:checked={edit.gemini.allow4k}
                isEdited={edit.gemini.allow4k !== saved.gemini.allow4k}
              />
              <SettingInputField
                inputType={SettingInputFieldType.NUMBER}
                label="AI edits per person per day"
                description="Resets at midnight. Everyone's default; Memento admin can set a different one for a person."
                min={0}
                max={1000}
                bind:value={edit.gemini.dailyLimitPerUser}
                disabled={!edit.gemini.enabled}
                isEdited={edit.gemini.dailyLimitPerUser !== saved.gemini.dailyLimitPerUser}
              />
              <SettingInputField
                inputType={SettingInputFieldType.NUMBER}
                label="AI edits per month, everyone together"
                description="A cap on the monthly Gemini bill. The prepaid Google balance is the hard stop."
                min={0}
                max={10_000}
                bind:value={edit.gemini.monthlyLimitTotal}
                disabled={!edit.gemini.enabled}
                isEdited={edit.gemini.monthlyLimitTotal !== saved.gemini.monthlyLimitTotal}
              />
            </div>
          </SettingAccordion>

          <SettingAccordion
            key="memento-live-albums"
            title="Live Albums"
            subtitle="Albums that fill themselves with photos of chosen people, checked every few minutes."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Enable live albums"
                subtitle="Off hides the Live albums page, stops the checks and refuses changes. Live albums stay, as normal albums with all their photos."
                bind:checked={edit.liveAlbums.enabled}
                isEdited={edit.liveAlbums.enabled !== saved.liveAlbums.enabled}
              />
            </div>
          </SettingAccordion>

          <SettingAccordion
            key="memento-ask-photos"
            title="Ask Photos"
            subtitle="An Ask search type: type a question like “Mom and me at the beach last December” and get the matching photos."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Enable Ask Photos"
                subtitle="Off hides the Ask search type and the server refuses questions. Captions stay. Nothing leaves our servers either way."
                bind:checked={edit.askPhotos.enabled}
                isEdited={edit.askPhotos.enabled !== saved.askPhotos.enabled}
              />
            </div>
          </SettingAccordion>

          <SettingAccordion
            key="memento-captions"
            title="Captions for new photos"
            subtitle="Each night, a small open model on this server describes new photos in one sentence, so Ask can find them by what's in them."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Caption new photos at night"
                subtitle="Runs at night at the lowest priority, so Memento and Ask always go first. Off stops it; existing captions stay. Photos never leave our servers."
                bind:checked={edit.captions.enabled}
                isEdited={edit.captions.enabled !== saved.captions.enabled}
              />
            </div>
          </SettingAccordion>

          <SettingAccordion
            key="memento-memories"
            title="Memories"
            subtitle="Themed memories (Spotlight, Best of last month, trips, big days) and weekly collages and recap videos, for the people who turn them on."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Make themed memories"
                subtitle="Each morning after the night captions, for people who turned them on: Spotlight on a person (at most once a week), Best of last month (on the 1st), trips once they end (needs photos with a location) and big days. They show with Immich's own memories in every app; Memento's apps also show their titles. Off stops new ones; memories already made stay."
                bind:checked={edit.themedMemories.enabled}
                isEdited={edit.themedMemories.enabled !== saved.themedMemories.enabled}
              />

              <hr />

              <SettingSwitch
                title="Make collages and recap videos"
                subtitle="At most one collage and one short video a week per person, from that week's best themed memory, shown together in a memory of their own from Sunday to Tuesday. Made on our server at the lowest priority (never during night captions), and saved into the person's library as normal photos and videos, in albums called Collages and Recaps. Each person can turn them off for themselves, and delete any like a photo. Off stops new ones; existing ones stay."
                bind:checked={edit.creations.enabled}
                isEdited={edit.creations.enabled !== saved.creations.enabled}
              />
            </div>
          </SettingAccordion>

          <SettingAccordion
            key="memento-editing"
            title="Editing"
            subtitle="Adjust in the photo editor: light and colour sliders, filters and straighten, saved as a copy stacked on the original."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Enable Adjust: sliders, filters and straighten"
                subtitle="Light and colour sliders, filters and straighten in the photo editor, saved as a copy stacked on the original. Off hides Adjust on the web and in the app, and the server refuses to save. Saved copies stay. Free: it runs on your own device."
                bind:checked={edit.adjust.enabled}
                isEdited={edit.adjust.enabled !== saved.adjust.enabled}
              />
            </div>
          </SettingAccordion>

          <SettingAccordion
            key="memento-videos"
            title="Videos"
            subtitle="Reduce noise: the sound of your own videos cleaned up on our server, saved as a copy stacked on the original."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Reduce noise for videos"
                subtitle="A Reduce noise button on your own videos: our server cleans up the sound (wind, traffic, hum) with DeepFilterNet, a small open model that works best on speech, and saves a copy stacked on the original. The picture isn't changed. Videos up to 10 minutes and 2 GB, one at a time, not at night while photos are captioned. Free: nothing leaves our server. Off hides the button and the server refuses. Cleaned copies stay."
                bind:checked={edit.reduceNoise.enabled}
                isEdited={edit.reduceNoise.enabled !== saved.reduceNoise.enabled}
              />
            </div>
          </SettingAccordion>

          <SettingAccordion
            key="memento-backup"
            title="Backup"
            subtitle="Storage saver: smaller backups from Memento's Android app, for the people who choose it."
          >
            <div class="ms-4 mt-4 flex flex-col gap-4">
              <SettingSwitch
                title="Enable Storage saver"
                subtitle="Lets each person choose smaller backups from Memento's Android app: Storage saver (videos at 1080p, about 4 Mbps) or Storage saver, high (about 8 Mbps); ordinary photos over 16 MP become 16 MP. HDR videos, and HDR, motion and portrait photos, stay full size. Website uploads always stay full size. Off: backups are full size again from the next upload; copies already made stay as they are."
                bind:checked={edit.storageSaver.enabled}
                isEdited={edit.storageSaver.enabled !== saved.storageSaver.enabled}
              />
            </div>
          </SettingAccordion>

          <div class="mt-8 flex justify-between gap-2">
            <div class="left">
              {#if showResetToDefault}
                <Button variant="ghost" shape="round" size="small" onclick={handleResetToDefault}>
                  {$t('reset_to_default')}
                </Button>
              {/if}
            </div>

            <div class="flex gap-1">
              <Button shape="round" size="small" color="secondary" onclick={handleReset}>{$t('reset')}</Button>
              <Button shape="round" type="submit" disabled={saving} size="small" onclick={handleSave}>
                {$t('save')}
              </Button>
            </div>
          </div>
        </div>
      </form>
    {/if}
  </div>
</div>
