// SelfPhotos Reduce noise: the "Reduce noise" button in the video viewer's bottom bar, for one of
// your own videos (not trashed or locked). It starts the cleaning on the server and the person
// keeps browsing; the messages follow them (selfphotos/reduce_noise/reduce_noise.service.dart).
import 'dart:async';

import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/reduce_noise/reduce_noise.service.dart';

/// The one video Reduce noise works on: open in the viewer (or the only one selected), yours,
/// a video, on the server, not trashed or locked. Null otherwise. (AI Edit's ownPhotoProvider,
/// for videos.)
final ownVideoProvider = Provider.family.autoDispose<RemoteAsset?, ActionSource>((ref, source) {
  if (ref.watch(assetsActionProvider(source)).length != 1) {
    return null;
  }
  return ref
      .watch(ownedAssetsActionProvider(source))
      .where((asset) => asset.isVideo && !asset.isTrashed && !asset.isLocked)
      .singleOrNull;
}, dependencies: [assetsActionProvider, ownedAssetsActionProvider]);

class ReduceNoiseAction extends AssetActionBuilder {
  const ReduceNoiseAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    // Hidden when an admin has switched it off. Shown until the check answers.
    if (!ref.watch(mementoFeaturesProvider).reduceNoise) {
      return null;
    }
    if (!ref.watch(ownVideoProvider(source).select((asset) => asset != null))) {
      return null;
    }
    return .new(icon: Icons.graphic_eq, label: context.t.reduce_noise, onAction: () => _start(ref));
  }

  void _start(WidgetRef ref) {
    final video = ref.read(ownVideoProvider(source));
    if (video != null) {
      unawaited(ref.read(reduceNoiseProvider).start(video.id));
    }
  }
}
