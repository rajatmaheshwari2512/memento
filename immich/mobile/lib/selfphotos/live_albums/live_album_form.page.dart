// SelfPhotos live albums: create or edit one. Not part of Immich. People are chosen with
// the app's own people picker, in the same bottom sheet the search screen uses
// (FilterBottomSheetScaffold + PeoplePicker), so it looks and works the same.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/selfphotos/live_albums/live_albums.service.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:immich_mobile/widgets/search/search_filter/filter_bottom_sheet_scaffold.dart';
import 'package:immich_mobile/widgets/search/search_filter/people_picker.dart';
import 'package:immich_mobile/widgets/search/search_filter/search_filter_utils.dart';

class LiveAlbumFormPage extends ConsumerStatefulWidget {
  final LiveAlbum? liveAlbum; // editing this one; otherwise a new one
  final Set<String> taken; // albums that are already live albums

  const LiveAlbumFormPage({super.key, this.liveAlbum, required this.taken});

  @override
  ConsumerState<LiveAlbumFormPage> createState() => _LiveAlbumFormPageState();
}

class _LiveAlbumFormPageState extends ConsumerState<LiveAlbumFormPage> {
  static const _service = LiveAlbumsService();
  static const _newAlbum = 'new';

  final _albumName = TextEditingController();
  String _albumChoice = _newAlbum;
  late List<String> _include = [...?widget.liveAlbum?.include];
  late List<String> _exclude = [...?widget.liveAlbum?.exclude];
  late String _match = widget.liveAlbum?.match ?? 'any';
  late String? _since = widget.liveAlbum?.since;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _albumName.addListener(() => setState(() {}));
    unawaited(ref.read(remoteAlbumProvider.notifier).refresh());
  }

  @override
  void dispose() {
    _albumName.dispose();
    super.dispose();
  }

  bool get _canSave =>
      !_saving &&
      _include.isNotEmpty &&
      (widget.liveAlbum != null || _albumChoice != _newAlbum || _albumName.text.trim().isNotEmpty);

  Future<void> _choose({required bool include, required Map<String, Person> people}) async {
    final current = (include ? _include : _exclude).map((id) => people[id]).whereType<Person>().toSet();
    var picked = current;
    await showFilterBottomSheet(
      context: context,
      isScrollControlled: true,
      child: FractionallySizedBox(
        heightFactor: 0.8,
        child: FilterBottomSheetScaffold(
          title: include ? 'People' : 'Leave out photos with',
          expanded: true,
          onSearch: () => setState(() {
            final ids = picked.map((p) => p.id).toList();
            if (include) {
              _include = ids;
              _exclude = _exclude.where((id) => !ids.contains(id)).toList();
            } else {
              _exclude = ids;
              _include = _include.where((id) => !ids.contains(id)).toList();
            }
          }),
          onClear: () => setState(() {
            if (include) {
              _include = [];
            } else {
              _exclude = [];
            }
          }),
          child: PeoplePicker(onSelect: (value) => picked = value, initialSelection: current),
        ),
      ),
    );
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _since != null ? DateTime.tryParse(_since!) ?? now : now,
      firstDate: DateTime(1990),
      lastDate: now,
    );
    if (picked != null) {
      setState(
        () => _since =
            '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}',
      );
    }
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final rules = LiveAlbumRules(
      include: _include,
      exclude: _exclude,
      match: _include.length > 1 ? _match : 'any',
      since: _since,
    );
    try {
      final existing = widget.liveAlbum;
      final saved = existing != null
          ? await _service.update(existing.id, rules)
          : await _service.create(
              albumId: _albumChoice == _newAlbum ? null : _albumChoice,
              albumName: _albumChoice == _newAlbum ? _albumName.text.trim() : null,
              rules: rules,
            );
      if (mounted) {
        Navigator.of(context).pop(saved);
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = e.toString();
        });
      }
    }
  }

  Widget _chosen(List<String> ids, Map<String, Person> people, void Function(String) remove) => Wrap(
    spacing: 8,
    runSpacing: 8,
    children: [
      for (final id in ids)
        InputChip(
          avatar: CircleAvatar(
            backgroundImage: RemoteImageProvider(url: getFaceThumbnailUrl(id, updatedAt: people[id]?.updatedAt)),
          ),
          label: Text(people[id]?.name.isNotEmpty == true ? people[id]!.name : 'Unnamed person'),
          onDeleted: () => setState(() => remove(id)),
        ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final people = {for (final p in ref.watch(Store.people.all()).valueOrNull ?? const <Person>[]) p.id: p};
    final me = ref.watch(currentUserProvider)?.id;
    final albums = ref
        .watch(remoteAlbumProvider)
        .albums
        .where((a) => a.ownerId == me && !widget.taken.contains(a.id))
        .toList();
    final label = context.textTheme.titleSmall;
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final editing = widget.liveAlbum;

    return Scaffold(
      appBar: AppBar(
        title: Text(editing == null ? 'New live album' : 'Edit live album'),
        actions: [
          TextButton(
            onPressed: _canSave ? _save : null,
            child: _saving
                ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(editing == null ? 'Create' : 'Save'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Album', style: label),
          const SizedBox(height: 8),
          if (editing != null)
            Text(editing.albumName, style: context.textTheme.bodyLarge)
          else ...[
            DropdownButtonFormField<String>(
              initialValue: _albumChoice,
              decoration: const InputDecoration(border: OutlineInputBorder()),
              items: [
                const DropdownMenuItem(value: _newAlbum, child: Text('A new album')),
                for (final album in albums) DropdownMenuItem(value: album.id, child: Text(album.name)),
              ],
              onChanged: (value) => setState(() => _albumChoice = value ?? _newAlbum),
            ),
            if (_albumChoice == _newAlbum) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _albumName,
                decoration: const InputDecoration(border: OutlineInputBorder(), labelText: 'Album name'),
              ),
            ],
          ],
          const SizedBox(height: 24),
          Text('People', style: label),
          const SizedBox(height: 8),
          _chosen(_include, people, (id) => _include.remove(id)),
          TextButton.icon(
            onPressed: () => _choose(include: true, people: people),
            icon: const Icon(Icons.person_add_alt_outlined),
            label: Text(_include.isEmpty ? 'Choose people' : 'Change people'),
          ),
          Text('Their photos are added to the album automatically, within a few minutes of upload.', style: muted),
          if (_include.length > 1) ...[
            const SizedBox(height: 24),
            Text('Which photos', style: label),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'any', label: Text('Any of them')),
                ButtonSegment(value: 'all', label: Text('All together')),
              ],
              selected: {_match},
              onSelectionChanged: (value) => setState(() => _match = value.first),
            ),
          ],
          const SizedBox(height: 24),
          Text('Leave out photos with', style: label),
          const SizedBox(height: 8),
          _chosen(_exclude, people, (id) => _exclude.remove(id)),
          TextButton.icon(
            onPressed: () => _choose(include: false, people: people),
            icon: const Icon(Icons.person_remove_alt_1_outlined),
            label: const Text('Choose people'),
          ),
          Text(
            'Optional. Photos that include any of these people are never added, even if they also have the people above.',
            style: muted,
          ),
          const SizedBox(height: 24),
          Text('Only photos taken from', style: label),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.event_outlined),
            title: Text(_since ?? 'Any date'),
            trailing: _since == null
                ? null
                : IconButton(
                    icon: const Icon(Icons.close),
                    tooltip: 'Any date',
                    onPressed: () => setState(() => _since = null),
                  ),
            onTap: _pickDate,
          ),
          Text('Optional. Leave it as "Any date" to include every photo.', style: muted),
          const SizedBox(height: 24),
          Text(
            'Live albums only add photos. A photo you remove from the album stays removed, and nothing is deleted '
            'when you stop a live album.',
            style: muted,
          ),
          if (_error != null) ...[
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: context.colorScheme.errorContainer,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(_error!, style: TextStyle(color: context.colorScheme.onErrorContainer)),
            ),
          ],
        ],
      ),
    );
  }
}
