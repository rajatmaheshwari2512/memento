// SelfPhotos live albums: albums that fill themselves with photos of chosen people.
// Calls to Memento's extras service (memento-extras) through the shared client. Not part
// of Immich. See SelfPhotos FEATURES.md, "Live albums".
import 'package:immich_mobile/selfphotos/extras_client.dart';

class LiveAlbum {
  final String id;
  final String albumId;
  final String albumName;
  final String match; // any: at least one of the people; all: all of them in the same photo
  final List<String> include;
  final List<String> exclude;
  final String? since; // YYYY-MM-DD
  final DateTime? lastRunAt;
  final int totalAdded;
  final String? pausedReason;

  const LiveAlbum({
    required this.id,
    required this.albumId,
    required this.albumName,
    required this.match,
    required this.include,
    required this.exclude,
    required this.since,
    required this.lastRunAt,
    required this.totalAdded,
    required this.pausedReason,
  });

  static List<String> _ids(Object? value) => value is List ? value.whereType<String>().toList() : const [];

  factory LiveAlbum.fromJson(Map json) => LiveAlbum(
    id: json['id'] as String,
    albumId: json['albumId'] as String,
    albumName: (json['albumName'] as String?) ?? '',
    match: json['match'] == 'all' ? 'all' : 'any',
    include: _ids(json['include']),
    exclude: _ids(json['exclude']),
    since: json['since'] as String?,
    lastRunAt: json['lastRunAt'] is String ? DateTime.tryParse(json['lastRunAt'] as String) : null,
    totalAdded: (json['totalAdded'] as num?)?.toInt() ?? 0,
    pausedReason: json['pausedReason'] as String?,
  );
}

class LiveAlbumRules {
  final List<String> include;
  final List<String> exclude;
  final String match;
  final String? since;

  const LiveAlbumRules({required this.include, required this.exclude, required this.match, this.since});

  Map<String, Object?> toJson() => {'include': include, 'exclude': exclude, 'match': match, 'since': since};
}

class LiveAlbumsService {
  const LiveAlbumsService();

  static const _client = ExtrasClient();

  LiveAlbum _one(Object? data) {
    if (data is! Map) {
      throw const ExtrasException(0, "Memento's extras service sent an unexpected answer.");
    }
    return LiveAlbum.fromJson(data);
  }

  Future<List<LiveAlbum>> list() async {
    final data = await _client.send('GET', '/live-albums');
    return data is List ? data.whereType<Map>().map(LiveAlbum.fromJson).toList() : const [];
  }

  /// A new album ([albumName]) or one of yours ([albumId]).
  Future<LiveAlbum> create({String? albumId, String? albumName, required LiveAlbumRules rules}) async => _one(
    await _client.send('POST', '/live-albums', body: {...rules.toJson(), 'albumId': ?albumId, 'albumName': ?albumName}),
  );

  Future<LiveAlbum> update(String id, LiveAlbumRules rules) async =>
      _one(await _client.send('PUT', '/live-albums/${Uri.encodeComponent(id)}', body: rules.toJson()));

  /// Stops it adding photos. The album and its photos stay.
  Future<void> delete(String id) =>
      _client.send('DELETE', '/live-albums/${Uri.encodeComponent(id)}', body: const <String, Object>{});

  /// Checks for new photos now. Returns how many were added.
  Future<int> check(String id) async {
    final data = await _client.send(
      'POST',
      '/live-albums/${Uri.encodeComponent(id)}/check',
      body: const <String, Object>{},
    );
    return data is Map ? ((data['added'] as num?)?.toInt() ?? 0) : 0;
  }
}
