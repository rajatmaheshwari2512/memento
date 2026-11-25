// SelfPhotos AI edit: the "AI Edit" button, in the photo viewer's bottom bar and in the
// timeline's selection sheet. Shown for exactly one of your own photos (not videos,
// trashed or locked photos). Opens the AI Edit page (not a tab of the editor).
import 'dart:async';

import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_edit.page.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';

/// The one photo AI Edit (and Adjust, adjust.action.dart) works on: exactly one selected or
/// open in the viewer, yours, a photo, not trashed or locked. Null otherwise.
final ownPhotoProvider = Provider.family.autoDispose<RemoteAsset?, ActionSource>((ref, source) {
  // Exactly one photo selected (or open in the viewer)...
  if (ref.watch(assetsActionProvider(source)).length != 1) {
    return null;
  }
  // ...and it's yours, a photo, on the server, not trashed or locked.
  return ref
      .watch(ownedAssetsActionProvider(source))
      .where((asset) => asset.isImage && !asset.isTrashed && !asset.isLocked)
      .singleOrNull;
}, dependencies: [assetsActionProvider, ownedAssetsActionProvider]);

class AiEditAction extends AssetActionBuilder {
  const AiEditAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    // Hidden when an admin has switched Gemini edits off. Shown until the check answers.
    if (!ref.watch(mementoFeaturesProvider).gemini) {
      return null;
    }
    if (!ref.watch(ownPhotoProvider(source).select((asset) => asset != null))) {
      return null;
    }

    return .new(icon: Icons.auto_awesome_outlined, label: aiEditLabel, onAction: () => _open(context, ref));
  }

  void _open(BuildContext context, WidgetRef ref) {
    final asset = ref.read(ownPhotoProvider(source));
    if (asset == null) {
      return;
    }
    ref.read(clearSelectionProvider(source))();
    unawaited(Navigator.of(context).push(MaterialPageRoute<bool>(builder: (_) => AiEditPage(asset: asset))));
  }
}
