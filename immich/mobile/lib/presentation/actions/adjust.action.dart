// SelfPhotos Adjust: an Edit button for the photos Immich's own Edit doesn't open (motion
// photos). It looks like Immich's (same icon and name) and opens Adjust directly. For other
// photos Adjust is a tab inside Immich's crop screen (selfphotos/adjust/adjust_tabs.dart).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/actions/ai_edit.action.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_tabs.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';

class AdjustAction extends AssetActionBuilder {
  const AdjustAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    if (!ref.watch(mementoFeaturesProvider).adjust) {
      return null;
    }
    final asset = ref.watch(ownPhotoProvider(source));
    // Immich's own Edit is shown for editable photos (see EditAssetAction).
    if (asset == null || asset.isEditable) {
      return null;
    }
    return .new(
      icon: Icons.tune,
      label: context.t.edit,
      onAction: () => unawaited(openEditor(Navigator.of(context), asset, AdjustTab.adjust, fromCropScreen: false)),
    );
  }
}
