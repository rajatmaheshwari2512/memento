import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_edit.service.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';

class _Recorder extends ExtrasClient {
  final requests = <({String method, String path, Map<String, Object?> body})>[];

  _Recorder();

  @override
  Future<Object?> send(String method, String path, {Object? body}) async {
    requests.add((method: method, path: path, body: body! as Map<String, Object?>));
    return {'editId': 'edit-${requests.length}'};
  }
}

class _Refusing extends ExtrasClient {
  final ExtrasException refusal;

  const _Refusing(this.refusal);

  @override
  Future<Object?> send(String method, String path, {Object? body}) async => throw refusal;

  @override
  Future<Object?> upload(String path, Uint8List bytes, String contentType) async => throw refusal;

  @override
  Future<Uint8List> bytes(String path) async => throw refusal;
}

Future<AiEditException> _refused(
  Future<Object?> Function(AiEditService service) action,
  ExtrasException refusal,
) async {
  try {
    await action(AiEditService(_Refusing(refusal)));
  } on AiEditException catch (error) {
    return error;
  }
  throw StateError('It should have been refused.');
}

void main() {
  test('an edit sends the picked presets as a list of ids, and none for words alone', () async {
    final client = _Recorder();
    final service = AiEditService(client);

    final picked = await service.create('asset', 'the combined instruction', tools: ['enhance', 'sky', 'watercolour']);
    await service.create('asset', 'make it warmer');

    expect(picked.editId, 'edit-1');
    expect(client.requests.map((r) => (r.method, r.path)), [('POST', '/edits'), ('POST', '/edits')]);
    expect(client.requests[0].body, {
      'assetId': 'asset',
      'prompt': 'the combined instruction',
      'tools': ['enhance', 'sky', 'watercolour'],
    });
    expect(client.requests[1].body, {'assetId': 'asset', 'prompt': 'make it warmer'});
  });

  test("a refusal keeps the service's own words, its reason and today's usage", () async {
    final error = await _refused(
      (service) => service.create('asset', 'make it warmer'),
      const ExtrasException(
        413,
        'This photo is too large for AI edits.',
        data: {
          'error': 'This photo is too large for AI edits.',
          'code': 'photo_too_large',
          'usage': {
            'today': {'used': 3, 'limit': 20},
            'thisMonth': {'used': 100, 'limit': 500},
          },
        },
      ),
    );
    expect(
      (error.status, error.code, error.message, error.fromService),
      (413, 'photo_too_large', 'This photo is too large for AI edits.', true),
    );
    expect(error.usage?.editsLeft, 17);
  });

  test("a saved paste's refusal keeps the service's own words", () async {
    final error = await _refused(
      (service) => service.saveArea('edit', Uint8List(1), 'image/jpeg'),
      const ExtrasException(
        400,
        "That isn't this photo at its full size.",
        data: {'error': "That isn't this photo at its full size."},
      ),
    );
    expect((error.message, error.fromService), ("That isn't this photo at its full size.", true));
  });

  test("an answer that isn't the service's, or an edit's picture that can't be loaded, is marked so", () async {
    final other = await _refused(
      (service) => service.create('asset', 'make it warmer'),
      const ExtrasException(502, "Memento's extras service answered 502."),
    );
    expect((other.fromService, other.code), (false, null));
    final image = await _refused((service) => service.image('edit'), const ExtrasException(404, "Couldn't load it."));
    expect((image.fromService, image.code), (false, aiEditImageUnavailable));
  });
}
