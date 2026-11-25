// SelfPhotos: the client for Memento's extras service (memento-extras) at <server>/extras,
// shared by AI edit and live albums, plus the feature flags. Not part of Immich.
// Requests go through the app's own HTTP client, whose cookie store already sends the
// Immich login to this server (for every path, not just /api). The token header is a
// fallback. The service asks Immich who the user is. See SelfPhotos memento-extras/README.md.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';

class ExtrasException implements Exception {
  final int status;
  final String message;
  final Object? data; // the service's JSON answer, if any (e.g. AI edit's usage)

  const ExtrasException(this.status, this.message, {this.data});

  @override
  String toString() => message;
}

class ExtrasClient {
  const ExtrasClient();

  // The stored endpoint is the API's address, e.g. https://photos.example.com/api.
  // The service lives next to it, at https://photos.example.com/extras.
  Uri uri(String path) {
    final api = Store.get(StoreKey.serverEndpoint);
    final base = api.replaceFirst(RegExp(r'/api/?$'), '');
    return Uri.parse('$base/extras$path');
  }

  Map<String, String> get headers {
    final token = Store.tryGet(StoreKey.accessToken);
    return {
      // Always JSON: the service refuses POST/PUT/DELETE without it (its cross-site guard).
      'content-type': 'application/json',
      if (token != null && token.isNotEmpty) 'x-immich-user-token': token,
    };
  }

  /// Sends a JSON request and returns the decoded answer (null for 204).
  Future<Object?> send(String method, String path, {Object? body}) async {
    final client = NetworkRepository.client;
    final url = uri(path);
    final encoded = body == null ? null : jsonEncode(body);
    final response = switch (method) {
      'GET' => await client.get(url, headers: headers),
      'POST' => await client.post(url, headers: headers, body: encoded),
      'PUT' => await client.put(url, headers: headers, body: encoded),
      'DELETE' => await client.delete(url, headers: headers, body: encoded),
      _ => throw ArgumentError('Unsupported method $method'),
    };
    return _decode(response);
  }

  /// POSTs raw bytes, e.g. a photo, with their own type (also a type other sites can't send,
  /// like JSON), and returns the decoded answer.
  Future<Object?> upload(String path, Uint8List bytes, String contentType) async {
    final response = await NetworkRepository.client.post(
      uri(path),
      headers: {...headers, 'content-type': contentType},
      body: bytes,
    );
    return _decode(response);
  }

  /// Streams a file from Immich (e.g. a photo's original) to [file], with the same login.
  Future<void> download(String url, File file) async {
    final response = await NetworkRepository.client.send(http.Request('GET', Uri.parse(url))..headers.addAll(headers));
    if (response.statusCode != 200) {
      await response.stream.drain<void>();
      throw ExtrasException(response.statusCode, "Couldn't download the photo (${response.statusCode}).");
    }
    await response.stream.pipe(file.openWrite());
  }

  Object? _decode(http.Response response) {
    if (response.statusCode == 204) {
      return null;
    }
    Object? data;
    try {
      data = jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      // not JSON (e.g. something other than the service answered)
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = data is Map ? data['error'] : null;
      throw ExtrasException(
        response.statusCode,
        error is String ? error : "Memento's extras service answered ${response.statusCode}.",
        data: data,
      );
    }
    return data;
  }

  /// Raw bytes, e.g. an edited image.
  Future<Uint8List> bytes(String path) async {
    final response = await NetworkRepository.client.get(uri(path), headers: headers);
    if (response.statusCode != 200) {
      throw ExtrasException(response.statusCode, "Couldn't load it (${response.statusCode}).");
    }
    return response.bodyBytes;
  }
}

/// Memento's own features, as an admin set them (Administration → Settings → Memento
/// Features). Anything unknown or unreachable counts as on: the service refuses
/// switched-off features itself, with a message, so a failed check never hides a feature
/// that works. Except Ask Photos and themed memories, which stay hidden until known to be on
/// (as on the web): hiding them for a moment beats showing them to someone whose admin
/// switched them off.
class MementoFlags {
  final bool gemini;
  // The AI tools (presets and highlighting).
  final bool geminiTools;
  final bool liveAlbums;
  final bool askPhotos;
  final bool adjust;
  final bool themedMemories;
  final bool creations;
  final bool reduceNoise;

  const MementoFlags({
    required this.gemini,
    required this.geminiTools,
    required this.liveAlbums,
    required this.askPhotos,
    required this.adjust,
    required this.themedMemories,
    required this.creations,
    required this.reduceNoise,
  });

  static const unknown = MementoFlags(
    gemini: true,
    geminiTools: true,
    liveAlbums: true,
    askPhotos: false,
    adjust: true,
    themedMemories: false,
    creations: false,
    reduceNoise: true,
  );

  static bool _enabled(Object? flags, String group, {bool otherwise = true, String name = 'enabled'}) {
    final value = flags is Map && flags[group] is Map ? (flags[group] as Map)[name] : null;
    return value is bool ? value : otherwise;
  }

  static Future<MementoFlags>? _asking;

  /// Asks the service; throws if it can't be reached. Callers at the same moment (at start:
  /// the memory titles and the buttons) share one request.
  static Future<MementoFlags> fetch() => _asking ??= () async {
    try {
      return MementoFlags.fromJson(await const ExtrasClient().send('GET', '/flags'));
    } finally {
      _asking = null;
    }
  }();

  factory MementoFlags.fromJson(Object? json) {
    final flags = json is Map ? json['flags'] : null;
    final gemini = _enabled(flags, 'gemini');
    return MementoFlags(
      gemini: gemini,
      // a service from before the AI tools has neither presets nor highlighting
      geminiTools: gemini && _enabled(flags, 'gemini', name: 'tools', otherwise: false),
      liveAlbums: _enabled(flags, 'liveAlbums'),
      // a service from before Ask Photos doesn't list it
      askPhotos: _enabled(flags, 'askPhotos', otherwise: false),
      // nor one from before Adjust, which can't save its copies
      adjust: _enabled(flags, 'adjust', otherwise: false),
      // themed memories: off until known, like Ask Photos
      themedMemories: _enabled(flags, 'themedMemories', otherwise: false),
      creations: _enabled(flags, 'creations', otherwise: false),
      // nor one from before Reduce noise for videos
      reduceNoise: _enabled(flags, 'reduceNoise', otherwise: false),
    );
  }
}

/// Asked again whenever something starts watching it (autoDispose), e.g. each time a photo
/// or the library is opened, so a change in the admin panel shows up without restarting.
final mementoFlagsProvider = FutureProvider.autoDispose<MementoFlags>((ref) async {
  try {
    return await MementoFlags.fetch();
  } catch (_) {
    return MementoFlags.unknown;
  }
});

/// The flags as known so far, for hiding switched-off features (`unknown` until loaded).
final mementoFeaturesProvider = Provider.autoDispose<MementoFlags>(
  (ref) => ref.watch(mementoFlagsProvider).valueOrNull ?? MementoFlags.unknown,
);
