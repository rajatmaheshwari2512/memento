// SelfPhotos Adjust for Android: light and colour sliders, filters, straighten and markup, saved
// as a copy stacked on the original (the same save as AI Edit). Not part of Immich.
//
// Laid out like Immich's crop screen (presentation/pages/edit/edit.page.dart): dark theme,
// black app bar with close, title and a done button, the photo on black, and a rounded panel
// with the tools and Reset. The live preview is Immich's preview drawn through the shared
// shader at screen size; Save renders the photo at full size (adjust_export.dart).
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.service.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_auto.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_export.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_native.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_params.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_shader.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_tabs.dart';
import 'package:immich_mobile/selfphotos/adjust/editor_scaffold.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_editor.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_layer.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_tools.dart';
import 'package:immich_mobile/selfphotos/adjust/perspective_corners.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';

class AdjustPage extends ConsumerStatefulWidget {
  final RemoteAsset asset;
  final AdjustTab tab;

  /// Opened from Immich's crop screen, which is still underneath: the Crop tab goes back.
  final bool fromCropScreen;

  const AdjustPage({super.key, required this.asset, this.tab = AdjustTab.adjust, this.fromCropScreen = false});

  @override
  ConsumerState<AdjustPage> createState() => _AdjustPageState();
}

class _AdjustPageState extends ConsumerState<AdjustPage> {
  static const _service = AdjustService();

  late AdjustTab _tab = widget.tab == AdjustTab.crop ? AdjustTab.adjust : widget.tab;
  AdjustState _state = const AdjustState();
  AdjustSlider _slider = AdjustSlider.exposure;
  AdjustShader? _shader;
  ui.FragmentShader? _previewShader;
  ui.Image? _preview;
  List<AdjustFilter> _filters = const [];
  final Map<String?, ui.Image> _thumbnails = {};
  bool _failed = false;
  bool _saving = false;
  double _progress = 0;
  bool _comparing = false;
  AutoSettings? _autoSettings;
  // Straighten's Perspective mode: the photo shown whole, unwarped, with its four corners.
  bool _perspectiveMode = false;
  // What's drawn on the photo (the Markup tab), on top of everything else.
  final _markup = MarkupEditor();

  bool get _busy => _saving || _shader == null || !ref.read(mementoFeaturesProvider).adjust;
  bool get _unchanged => _state.isUnchanged && _markup.isEmpty;

  @override
  void initState() {
    super.initState();
    _markup.addListener(() => setState(() {}));
    unawaited(_load());
    unawaited(_markup.load());
  }

  @override
  void dispose() {
    _markup.dispose();
    _previewShader?.dispose();
    _preview?.dispose();
    for (final image in _thumbnails.values) {
      image.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final (shader, filters, preview) = await (
        AdjustShader.load(),
        loadAdjustFilters(),
        _service.preview(widget.asset),
      ).wait;
      if (!mounted) {
        preview.dispose();
        return;
      }
      setState(() {
        _shader = shader;
        _previewShader = shader.create();
        _filters = filters;
        _preview = preview;
      });
      await _makeThumbnails(shader, preview);
    } catch (_) {
      if (mounted) {
        setState(() => _failed = true);
      }
    }
  }

  // Each filter on the photo, small, drawn once.
  Future<void> _makeThumbnails(AdjustShader shader, ui.Image preview) async {
    final longest = (72 * MediaQuery.devicePixelRatioOf(context)).round();
    final scale = longest / (preview.width > preview.height ? preview.width : preview.height);
    final size = AdjustSize((preview.width * scale).round(), (preview.height * scale).round());
    for (final id in [null, ..._filters.map((f) => f.id)]) {
      final values = shaderValues(AdjustState(filter: id), _filters);
      final image = await shader.render(
        AdjustRenderJob.whole(values, 0, preview, size),
        preview,
        quality: FilterQuality.medium,
      );
      if (!mounted) {
        image.dispose();
        return;
      }
      setState(() => _thumbnails[id] = image);
    }
  }

  void _update(AdjustState state) => setState(() => _state = state);

  bool get _placingCorners => _tab == AdjustTab.straighten && _perspectiveMode;

  // Auto: the light and colour sliders from the photo itself (adjust_auto.dart).
  Future<void> _auto() async {
    final preview = _preview;
    if (preview == null || _busy) {
      return;
    }
    final settings = _autoSettings ??= await loadAutoSettings();
    final values = await autoAdjustImage(preview, settings);
    if (mounted) {
      _update(_state.withSliders(values));
    }
  }

  Future<void> _selectTab(AdjustTab tab) async {
    _markup.select(null); // a text left empty goes
    if (tab.isAdjust) {
      setState(() => _tab = tab);
      return;
    }
    // Crop: back to Immich's crop screen, underneath.
    if (_unchanged || (await confirmEditorDiscard(context) ?? false)) {
      if (mounted) {
        _state = const AdjustState();
        _markup.reset();
        Navigator.of(context).pop(false);
      }
    }
  }

  String _failure(Object error) => switch (error) {
    AdjustNativeException(code: 'too-large') => context.t.editor_copy_too_large,
    AdjustNativeException(code: 'unreadable') => context.t.error_loading_image,
    ExtrasException(:final message) => message,
    _ => error.toString(),
  };

  Future<void> _save() async {
    final shader = _shader;
    if (shader == null || _unchanged || _busy) {
      return;
    }
    setState(() {
      _saving = true;
      _progress = 0;
    });
    try {
      final config = _markup.config;
      final copy = await AdjustExporter(shader, _filters).export(
        widget.asset,
        _state,
        markup: _markup.isEmpty || config == null ? null : (items: _markup.items, config: config),
        onProgress: (done) => mounted ? setState(() => _progress = done) : null,
      );
      await _service.save(widget.asset.id, copy.bytes, copy.mime);
      if (!mounted) {
        return;
      }
      ImmichToast.show(context: context, msg: context.t.editor_copy_saved, toastType: ToastType.success);
      if (copy.fromPreview) {
        ImmichToast.show(
          context: context,
          msg: context.t.editor_copy_from_preview(width: copy.size.width, height: copy.size.height),
        );
      }
      _state = const AdjustState(); // saved: nothing to ask about on the way out
      _markup.reset();
      Navigator.of(context).pop(true);
    } catch (error) {
      if (mounted) {
        ImmichToast.show(
          context: context,
          msg: context.t.editor_copy_failed(error: _failure(error)),
          toastType: ToastType.error,
        );
      }
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final features = ref.watch(mementoFeaturesProvider);
    return EditorScaffold(
      tabs: AdjustTabs(
        active: _tab,
        showCrop: widget.fromCropScreen,
        showAdjust: true,
        enabled: !_saving,
        onSelect: _selectTab,
      ),
      saving: _saving,
      progress: _progress,
      canSave: !_unchanged && !_busy,
      onSave: _save,
      hasChanges: !_unchanged,
      onDiscard: () {
        _state = const AdjustState();
        _markup.reset();
      },
      photo: _buildPreview(),
      tool: (context) => features.adjust ? _buildTool(context) : Text(context.t.editor_adjust_off),
      footer: (context) => Row(
        children: [
          Expanded(
            child: Text(
              context.t.editor_copy_note,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ),
          ImmichTextButton(
            labelText: context.t.reset,
            onPressed: () {
              _update(const AdjustState());
              _markup.reset();
            },
            variant: ImmichVariant.ghost,
            expanded: false,
            disabled: _unchanged || _saving,
          ),
        ],
      ),
    );
  }

  Widget _buildPreview() {
    final shader = _shader;
    final previewShader = _previewShader;
    final preview = _preview;
    if (_failed) {
      return Center(child: Text(context.t.error_loading_image));
    }
    if (shader == null || previewShader == null || preview == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final placing = _placingCorners;
    final shown = _comparing ? const AdjustState() : (placing ? _state.withAngle(0).withPerspective(null) : _state);
    return LayoutBuilder(
      builder: (context, constraints) {
        // The picture fitted into the space (as the crop screen does), keeping its shape: the
        // photo's (straightening keeps it), or perspective's crop's, which may be another (so
        // Markup's layer, in this box, follows it).
        final maxWidth = constraints.maxWidth * 0.9;
        final maxHeight = constraints.maxHeight * 0.95;
        final view = framing(shown.angle, AdjustSize(preview.width, preview.height), shown.perspective);
        final picture = view.toPhoto == null
            ? Size(preview.width.toDouble(), preview.height.toDouble())
            : Size(preview.width * view.scale.$1, preview.height * view.scale.$2);
        final scale = [maxWidth / picture.width, maxHeight / picture.height].reduce((a, b) => a < b ? a : b);
        // Holding the photo shows it as it was, except on the Markup tab, where a finger draws.
        final drawing = _tab == AdjustTab.markup;
        final photo = Center(
          child: GestureDetector(
            onLongPressStart: drawing ? null : (_) => setState(() => _comparing = true),
            onLongPressEnd: drawing ? null : (_) => setState(() => _comparing = false),
            child: SizedBox(
              width: picture.width * scale,
              height: picture.height * scale,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  CustomPaint(
                    painter: _AdjustPainter(
                      shader,
                      previewShader,
                      preview,
                      shaderValues(shown, _filters),
                      shown.angle,
                      shown.perspective,
                    ),
                    foregroundPainter: _tab == AdjustTab.straighten && !placing ? const _GridPainter() : null,
                  ),
                  if (!_comparing && !placing) MarkupLayer(editor: _markup, active: drawing && !_busy),
                ],
              ),
            ),
          ),
        );
        if (!placing) {
          return photo;
        }
        // The corners take every touch around the photo (no holding to compare here).
        final area = constraints.biggest;
        return Stack(
          children: [
            photo,
            Positioned.fill(
              child: PerspectiveCorners(
                photo: Rect.fromCenter(
                  center: area.center(Offset.zero),
                  width: picture.width * scale,
                  height: picture.height * scale,
                ),
                corners: _state.perspective,
                enabled: !_busy,
                onChanged: (corners) => _update(_state.withPerspective(corners)),
              ),
            ),
          ],
        );
      },
    );
  }

  // [context] is inside the editor's dark theme (EditorScaffold).
  Widget _buildTool(BuildContext context) => switch (_tab) {
    AdjustTab.adjust || AdjustTab.crop => _buildSliders(),
    AdjustTab.filters => _buildFilters(),
    AdjustTab.straighten => _buildStraighten(context),
    AdjustTab.markup => MarkupTools(editor: _markup, enabled: !_busy),
  };

  // One slider at a time, chosen from a row of Immich's column buttons.
  Widget _buildSliders() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        LabelledSlider(
          label: _slider.label(context),
          value: _state[_slider] * 100,
          min: -100,
          max: 100,
          format: (v) => v > 0 ? '+${v.round()}' : '${v.round()}',
          onChanged: _busy ? null : (v) => _update(_state.withSlider(_slider, v.roundToDouble() / 100)),
        ),
        AdjustChoiceRow(
          gap: 4,
          choices: [
            AdjustChoice(
              icon: Icons.auto_fix_high,
              label: context.t.editor_auto,
              selected: false,
              enabled: !_busy && _preview != null,
              onPressed: () => unawaited(_auto()),
            ),
            for (final slider in AdjustSlider.values)
              AdjustChoice(
                icon: slider.icon,
                label: slider.label(context),
                selected: slider == _slider,
                onPressed: () => setState(() => _slider = slider),
              ),
          ],
        ),
      ],
    );
  }

  Widget _buildFilters() {
    final filter = _state.filter;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (filter != null)
          LabelledSlider(
            label: context.t.editor_filter_strength,
            value: _state.strength * 100,
            min: 0,
            max: 100,
            format: (v) => '${v.round()}%',
            onChanged: _busy ? null : (v) => _update(_state.withStrength(v.roundToDouble() / 100)),
          ),
        SizedBox(
          height: 112,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              for (final id in [null, ..._filters.map((f) => f.id)])
                _FilterButton(
                  thumbnail: _thumbnails[id],
                  label: id == null ? context.t.none : _filters.firstWhere((f) => f.id == id).label(context),
                  selected: filter == id,
                  onPressed: _busy ? null : () => _update(_state.withFilter(id)),
                ),
            ],
          ),
        ),
      ],
    );
  }

  // Two modes, chosen from a row of Immich's column buttons below, as the sliders are: Straighten
  // (the angle slider) and Perspective (the four corners on the photo; the result shows back in
  // Straighten).
  Widget _buildStraighten(BuildContext context) {
    final description = _perspectiveMode
        ? context.t.editor_perspective_description
        : context.t.editor_straighten_description;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(description, style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant)),
        const SizedBox(height: 8),
        if (!_perspectiveMode)
          LabelledSlider(
            label: context.t.editor_straighten,
            value: _state.angle,
            min: -maxAngle,
            max: maxAngle,
            format: (v) => '${v > 0 ? '+' : ''}${v.toStringAsFixed(1)}°',
            onChanged: _busy ? null : (v) => _update(_state.withAngle((v * 10).roundToDouble() / 10)),
          ),
        Center(
          child: AdjustChoiceRow(
            gap: 4,
            choices: [
              for (final (perspective, icon, label) in [
                (false, Icons.straighten, context.t.editor_straighten),
                (true, Icons.crop_free, context.t.editor_perspective),
              ])
                AdjustChoice(
                  icon: icon,
                  label: label,
                  selected: _perspectiveMode == perspective,
                  enabled: !_saving,
                  onPressed: () => setState(() => _perspectiveMode = perspective),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A Flutter Slider, styled by the app's theme, with its name and value above it (or, with
/// [hideLabel], only the slider, its name read out but not shown: the AI page's brush size).
class LabelledSlider extends StatelessWidget {
  final String label;
  final bool hideLabel;
  final double value;
  final double min;
  final double max;
  // How the value is shown: needed unless [hideLabel].
  final String Function(double value)? format;
  final ValueChanged<double>? onChanged;

  const LabelledSlider({
    super.key,
    required this.label,
    this.hideLabel = false,
    required this.value,
    required this.min,
    required this.max,
    this.format,
    required this.onChanged,
  }) : assert(hideLabel || format != null);

  @override
  Widget build(BuildContext context) {
    final slider = Slider(value: value.clamp(min, max), min: min, max: max, onChanged: onChanged);
    if (hideLabel) {
      return MergeSemantics(
        child: Semantics(label: label, child: slider),
      );
    }
    final style = context.textTheme.displayMedium;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: style),
              Text(format!(value), style: style?.copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
            ],
          ),
        ),
        slider,
      ],
    );
  }
}

class _FilterButton extends StatelessWidget {
  final ui.Image? thumbnail;
  final String label;
  final bool selected;
  final VoidCallback? onPressed;

  const _FilterButton({required this.thumbnail, required this.label, required this.selected, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final image = thumbnail;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: InkWell(
        onTap: onPressed,
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        child: Column(
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                borderRadius: const BorderRadius.all(Radius.circular(12)),
                border: Border.all(color: selected ? context.primaryColor : Colors.transparent, width: 2),
              ),
              clipBehavior: Clip.antiAlias,
              child: image == null ? null : RawImage(image: image, fit: BoxFit.cover),
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: context.textTheme.displayMedium?.copyWith(color: selected ? context.primaryColor : null),
            ),
          ],
        ),
      ),
    );
  }
}

class _AdjustPainter extends CustomPainter {
  final AdjustShader shader;
  final ui.FragmentShader fragmentShader;
  final ui.Image image;
  final ShaderValues values;
  final double degrees;
  final Quad? perspective;

  const _AdjustPainter(this.shader, this.fragmentShader, this.image, this.values, this.degrees, this.perspective);

  @override
  void paint(Canvas canvas, Size size) {
    final output = AdjustSize(size.width.round(), size.height.round());
    shader.configure(
      fragmentShader,
      AdjustRenderJob.whole(values, degrees, image, output, perspective),
      image,
      quality: FilterQuality.medium,
    );
    canvas.drawRect(Offset.zero & size, Paint()..shader = fragmentShader);
  }

  @override
  bool shouldRepaint(_AdjustPainter old) =>
      old.values != values || old.degrees != degrees || old.perspective != perspective || old.image != image;
}

// Thirds, for straightening.
class _GridPainter extends CustomPainter {
  const _GridPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white54
      ..strokeWidth = 0.5;
    for (final third in [1 / 3, 2 / 3]) {
      canvas.drawLine(Offset(size.width * third, 0), Offset(size.width * third, size.height), paint);
      canvas.drawLine(Offset(0, size.height * third), Offset(size.width, size.height * third), paint);
    }
  }

  @override
  bool shouldRepaint(_GridPainter old) => false;
}
