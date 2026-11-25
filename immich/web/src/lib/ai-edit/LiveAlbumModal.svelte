<!--
  SelfPhotos: create or edit a live album (an album that fills itself with photos of chosen
  people). Built from Immich's own pieces: FormModal, Field, Select, Input, DatePicker, and
  Immich's people picker (PeoplePickerModal). Not part of Immich.
-->
<script lang="ts">
  import {
    createLiveAlbum,
    updateLiveAlbum,
    type LiveAlbum,
    type LiveAlbumRules,
  } from '#lib/ai-edit/live-albums-api.ts';
  import ImageThumbnail from '#lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import PeoplePickerModal from '#lib/modals/PeoplePickerModal.svelte';
  import { getPeopleThumbnailUrl } from '#lib/utils.ts';
  import type { AlbumResponseDto, PersonResponseDto } from '@immich/sdk';
  import {
    Alert,
    Button,
    CloseButton,
    DatePicker,
    Field,
    FormModal,
    HelperText,
    Input,
    Label,
    Select,
    Stack,
    Text,
    modalManager,
  } from '@immich/ui';
  import { mdiAccountMultipleCheckOutline, mdiAccountPlusOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    liveAlbum?: LiveAlbum; // editing this one; otherwise a new one
    albums: AlbumResponseDto[]; // your albums that aren't live albums yet
    people: PersonResponseDto[];
    onClose: (saved?: LiveAlbum) => void;
  };

  let { liveAlbum, albums, people, onClose }: Props = $props();

  const NEW_ALBUM = 'new';
  let albumChoice = $state(NEW_ALBUM);
  let albumName = $state('');
  let include = $state<string[]>(liveAlbum?.include ?? []);
  let exclude = $state<string[]>(liveAlbum?.exclude ?? []);
  let match = $state<'any' | 'all'>(liveAlbum?.match ?? 'any');
  let since = $state<string | null>(liveAlbum?.since ?? null);
  let error = $state('');

  const byId = $derived(new Map(people.map((person) => [person.id, person])));
  const canSave = $derived(include.length > 0 && (!!liveAlbum || albumChoice !== NEW_ALBUM || albumName.trim().length > 0));

  const choose = async (target: 'include' | 'exclude') => {
    const picked = await modalManager.show(PeoplePickerModal, { multiple: true, excludedIds: [...include, ...exclude] });
    if (!picked || picked.length === 0) {
      return;
    }
    const ids = picked.map((person) => person.id);
    if (target === 'include') {
      include = [...include, ...ids];
    } else {
      exclude = [...exclude, ...ids];
    }
  };

  const onSubmit = async () => {
    error = '';
    const rules: LiveAlbumRules = { include, exclude, match: include.length > 1 ? match : 'any', since };
    try {
      const saved = liveAlbum
        ? await updateLiveAlbum(liveAlbum.id, rules)
        : await createLiveAlbum(albumChoice === NEW_ALBUM ? { albumName: albumName.trim() } : { albumId: albumChoice }, rules);
      onClose(saved);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  };
</script>

{#snippet chosen(ids: string[], remove: (id: string) => void)}
  {#each ids as id (id)}
    {@const person = byId.get(id)}
    <span class="flex items-center gap-2 rounded-full bg-subtle py-1 ps-1 pe-1 text-sm">
      {#if person}
        <ImageThumbnail circle url={getPeopleThumbnailUrl(person)} altText={person.name} widthStyle="28px" heightStyle="28px" />
      {/if}
      <span>{person?.name || 'Unnamed person'}</span>
      <CloseButton size="tiny" onclick={() => remove(id)} />
    </span>
  {/each}
{/snippet}

<FormModal
  title={liveAlbum ? 'Edit live album' : 'New live album'}
  icon={mdiAccountMultipleCheckOutline}
  size="medium"
  submitText={liveAlbum ? $t('save') : $t('create')}
  disabled={!canSave}
  {onClose}
  {onSubmit}
>
  <Stack gap={6}>
    {#if liveAlbum}
      <Field label={$t('album')}>
        <Text>{liveAlbum.albumName}</Text>
      </Field>
    {:else}
      <Field label={$t('album')}>
        <Select
          value={albumChoice}
          options={[
            { label: 'A new album', value: NEW_ALBUM },
            ...albums.map((album) => ({ label: album.albumName || $t('create_album_page_untitled'), value: album.id })),
          ]}
          onChange={(value) => (albumChoice = value)}
        />
      </Field>
      {#if albumChoice === NEW_ALBUM}
        <Field label={$t('album_name')}>
          <Input bind:value={albumName} />
        </Field>
      {/if}
    {/if}

    <!-- Immich's Field only shows its label through an input inside it, so the button-only
         fields carry their own Label (the same component and size the inputs use). -->
    <div>
      <Label label={$t('people')} size="small" />
      <div class="flex flex-wrap items-center gap-2 pt-1">
        {@render chosen(include, (id) => (include = include.filter((x) => x !== id)))}
        <Button size="small" variant="ghost" color="secondary" leadingIcon={mdiAccountPlusOutline} onclick={() => choose('include')}>
          {include.length === 0 ? 'Choose people' : 'Add people'}
        </Button>
      </div>
      <Text size="small" color="muted" class="pt-1">
        Their photos are added to the album automatically, within a few minutes of upload.
      </Text>
    </div>

    {#if include.length > 1}
      <Field label="Which photos">
        <Select
          value={match}
          options={[
            { label: 'Photos with any of them', value: 'any' },
            { label: 'Only photos with all of them together', value: 'all' },
          ]}
          onChange={(value) => (match = value === 'all' ? 'all' : 'any')}
        />
      </Field>
    {/if}

    <div>
      <Label label="Leave out photos with" size="small" />
      <div class="flex flex-wrap items-center gap-2 pt-1">
        {@render chosen(exclude, (id) => (exclude = exclude.filter((x) => x !== id)))}
        <Button size="small" variant="ghost" color="secondary" leadingIcon={mdiAccountPlusOutline} onclick={() => choose('exclude')}>
          Choose people
        </Button>
      </div>
      <Text size="small" color="muted" class="pt-1">
        Optional. Photos that include any of these people are never added, even if they also have the people above.
      </Text>
    </div>

    <Field label="Only photos taken from">
      <DatePicker
        bind:value={() => (since ? DateTime.fromISO(since) : undefined), (value) => (since = value?.toISODate() ?? null)}
        maxDate={DateTime.now()}
      />
      <HelperText>Optional. Leave empty to include every photo.</HelperText>
    </Field>

    <Text size="small" color="muted">
      Live albums only add photos. A photo you remove from the album stays removed, and nothing is deleted when you
      stop a live album.
    </Text>

    {#if error}
      <Alert color="danger" title={error} />
    {/if}
  </Stack>
</FormModal>
