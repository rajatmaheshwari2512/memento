// SelfPhotos AI edit: its calls to Memento's extras service, through the shared client
// (selfphotos/extras_client.dart). Not part of Immich. See SelfPhotos memento-extras/README.md.
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';

/// The AI page's service (a provider, so a test can stand in for Memento's extras service).
final aiEditServiceProvider = Provider<AiEditService>((ref) => const AiEditService());

/// Your AI edits today (against your daily limit) and everyone's this month (against the
/// server's monthly one), as the service counts them.
class AiEditUsage {
  final int todayUsed;
  final int todayLimit;
  final int monthUsed;
  final int monthLimit;

  const AiEditUsage({
    required this.todayUsed,
    required this.todayLimit,
    required this.monthUsed,
    required this.monthLimit,
  });

  static AiEditUsage? fromJson(Object? json) {
    if (json is! Map) {
      return null;
    }
    final today = json['today'];
    final month = json['thisMonth'];
    if (today is! Map || month is! Map) {
      return null;
    }
    return AiEditUsage(
      todayUsed: (today['used'] as num?)?.toInt() ?? 0,
      todayLimit: (today['limit'] as num?)?.toInt() ?? 0,
      monthUsed: (month['used'] as num?)?.toInt() ?? 0,
      monthLimit: (month['limit'] as num?)?.toInt() ?? 0,
    );
  }

  /// How many more edits can be made today: your daily limit, or everyone's monthly one if
  /// that's closer (as the web's editsLeft, ai-edit-api.ts).
  int get editsLeft => max(0, min(todayLimit - todayUsed, monthLimit - monthUsed));
}

/// [AiEditException.code] when an edit's picture couldn't be loaded ([AiEditService.image]).
const aiEditImageUnavailable = 'image_unavailable';

/// The service's [AiEditException.code] for a photo too large for AI edits
/// (ai_tools.dart tooLargeForAi).
const aiEditPhotoTooLarge = 'photo_too_large';

class AiEditException implements Exception {
  final int status;
  final String message;
  final AiEditUsage? usage;

  /// Why, in a word: the service's reason when it gives one (e.g. [aiEditPhotoTooLarge]), or
  /// [aiEditImageUnavailable].
  final String? code;

  /// [message] is the service's own words (plain, for people), not one made here.
  final bool fromService;

  const AiEditException(this.status, this.message, {this.usage, this.code, this.fromService = false});

  @override
  String toString() => message;
}

class AiEditService {
  final ExtrasClient _client;

  /// [_client]: Memento's extras service (a test can stand in for it, to see what's sent).
  const AiEditService([this._client = const ExtrasClient()]);

  // The service's error, as AI edit's own exception, with its own words, its reason and today's
  // usage when it sends them.
  static AiEditException _refusal(ExtrasException e) {
    final data = e.data;
    final answer = data is Map ? data : const {};
    return AiEditException(
      e.status,
      e.message,
      usage: AiEditUsage.fromJson(answer['usage']),
      code: answer['code'] is String ? answer['code'] as String : null,
      fromService: answer['error'] is String,
    );
  }

  Future<Object?> _send(String method, String path, {Object? body}) async {
    try {
      return await _client.send(method, path, body: body);
    } on ExtrasException catch (e) {
      throw _refusal(e);
    }
  }

  Future<AiEditUsage?> usage() async => AiEditUsage.fromJson(await _send('GET', '/limits'));

  /// Makes an edit. With [fromEditId], edits that earlier result instead of the original.
  /// [tools]: the ids of the AI tools picked (ai-tools.json), whose instructions [prompt] combines
  /// (none: only typed words). For an edit of a highlighted area
  /// (ai_area.dart): [mark], the photo with that area tinted red, and for a first edit [photo],
  /// the photo itself upright (JPEGs). The size is the service's, automatic by the photo.
  Future<({String editId, AiEditUsage? usage})> create(
    String assetId,
    String prompt, {
    String? fromEditId,
    List<String> tools = const [],
    Uint8List? mark,
    Uint8List? photo,
  }) async {
    final data = await _send(
      'POST',
      mark == null ? '/edits' : '/edits/area',
      body: {
        'assetId': assetId,
        'prompt': prompt,
        'fromEditId': ?fromEditId,
        if (tools.isNotEmpty) 'tools': tools,
        if (mark != null) 'mark': base64Encode(mark),
        if (photo != null) 'photo': base64Encode(photo),
      },
    );
    if (data is! Map || data['editId'] is! String) {
      throw const AiEditException(0, 'Memento\'s extras service sent an unexpected answer.');
    }
    return (editId: data['editId'] as String, usage: AiEditUsage.fromJson(data['usage']));
  }

  Future<Uint8List> image(String editId) async {
    try {
      return await _client.bytes('/edits/${Uri.encodeComponent(editId)}/image');
    } on ExtrasException catch (e) {
      throw AiEditException(e.status, "Couldn't load the edited photo (${e.status}).", code: aiEditImageUnavailable);
    }
  }

  /// Saves the result next to the original, stacked on top of it. Returns the new photo's ID.
  /// [whole]: an edit of a highlighted area saved as the AI made it, not pasted (the person
  /// chose it).
  Future<String> save(String editId, {bool whole = false}) async {
    final data = await _send(
      'POST',
      '/edits/${Uri.encodeComponent(editId)}/save',
      body: whole ? const {'whole': true} : const <String, Object>{},
    );
    if (data is! Map || data['assetId'] is! String) {
      throw const AiEditException(0, 'Memento\'s extras service sent an unexpected answer.');
    }
    return data['assetId'] as String;
  }

  /// An edit of a highlighted area: the original with that area of the result pasted on, at
  /// full size (ai_area.dart pasteBack), saved like [save]. Returns the new photo's ID.
  Future<String> saveArea(String editId, Uint8List bytes, String mime) async {
    final Object? data;
    try {
      data = await _client.upload('/edits/${Uri.encodeComponent(editId)}/save-area', bytes, mime);
    } on ExtrasException catch (e) {
      throw _refusal(e);
    }
    if (data is! Map || data['assetId'] is! String) {
      throw const AiEditException(0, 'Memento\'s extras service sent an unexpected answer.');
    }
    return data['assetId'] as String;
  }

  /// How a highlighted edit's result was lined up with the photo (numbers only), for the
  /// service's log, where the refusal threshold is tuned. Fire and forget.
  Future<void> reportAlignment(String editId, Map<String, Object> report) async {
    try {
      await _send('POST', '/edits/${Uri.encodeComponent(editId)}/alignment', body: report);
    } catch (_) {
      // only for the log
    }
  }

  Future<void> discard(String editId) =>
      _send('DELETE', '/edits/${Uri.encodeComponent(editId)}', body: const <String, Object>{});
}
