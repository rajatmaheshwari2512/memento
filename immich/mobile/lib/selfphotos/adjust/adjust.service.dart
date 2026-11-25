// SelfPhotos Adjust: the photo going in and the copy going out. Not part of Immich.
//
// What the copy starts from is decided as on the web (adjust-export.ts): the photo as Immich
// shows it, at the largest size the phone can read:
//   1. the original, with Immich's own crop/rotate applied if it has any;
//   2. otherwise Immich's full-size JPEG of it (if the server makes those), else its preview.
// The copy is saved through Memento's extras service, like AI Edit's results: uploaded,
// given the original's date and place, and stacked on top of it.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:openapi/api.dart' show AssetMediaSize;
import 'package:path/path.dart' as p;

// Originals worth downloading: formats Android reads.
const _readable = {'.jpg', '.jpeg', '.jfif', '.png', '.webp', '.heic', '.heif', '.avif', '.bmp'};

class AdjustService {
  const AdjustService();

  static const _client = ExtrasClient();

  /// The pictures to try for the full-size copy, best first.
  List<String> sourceUrls(RemoteAsset asset) => {
    if (asset.isEdited || _readable.contains(p.extension(asset.name).toLowerCase()))
      getOriginalUrlForRemoteId(asset.id, edited: asset.isEdited),
    getThumbnailUrlForRemoteId(asset.id, type: AssetMediaSize.fullsize, edited: asset.isEdited),
    getThumbnailUrlForRemoteId(asset.id, type: AssetMediaSize.preview),
  }.toList();

  Future<void> download(String url, File file) => _client.download(url, file);

  /// Immich's screen-sized preview, for editing live, loaded (and cached) as the viewer does.
  Future<ui.Image> preview(RemoteAsset asset) {
    final provider = RemoteImageProvider(url: getThumbnailUrlForRemoteId(asset.id, type: AssetMediaSize.preview));
    final stream = provider.resolve(ImageConfiguration.empty);
    final completer = Completer<ui.Image>();
    late final ImageStreamListener listener;
    listener = ImageStreamListener(
      (info, _) {
        if (!completer.isCompleted) {
          completer.complete(info.image.clone());
        }
        info.dispose();
        stream.removeListener(listener);
      },
      onError: (error, stack) {
        if (!completer.isCompleted) {
          completer.completeError(error, stack);
        }
        stream.removeListener(listener);
      },
    );
    stream.addListener(listener);
    return completer.future;
  }

  /// Saves the adjusted photo next to the original. Returns the copy's ID.
  Future<String> save(String assetId, Uint8List bytes, String mime) async {
    final data = await _client.upload('/adjust/${Uri.encodeComponent(assetId)}/save', bytes, mime);
    if (data is! Map || data['assetId'] is! String) {
      throw const ExtrasException(0, "Memento's extras service sent an unexpected answer.");
    }
    return data['assetId'] as String;
  }
}
