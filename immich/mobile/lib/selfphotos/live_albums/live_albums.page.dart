// SelfPhotos live albums: the list, opened from Library → Live albums.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/live_albums/live_album_form.page.dart';
import 'package:immich_mobile/selfphotos/live_albums/live_albums.service.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

class LiveAlbumsPage extends ConsumerStatefulWidget {
  const LiveAlbumsPage({super.key});

  @override
  ConsumerState<LiveAlbumsPage> createState() => _LiveAlbumsPageState();
}

class _LiveAlbumsPageState extends ConsumerState<LiveAlbumsPage> {
  static const _service = LiveAlbumsService();

  List<LiveAlbum>? _liveAlbums;
  String? _error;
  String? _checking;
  Timer? _refresh;

  @override
  void initState() {
    super.initState();
    unawaited(_reload());
    _refresh = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_reload()));
  }

  @override
  void dispose() {
    _refresh?.cancel();
    super.dispose();
  }

  Future<void> _reload() async {
    try {
      final list = await _service.list();
      if (mounted) {
        setState(() {
          _liveAlbums = list;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString());
      }
    }
  }

  Future<void> _openForm({LiveAlbum? liveAlbum}) async {
    final saved = await Navigator.of(context).push<LiveAlbum>(
      MaterialPageRoute(
        builder: (_) =>
            LiveAlbumFormPage(liveAlbum: liveAlbum, taken: _liveAlbums?.map((l) => l.albumId).toSet() ?? {}),
      ),
    );
    if (saved != null && mounted) {
      ImmichToast.show(
        context: context,
        msg: liveAlbum == null ? '${saved.albumName} is now a live album' : 'Live album saved',
        toastType: ToastType.success,
      );
      await _reload();
    }
  }

  Future<void> _check(LiveAlbum live) async {
    setState(() => _checking = live.id);
    try {
      final added = await _service.check(live.id);
      if (mounted) {
        ImmichToast.show(
          context: context,
          msg: added > 0 ? 'Added $added new ${added == 1 ? 'photo' : 'photos'}' : 'No new photos',
        );
      }
      await _reload();
    } catch (e) {
      if (mounted) {
        ImmichToast.show(context: context, msg: e.toString(), toastType: ToastType.error);
      }
    } finally {
      if (mounted) {
        setState(() => _checking = null);
      }
    }
  }

  Future<void> _stop(LiveAlbum live) async {
    await showDialog<void>(
      context: context,
      builder: (_) => ConfirmDialog(
        title: 'Stop this live album?',
        content: '${live.albumName} stays, with all its photos. It just stops adding new ones.',
        ok: 'Stop',
        onOk: () async {
          try {
            await _service.delete(live.id);
            if (mounted) {
              ImmichToast.show(context: context, msg: '${live.albumName} is a normal album again');
            }
            await _reload();
          } catch (e) {
            if (mounted) {
              ImmichToast.show(context: context, msg: e.toString(), toastType: ToastType.error);
            }
          }
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final enabled = ref.watch(mementoFeaturesProvider).liveAlbums;
    final people = {for (final p in ref.watch(Store.people.all()).valueOrNull ?? const <Person>[]) p.id: p};
    final liveAlbums = _liveAlbums;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Live albums'),
        actions: [
          if (enabled) IconButton(icon: const Icon(Icons.add), tooltip: 'New live album', onPressed: () => _openForm()),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (!enabled)
              const _Notice(
                text:
                    'Live albums are switched off. An admin can turn them on in Administration → Settings → '
                    'Memento Features. Your albums and their photos stay as they are.',
              ),
            if (_error != null)
              _Notice(text: "Couldn't load your live albums: $_error", isError: true)
            else if (liveAlbums == null)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (liveAlbums.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Text(
                  'No live albums yet. A live album adds photos of the people you choose, automatically.',
                  textAlign: TextAlign.center,
                  style: context.textTheme.bodyLarge?.copyWith(color: context.colorScheme.onSurfaceVariant),
                ),
              )
            else
              for (final live in liveAlbums)
                _LiveAlbumCard(
                  live: live,
                  people: people,
                  enabled: enabled,
                  checking: _checking == live.id,
                  onCheck: () => _check(live),
                  onEdit: () => _openForm(liveAlbum: live),
                  onStop: () => _stop(live),
                ),
          ],
        ),
      ),
    );
  }
}

class _LiveAlbumCard extends StatelessWidget {
  final LiveAlbum live;
  final Map<String, Person> people;
  final bool enabled;
  final bool checking;
  final VoidCallback onCheck;
  final VoidCallback onEdit;
  final VoidCallback onStop;

  const _LiveAlbumCard({
    required this.live,
    required this.people,
    required this.enabled,
    required this.checking,
    required this.onCheck,
    required this.onEdit,
    required this.onStop,
  });

  String _names(List<String> ids) =>
      ids.map((id) => people[id]?.name.isNotEmpty == true ? people[id]!.name : 'Unnamed person').join(', ');

  String get _description {
    final parts = <String>[];
    if (live.include.length > 1) {
      parts.add(
        '${live.match == 'all' ? 'All of' : 'Any of'} ${_names(live.include)}${live.match == 'all' ? ', together' : ''}',
      );
    } else {
      parts.add(_names(live.include));
    }
    if (live.exclude.isNotEmpty) {
      parts.add('not with ${_names(live.exclude)}');
    }
    if (live.since != null) {
      parts.add('from ${live.since}');
    }
    return parts.join(' · ');
  }

  String get _status {
    final lastRun = live.lastRunAt;
    if (lastRun == null) {
      return 'Filling now…';
    }
    final minutes = DateTime.now().difference(lastRun).inMinutes;
    final ago = minutes < 1 ? 'just now' : (minutes < 60 ? '$minutes min ago' : '${minutes ~/ 60} h ago');
    return '${live.totalAdded} ${live.totalAdded == 1 ? 'photo' : 'photos'} added · checked $ago';
  }

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(live.albumName, style: context.textTheme.titleMedium),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final id in live.include)
                        CircleAvatar(
                          radius: 16,
                          backgroundImage: RemoteImageProvider(
                            url: getFaceThumbnailUrl(id, updatedAt: people[id]?.updatedAt),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(_description, style: context.textTheme.bodyMedium),
                  const SizedBox(height: 4),
                  Text(_status, style: muted),
                  if (live.pausedReason != null) ...[
                    const SizedBox(height: 8),
                    _Notice(text: 'Paused: ${live.pausedReason}', isError: true),
                  ],
                ],
              ),
            ),
            if (enabled)
              PopupMenuButton<String>(
                enabled: !checking,
                onSelected: (value) => switch (value) {
                  'check' => onCheck(),
                  'edit' => onEdit(),
                  _ => onStop(),
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'check', child: Text('Check for new photos now')),
                  PopupMenuItem(value: 'edit', child: Text('Edit')),
                  PopupMenuItem(value: 'stop', child: Text('Stop this live album')),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  final String text;
  final bool isError;

  const _Notice({required this.text, this.isError = false});

  @override
  Widget build(BuildContext context) {
    final colors = context.colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isError ? colors.errorContainer : colors.tertiaryContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(text, style: TextStyle(color: isError ? colors.onErrorContainer : colors.onTertiaryContainer)),
    );
  }
}
