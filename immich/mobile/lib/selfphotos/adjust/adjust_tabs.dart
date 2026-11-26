// SelfPhotos editor: the editor's tabs, shown in both Immich's crop screen (Crop chosen) and
// Adjust's pages (Adjust, Filters, Straighten, Markup).
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/ai_edit.action.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.page.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_ui/immich_ui.dart';

enum AdjustTab {
  crop(Icons.crop_rotate),
  adjust(Icons.tune),
  filters(Icons.filter_vintage_outlined),
  straighten(Icons.straighten),
  markup(Icons.draw_outlined);

  final IconData icon;

  const AdjustTab(this.icon);

  String label(BuildContext context) => switch (this) {
    crop => context.t.crop,
    adjust => context.t.editor_adjust,
    filters => context.t.filters,
    straighten => context.t.editor_straighten,
    markup => context.t.editor_markup,
  };

  bool get isAdjust => this != crop;
}

/// Opens Adjust's page on [tab].
Future<bool> openEditor(
  NavigatorState navigator,
  RemoteAsset asset,
  AdjustTab tab, {
  required bool fromCropScreen,
}) async {
  final saved = await navigator.push<bool>(
    MaterialPageRoute(
      builder: (_) => AdjustPage(asset: asset, tab: tab, fromCropScreen: fromCropScreen),
    ),
  );
  return saved == true;
}

class AdjustTabs extends StatelessWidget {
  final AdjustTab active;
  final bool showCrop;
  final bool showAdjust;
  final bool enabled;
  final ValueChanged<AdjustTab> onSelect;

  const AdjustTabs({
    super.key,
    required this.active,
    required this.showCrop,
    required this.showAdjust,
    required this.onSelect,
    this.enabled = true,
  });

  bool _shown(AdjustTab tab) => tab == AdjustTab.crop ? showCrop : showAdjust;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => FittedBox(
        fit: BoxFit.scaleDown,
        child: ConstrainedBox(
          constraints: BoxConstraints(minWidth: constraints.maxWidth),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              for (final tab in AdjustTab.values)
                if (_shown(tab))
                  AdjustChoice(
                    icon: tab.icon,
                    label: tab.label(context),
                    selected: tab == active,
                    enabled: enabled,
                    onPressed: () {
                      if (tab != active) {
                        onSelect(tab);
                      }
                    },
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

class AdjustChoice extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final bool enabled;
  final VoidCallback onPressed;

  const AdjustChoice({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onPressed,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    return ImmichColorOverride(
      color: selected ? context.primaryColor : null,
      child: ImmichColumnButton(icon: icon, label: label, disabled: !enabled, onPressed: onPressed),
    );
  }
}

/// [AdjustChoice]s in a row that scrolls sideways (Adjust's sliders, AI Edit's presets), each with
/// [gap] on either side.
class AdjustChoiceRow extends StatelessWidget {
  final double gap;
  final List<AdjustChoice> choices;
  final bool lineUp;

  const AdjustChoiceRow({super.key, required this.gap, required this.choices, this.lineUp = false});

  /// ImmichColumnButton's widest: its name's 90 and ImmichSpacing.sm on either side.
  static const cellWidth = 90 + 2 * ImmichSpacing.sm;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        crossAxisAlignment: lineUp ? CrossAxisAlignment.start : CrossAxisAlignment.center,
        children: [
          for (final choice in choices)
            Padding(
              padding: EdgeInsets.symmetric(horizontal: gap),
              child: lineUp ? SizedBox(width: cellWidth, child: choice) : choice,
            ),
        ],
      ),
    );
  }
}

/// Adjust's tabs inside Immich's crop screen (edit.page.dart), with Crop chosen.
class AdjustEntryTabs extends ConsumerWidget {
  const AdjustEntryTabs({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asset = ref.watch(ownPhotoProvider(ActionSource.viewer));
    final features = ref.watch(mementoFeaturesProvider);
    if (asset == null || !features.adjust) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: AdjustTabs(
        active: AdjustTab.crop,
        showCrop: true,
        showAdjust: true,
        onSelect: (tab) async {
          final navigator = Navigator.of(context);
          if (await openEditor(navigator, asset, tab, fromCropScreen: true)) {
            await navigator.maybePop();
          }
        },
      ),
    );
  }
}
