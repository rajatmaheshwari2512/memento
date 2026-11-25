<!--
  SelfPhotos: Live albums. Each one is an album that fills itself with photos of chosen
  people; Memento's extras service checks every few minutes (memento-extras). Built from
  Immich's own page layout and components so it looks like the Albums page.
-->
<script lang="ts">
  import { isLiveAlbumsEnabled, loadMementoFlags } from '#lib/ai-edit/flags.svelte.ts';
  import LiveAlbumModal from '#lib/ai-edit/LiveAlbumModal.svelte';
  import { checkLiveAlbum, deleteLiveAlbum, listLiveAlbums, type LiveAlbum } from '#lib/ai-edit/live-albums-api.ts';
  import ImageThumbnail from '#lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '#lib/components/shared-components/EmptyPlaceholder.svelte';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { getPeopleThumbnailUrl } from '#lib/utils.ts';
  import { handleError } from '#lib/utils/handle-error.ts';
  import {
    AlbumUserRole,
    getAllAlbums,
    getAllPeople,
    type AlbumResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import {
    Alert,
    Button,
    Card,
    CardBody,
    HStack,
    IconButton,
    LoadingSpinner,
    Stack,
    Text,
    modalManager,
    toastManager,
  } from '@immich/ui';
  import { mdiDeleteOutline, mdiPencilOutline, mdiPlusBoxOutline, mdiRefresh } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  let { data }: Props = $props();

  let liveAlbums = $state<LiveAlbum[] | null>(null);
  let people = $state<PersonResponseDto[]>([]);
  let albums = $state<AlbumResponseDto[]>([]);
  let loadError = $state('');
  let checking = $state<string | null>(null);
  let refresh: ReturnType<typeof setInterval> | undefined;

  const byId = $derived(new Map(people.map((person) => [person.id, person])));
  const enabled = $derived(isLiveAlbumsEnabled());
  // Your own albums that aren't live albums yet: the ones a new live album can use.
  const freeAlbums = $derived(
    albums.filter(
      (album) =>
        album.albumUsers.some(({ role, user }) => role === AlbumUserRole.Owner && user.id === authManager.user.id) &&
        !liveAlbums?.some((live) => live.albumId === album.id),
    ),
  );

  const reload = async () => {
    try {
      liveAlbums = await listLiveAlbums();
      loadError = '';
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  };

  onMount(async () => {
    void loadMementoFlags();
    const [peopleResult, albumsResult] = await Promise.allSettled([getAllPeople({ withHidden: false }), getAllAlbums({})]);
    if (peopleResult.status === 'fulfilled') {
      people = peopleResult.value.people;
    }
    if (albumsResult.status === 'fulfilled') {
      albums = albumsResult.value;
    }
    await reload();
    // Saving fills the album in the background; keep the counts fresh while the page is open.
    refresh = setInterval(() => void reload(), 15_000);
  });

  onDestroy(() => clearInterval(refresh));

  const names = (ids: string[]) => ids.map((id) => byId.get(id)?.name || 'Unnamed person').join(', ');

  const describe = (live: LiveAlbum) => {
    const who = live.include.length > 1 ? `${live.match === 'all' ? 'All of' : 'Any of'} ${names(live.include)}` : names(live.include);
    const parts = [who];
    if (live.match === 'all' && live.include.length > 1) {
      parts[0] += ', together';
    }
    if (live.exclude.length > 0) {
      parts.push(`not with ${names(live.exclude)}`);
    }
    if (live.since) {
      parts.push(`from ${DateTime.fromISO(live.since).toLocaleString(DateTime.DATE_MED)}`);
    }
    return parts.join(' · ');
  };

  const status = (live: LiveAlbum) => {
    const added = `${live.totalAdded} ${live.totalAdded === 1 ? 'photo' : 'photos'} added`;
    if (!live.lastRunAt) {
      return 'Filling now…';
    }
    return `${added} · checked ${DateTime.fromISO(live.lastRunAt).toRelative()}`;
  };

  const openEditor = async (liveAlbum?: LiveAlbum) => {
    const saved = await modalManager.show(LiveAlbumModal, { liveAlbum, albums: freeAlbums, people });
    if (saved) {
      toastManager.primary(liveAlbum ? 'Live album saved' : `${saved.albumName} is now a live album`);
      await reload();
    }
  };

  const checkNow = async (live: LiveAlbum) => {
    checking = live.id;
    try {
      const result = await checkLiveAlbum(live.id);
      toastManager.primary(result.added > 0 ? `Added ${result.added} new ${result.added === 1 ? 'photo' : 'photos'}` : 'No new photos');
      await reload();
    } catch (error) {
      handleError(error, "Couldn't check this live album");
    } finally {
      checking = null;
    }
  };

  const stop = async (live: LiveAlbum) => {
    const confirmed = await modalManager.showDialog({
      title: 'Stop this live album?',
      prompt: `${live.albumName} stays, with all its photos. It just stops adding new ones.`,
      confirmText: 'Stop',
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteLiveAlbum(live.id);
      toastManager.primary(`${live.albumName} is a normal album again`);
      await reload();
    } catch (error) {
      handleError(error, "Couldn't stop this live album");
    }
  };
</script>

<UserPageLayout title={data.meta.title}>
  {#snippet buttons()}
    {#if enabled}
      <Button leadingIcon={mdiPlusBoxOutline} onclick={() => openEditor()} size="small" variant="ghost" color="secondary">
        <p class="hidden md:block">New live album</p>
      </Button>
    {/if}
  {/snippet}

  <Stack gap={4} class="mx-auto max-w-4xl py-4">
    {#if !enabled}
      <Alert color="warning" title="Live albums are switched off">
        An admin can turn them on in Administration → Settings → Memento Features. Your albums and their photos stay as
        they are.
      </Alert>
    {/if}

    {#if loadError}
      <Alert color="danger" title="Couldn't load your live albums">{loadError}</Alert>
    {:else if liveAlbums === null}
      <div class="flex justify-center p-8"><LoadingSpinner /></div>
    {:else if liveAlbums.length === 0}
      <EmptyPlaceholder
        text="No live albums yet. A live album adds photos of the people you choose, automatically."
        onClick={enabled ? () => openEditor() : undefined}
        class="mx-auto mt-10"
      />
    {:else}
      {#each liveAlbums as live (live.id)}
        <Card>
          <CardBody>
            <HStack class="items-start justify-between gap-4">
              <Stack gap={2} class="min-w-0">
                <a href="/albums/{live.albumId}" class="truncate text-lg font-medium text-primary hover:underline">
                  {live.albumName}
                </a>
                <HStack gap={1} class="flex-wrap">
                  {#each live.include as id (id)}
                    {@const person = byId.get(id)}
                    {#if person}
                      <ImageThumbnail
                        circle
                        url={getPeopleThumbnailUrl(person)}
                        altText={person.name}
                        title={person.name}
                        widthStyle="32px"
                        heightStyle="32px"
                      />
                    {/if}
                  {/each}
                </HStack>
                <Text size="small">{describe(live)}</Text>
                <Text size="small" color="muted">{status(live)}</Text>
                {#if live.pausedReason}
                  <Alert color="warning" size="small" title="Paused">{live.pausedReason}</Alert>
                {/if}
              </Stack>
              {#if enabled}
                <HStack gap={1}>
                  <IconButton
                    icon={mdiRefresh}
                    shape="round"
                    variant="ghost"
                    color="secondary"
                    aria-label="Check for new photos now"
                    disabled={checking === live.id}
                    onclick={() => checkNow(live)}
                  />
                  <IconButton
                    icon={mdiPencilOutline}
                    shape="round"
                    variant="ghost"
                    color="secondary"
                    aria-label="Edit"
                    onclick={() => openEditor(live)}
                  />
                  <IconButton
                    icon={mdiDeleteOutline}
                    shape="round"
                    variant="ghost"
                    color="secondary"
                    aria-label="Stop this live album"
                    onclick={() => stop(live)}
                  />
                </HStack>
              {/if}
            </HStack>
          </CardBody>
        </Card>
      {/each}
    {/if}
  </Stack>
</UserPageLayout>
