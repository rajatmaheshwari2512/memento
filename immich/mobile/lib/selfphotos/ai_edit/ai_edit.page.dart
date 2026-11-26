// SelfPhotos AI edits for Android.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' show ClientException;
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.page.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.service.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_export.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_native.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_tabs.dart';
import 'package:immich_mobile/selfphotos/adjust/editor_scaffold.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_align.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_area.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_edit.service.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_tools.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';

/// The AI Edit button's name, also the page's title.
const aiEditLabel = 'AI Edit';

final _log = Logger('AiEditPage');

/// Reads the photo upright for a first highlighted edit (ai_area.dart uprightPhoto).
final aiUprightPhotoProvider = Provider(
  (ref) =>
      (RemoteAsset asset, AiAreaSettings area) => uprightPhoto(asset, area),
);

/// Lines a highlighted edit's result up with the photo (ai_area.dart alignFor).
final aiAlignProvider = Provider((ref) => alignFor);

final aiPasteOntoProvider = Provider((ref) => pasteOnto);

/// Pastes a highlighted edit's area onto the photo at full size, at Save (ai_area.dart pasteBack).
final aiPasteBackProvider = Provider(
  (ref) =>
      (
        RemoteAsset asset,
        ui.Image result,
        List<AiStroke> strokes,
        AiAreaSettings area,
        AiAlignment alignment, {
        void Function(double done)? onProgress,
      }) => pasteBack(asset, result, strokes, area, alignment, onProgress: onProgress),
);

/// The photo is too large for AI edits.
String aiTooLarge(BuildContext context, AiToolkit kit) =>
    context.t.editor_ai_too_large(megapixels: kit.maxMegapixels, pixels: kit.maxLongSide);

/// A failure in AI Edit as a message to show (inside editor_ai_failed).
String aiEditFailure(BuildContext context, Object error, AiToolkit kit) => switch (error) {
  AiEditException(code: aiEditPhotoTooLarge) => aiTooLarge(context, kit),
  AiEditException(fromService: true, :final message) => message,
  AiEditException(code: aiEditImageUnavailable) => context.t.error_loading_image,
  ClientException() || SocketException() || TlsException() || TimeoutException() => context.t.errors.unable_to_connect,
  AdjustNativeException(code: 'unreadable') => context.t.error_loading_image,
  AdjustNativeException(code: 'too-large') || OutOfMemoryError() => context.t.editor_ai_too_large_device,
  NeedsOriginalException() => context.t.editor_ai_needs_original,
  _ => context.t.errors.something_went_wrong,
};

enum _Phase { idle, working, saving }

class _Run {
  final List<AiTool> tools;
  final String prompt;
  final String label;
  final List<AiStroke> highlight;
  final _Result? from;

  const _Run(this.tools, this.prompt, this.label, this.highlight, this.from);
}

class _Result {
  final String editId;
  final String label;
  final ui.Image image;
  final bool marked;
  final List<AiStroke>? area;
  final AiAlignment alignment;
  final ui.Image shown;

  const _Result(this.editId, this.label, this.image, this.marked, this.area, this.alignment, this.shown);

  _Result whole() {
    _freePaste();
    return _Result(editId, label, image, true, null, AiAlignment.identity, image);
  }

  void dispose() {
    _freePaste();
    image.dispose();
  }

  void _freePaste() {
    if (shown != image) {
      shown.dispose();
    }
  }
}

class _Refused {
  final _Result result;
  final AiRefusal reason;
  final _Run? run;

  const _Refused(this.result, this.reason, this.run);
}

String _refusedNote(BuildContext context, _Refused kept) => kept.run == null
    ? context.t.editor_ai_save_paste_failed
    : kept.reason == AiRefusal.shape
    ? context.t.editor_ai_shape_note
    : context.t.editor_ai_paste_failed;

class _Unloaded {
  final String editId;
  final _Run run;
  final bool again;

  const _Unloaded(this.editId, this.run, {required this.again});
}

class AiEditPage extends ConsumerStatefulWidget {
  final RemoteAsset asset;

  const AiEditPage({super.key, required this.asset});

  @override
  ConsumerState<AiEditPage> createState() => _AiEditPageState();
}

class _AiEditPageState extends ConsumerState<AiEditPage> {
  late final AiEditService _service = ref.read(aiEditServiceProvider);

  final _words = TextEditingController();
  final _focus = FocusNode();
  AiToolkit? _kit;
  ui.Image? _preview;
  bool _failed = false;
  List<AiStroke> _strokes = const [];
  double _brushRadius = 0.04;
  List<AiTool> _picked = const [];
  _Result? _result;
  bool _refining = false;
  _Phase _phase = _Phase.idle;
  double _progress = 0;
  AiEditUsage? _usage;
  String? _error;
  _Refused? _refused;
  _Unloaded? _unloaded;
  bool _comparing = false;
  final _groupsOpen = <AiGroup>{};
  bool _highlightOpen = false;

  MementoFlags get _features => ref.read(mementoFeaturesProvider);
  bool get _tooLarge => _kit?.tooLargeForAi(widget.asset.width, widget.asset.height) ?? false;
  bool get _composing =>
      !_tooLarge &&
      _kit != null &&
      _preview != null &&
      _features.gemini &&
      _phase == _Phase.idle &&
      _refused == null &&
      _unloaded == null &&
      (_result == null || _refining);
  bool get _highlighted => _features.geminiTools && _strokes.isNotEmpty;
  bool get _wholePhoto => _picked.any((tool) => tool.highlight == AiHighlight.ignored);
  AiTool? get _asking => _picked.where((tool) => tool.ask).firstOrNull;
  bool get _canGenerate => _composing && canGenerate(_picked, _words.text, highlighted: _highlighted);

  @override
  void initState() {
    super.initState();
    _words.addListener(() => setState(() {}));
    unawaited(_load());
  }

  @override
  void dispose() {
    final result = _result;
    if (result != null) {
      if (_phase != _Phase.saving) {
        _discardOnServer(result.editId);
      }
      result.dispose();
    }
    _dropRefused();
    final unloaded = _unloaded;
    if (unloaded != null) {
      _discardOnServer(unloaded.editId);
    }
    _preview?.dispose();
    _words.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    unawaited(
      _service
          .usage()
          .then((usage) => mounted ? setState(() => _usage = usage) : null)
          .catchError((_) {}),
    );
    try {
      final (_, preview) = await (
        AiToolkit.load().then((kit) {
          if (mounted) {
            setState(() => _kit = kit);
          }
          return kit;
        }),
        const AdjustService().preview(widget.asset),
      ).wait;
      if (!mounted) {
        preview.dispose();
        return;
      }
      setState(() => _preview = preview);
    } catch (error, stack) {
      _log.warning("Loading the photo's preview failed", error, stack);
      if (mounted) {
        setState(() => _failed = true);
      }
    }
  }

  static Future<ui.Image> _decode(Uint8List bytes) async {
    final codec = await ui.instantiateImageCodec(bytes);
    try {
      return (await codec.getNextFrame()).image;
    } finally {
      codec.dispose();
    }
  }

  Future<void> _run(_Run run) async {
    final kit = _kit;
    final preview = _preview;
    if (kit == null || preview == null || _phase != _Phase.idle) {
      return;
    }
    FocusScope.of(context).unfocus();
    _dropRefused();
    setState(() {
      _error = null;
      _phase = _Phase.working;
    });
    try {
      Uint8List? mark;
      Uint8List? photo;
      if (run.highlight.isNotEmpty && run.from != null) {
        mark = await markedCopy(run.from!.shown, run.highlight, kit.area);
      } else if (run.highlight.isNotEmpty) {
        final upright = await ref.read(aiUprightPhotoProvider)(widget.asset, kit.area);
        try {
          mark = await markedCopy(upright.image, run.highlight, kit.area);
        } finally {
          upright.image.dispose();
        }
        photo = upright.jpeg;
      }
      if (!mounted) {
        return;
      }
      final created = await _service.create(
        widget.asset.id,
        run.prompt,
        fromEditId: run.from?.editId,
        tools: [for (final tool in run.tools) tool.id],
        mark: mark,
        photo: photo,
      );
      if (mounted) {
        setState(() => _usage = created.usage ?? _usage);
      }
      await _show(created.editId, run, kit, preview);
    } catch (error, stack) {
      _log.warning('Making the edit failed', error, stack);
      if (mounted) {
        setState(() {
          if (error is AiEditException && error.usage != null) {
            _usage = error.usage;
          }
          _error = aiEditFailure(context, error, kit);
        });
      }
    } finally {
      if (mounted) {
        setState(() => _phase = _Phase.idle);
      }
    }
  }

  Future<void> _show(String editId, _Run run, AiToolkit kit, ui.Image preview, {bool again = false}) async {
    if (_discardIfLeft(editId)) {
      return;
    }
    final ui.Image image;
    try {
      image = await _decode(await _service.image(editId));
    } catch (error, stack) {
      _log.warning("Loading the edit's picture failed", error, stack);
      if (!_discardIfLeft(editId)) {
        setState(() => _unloaded = _Unloaded(editId, run, again: again));
      }
      return;
    }
    final whole = _Result(editId, run.label, image, run.highlight.isNotEmpty, null, AiAlignment.identity, image);
    if (_discardIfLeft(editId, whole)) {
      return;
    }
    final pasted =
        run.highlight.isNotEmpty &&
        run.tools.every((tool) => tool.pasteBack) &&
        (run.from == null || run.from!.area != null);
    var made = whole;
    if (pasted) {
      final area = [...?run.from?.area, ...run.highlight];
      try {
        final alignment = await ref.read(aiAlignProvider)(preview, image, area, kit.area);
        unawaited(_service.reportAlignment(editId, _report(alignment, refused: false)));
        final shown = await ref.read(aiPasteOntoProvider)(preview, image, area, kit.area, alignment);
        made = _Result(editId, run.label, image, true, area, alignment, shown);
      } catch (error, stack) {
        _log.warning('Pasting the highlighted area failed', error, stack);
        final alignment = error is ShapeChangedException ? error.alignment : null;
        if (alignment != null) {
          unawaited(_service.reportAlignment(editId, _report(alignment, refused: true)));
        }
        if (!_discardIfLeft(editId, whole)) {
          setState(() => _refused = _Refused(whole, refusalOf(error), run));
        }
        return;
      }
    }
    if (!_discardIfLeft(editId, made)) {
      _install(made);
    }
  }

  bool _discardIfLeft(String editId, [_Result? made]) {
    if (mounted) {
      return false;
    }
    made?.dispose();
    _discardOnServer(editId);
    return true;
  }

  void _install(_Result made) {
    final previous = _result;
    setState(() {
      _result = made;
      _strokes = const [];
      _words.clear();
      _picked = const [];
      _refining = false;
    });
    if (previous != null) {
      previous.dispose();
      _discardOnServer(previous.editId);
    }
  }

  Future<void> _loadAgain() async {
    final kept = _unloaded;
    final kit = _kit;
    final preview = _preview;
    if (kept == null || kit == null || preview == null || _phase != _Phase.idle) {
      return;
    }
    setState(() {
      _unloaded = null;
      _error = null;
      _phase = _Phase.working;
    });
    try {
      await _show(kept.editId, kept.run, kit, preview, again: true);
    } finally {
      if (mounted) {
        setState(() => _phase = _Phase.idle);
      }
    }
  }

  void _discardUnloaded() {
    final kept = _unloaded;
    if (kept == null || _phase != _Phase.idle) {
      return;
    }
    setState(() {
      _unloaded = null;
      _error = null;
    });
    _discardOnServer(kept.editId);
  }

  static Map<String, Object> _report(AiAlignment a, {required bool refused}) => {
    'scaleX': a.scaleX,
    'offsetX': a.offsetX,
    'scaleY': a.scaleY,
    'offsetY': a.offsetY,
    'error': a.error,
    'patches': a.patches,
    'refused': refused,
  };

  void _useWhole() {
    final kept = _refused;
    if (kept == null || _phase != _Phase.idle) {
      return;
    }
    _refused = null;
    _install(kept.result.whole());
  }

  void _tryAgain() {
    final kept = _refused;
    if (kept == null || _phase != _Phase.idle) {
      return;
    }
    final again = kept.run;
    if (again != null) {
      setState(_dropRefused);
      unawaited(_run(again));
      return;
    }
    setState(() {
      _refused = null;
      _result = kept.result;
    });
    unawaited(_save());
  }

  void _dropRefused() {
    final kept = _refused;
    if (kept != null) {
      _refused = null;
      kept.result.dispose();
      _discardOnServer(kept.result.editId);
    }
  }

  void _discardOnServer(String editId) => unawaited(_service.discard(editId).catchError((_) {}));

  String? _blocked(AiToolkit kit, AiTool tool) => switch (kit.blocked(tool, _picked, highlighted: _highlighted)) {
    AiBlock.needsHighlight => context.t.editor_ai_needs_highlight,
    AiBlock.wholeOnly => context.t.editor_ai_whole_only,
    AiBlock.upTo => context.t.editor_ai_up_to(count: kit.maxSelected),
    null => null,
  };

  void _pick(AiTool tool) {
    final kit = _kit;
    if (kit == null) {
      return;
    }
    final reason = _blocked(kit, tool);
    if (reason != null) {
      ImmichToast.show(context: context, msg: reason);
      return;
    }
    setState(() => _picked = kit.toggle(_picked, tool));
    if (_asking != null) {
      _focus.requestFocus();
    }
  }

  void _generate() {
    if (!_canGenerate) {
      return;
    }
    final text = _words.text.trim();
    final tools = _picked;
    unawaited(
      _run(
        _Run(
          tools,
          combinedInstruction(tools, text),
          combinedLabel(tools, text, (tool) => tool.label(context)),
          _features.geminiTools && !_wholePhoto ? _strokes : const [],
          _refining ? _result : null,
        ),
      ),
    );
  }

  Future<void> _save() async {
    final result = _result;
    final kit = _kit;
    if (result == null || kit == null || _phase != _Phase.idle) {
      return;
    }
    setState(() {
      _error = null;
      _phase = _Phase.saving;
      _progress = 0;
    });
    final area = result.area;
    AdjustExport? copy;
    if (area != null) {
      try {
        copy = await ref.read(aiPasteBackProvider)(
          widget.asset,
          result.image,
          area,
          kit.area,
          result.alignment,
          onProgress: (done) => mounted ? setState(() => _progress = done) : null,
        );
      } catch (error, stack) {
        _log.warning('Pasting the highlighted area at full size failed', error, stack);
        if (mounted) {
          setState(() {
            if (identical(_result, result) && _refused == null && _unloaded == null) {
              _result = null;
              _refused = _Refused(result, AiRefusal.failed, null);
            } else {
              _error = aiEditFailure(context, error, kit);
            }
            _phase = _Phase.idle;
          });
        }
        return;
      }
    }
    try {
      if (copy == null) {
        await _service.save(result.editId, whole: result.marked);
      } else {
        await _service.saveArea(result.editId, copy.bytes, copy.mime);
      }
      if (!mounted) {
        return;
      }
      ImmichToast.show(context: context, msg: context.t.editor_copy_saved, toastType: ToastType.success);
      setState(() => _result = null);
      result.dispose();
      Navigator.of(context).pop(true);
    } catch (error, stack) {
      _log.warning('Saving the edit failed', error, stack);
      if (mounted) {
        setState(() {
          _error = aiEditFailure(context, error, kit);
          _phase = _Phase.idle;
        });
      }
    }
  }

  void _discard() {
    final result = _result;
    if (result == null) {
      return;
    }
    setState(() {
      _result = null;
      _refining = false;
      _error = null;
    });
    result.dispose();
    _discardOnServer(result.editId);
  }

  bool get _hasChanges =>
      _phase == _Phase.working || _result != null || _refused != null || _unloaded != null || _strokes.isNotEmpty;

  static TextStyle? _muted(BuildContext context) =>
      context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);

  static Widget _editsLeft(BuildContext context, AiEditUsage usage) =>
      Text(context.t.editor_ai_left_today(count: usage.editsLeft), style: _muted(context));

  @override
  Widget build(BuildContext context) {
    final features = ref.watch(mementoFeaturesProvider);
    final kit = _kit;
    final usage = _usage;
    return EditorScaffold(
      title: aiEditLabel,
      compact: true,
      saving: _phase == _Phase.saving,
      progress: _progress,
      canSave: _result != null && _phase == _Phase.idle,
      onSave: _save,
      hasChanges: _hasChanges,
      onDiscard: () {
        _strokes = const [];
      },
      photo: _buildPhoto(kit),
      tool: (context) => !features.gemini
          ? Text(context.t.editor_ai_off)
          : _tooLarge
          ? _notice(context, aiTooLarge(context, kit!), danger: false)
          : _buildTool(context, kit, features),
      footer: (context) => !features.gemini || usage == null || _result == null || _refining
          ? const SizedBox.shrink()
          : Align(alignment: Alignment.centerLeft, child: _editsLeft(context, usage)),
    );
  }

  Widget _buildPhoto(AiToolkit? kit) {
    final preview = _preview;
    if (_failed) {
      return Center(child: Text(context.t.error_loading_image));
    }
    if (preview == null || kit == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final result = _result;
    final shown = _comparing ? preview : (_refused?.result.image ?? result?.shown ?? preview);
    final brushing = _composing && _features.geminiTools && !_wholePhoto;
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxWidth = constraints.maxWidth * 0.9;
        final maxHeight = constraints.maxHeight * 0.95;
        final scale = [maxWidth / shown.width, maxHeight / shown.height].reduce((a, b) => a < b ? a : b);
        final box = Size(shown.width * scale, shown.height * scale);
        Offset at(Offset local) =>
            Offset((local.dx / box.width).clamp(0.0, 1.0), (local.dy / box.height).clamp(0.0, 1.0));
        return Center(
          child: SizedBox.fromSize(
            size: box,
            child: Stack(
              fit: StackFit.expand,
              children: [
                RawImage(image: shown, fit: BoxFit.fill),
                if (!_comparing)
                  Opacity(
                    opacity: kit.area.tintAlpha,
                    child: CustomPaint(painter: _StrokesPainter(_strokes, kit.area.tintColor)),
                  ),
                if (brushing)
                  GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onPanStart: (details) => setState(
                      () => _strokes = [
                        ..._strokes,
                        AiStroke([at(details.localPosition)], _brushRadius),
                      ],
                    ),
                    onPanUpdate: (details) {
                      final last = _strokes.last;
                      final point = at(details.localPosition);
                      if ((point - last.points.last).distance > 0.002) {
                        setState(
                          () => _strokes = [
                            ..._strokes.sublist(0, _strokes.length - 1),
                            AiStroke([...last.points, point], last.radius),
                          ],
                        );
                      }
                    },
                  ),
                if (_phase == _Phase.working)
                  ColoredBox(
                    color: Colors.black54,
                    child: Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const CircularProgressIndicator(),
                          const SizedBox(height: 12),
                          Text(context.t.editor_ai_editing, style: const TextStyle(color: Colors.white)),
                        ],
                      ),
                    ),
                  ),
                if ((result != null || _refused != null) && _phase != _Phase.working)
                  Positioned(
                    right: 4,
                    bottom: 4,
                    child: GestureDetector(
                      onTapDown: (_) => setState(() => _comparing = true),
                      onTapUp: (_) => setState(() => _comparing = false),
                      onTapCancel: () => setState(() => _comparing = false),
                      child: Tooltip(
                        message: context.t.editor_compare,
                        child: const Padding(
                          padding: EdgeInsets.all(8),
                          child: Icon(Icons.compare, color: Colors.white),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _notice(BuildContext context, String text, {required bool danger, Widget? action}) {
    final colors = context.colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: danger ? colors.errorContainer : colors.tertiaryContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: TextStyle(color: danger ? colors.onErrorContainer : colors.onTertiaryContainer)),
          if (action != null) ...[const SizedBox(height: 8), action],
        ],
      ),
    );
  }

  Widget _buildTool(BuildContext context, AiToolkit? kit, MementoFlags features) {
    final result = _result;
    final muted = _muted(context);
    final refused = _refused;
    final unloaded = _unloaded;
    final notices = [
      if (_error != null) _notice(context, context.t.editor_ai_failed(error: _error!), danger: true),
      if (refused != null)
        _notice(
          context,
          _refusedNote(context, refused),
          danger: false,
          action: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton(
                onPressed: _phase == _Phase.idle ? _useWhole : null,
                child: Text(context.t.editor_ai_use_whole),
              ),
              OutlinedButton(
                onPressed: _phase == _Phase.idle ? _tryAgain : null,
                child: Text(context.t.editor_ai_try_again),
              ),
            ],
          ),
        ),
      if (unloaded != null)
        _notice(
          context,
          unloaded.again ? context.t.editor_ai_load_failed_again : context.t.editor_ai_load_failed,
          danger: false,
          action: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton(
                onPressed: _phase == _Phase.idle ? () => unawaited(_loadAgain()) : null,
                child: Text(context.t.editor_ai_load_again),
              ),
              OutlinedButton(
                onPressed: _phase == _Phase.idle ? _discardUnloaded : null,
                child: Text(context.t.editor_ai_discard),
              ),
            ],
          ),
        ),
    ];
    if (result != null && !_refining) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          ...notices,
          Text('“${result.label}”', style: context.textTheme.bodyMedium),
          const SizedBox(height: 4),
          Text(result.area != null ? context.t.editor_ai_area_note : context.t.editor_ai_whole_note, style: muted),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: _phase == _Phase.idle ? _discard : null,
                icon: const Icon(Icons.delete_outline),
                label: Text(context.t.editor_ai_discard),
              ),
              OutlinedButton.icon(
                onPressed: _phase == _Phase.idle ? () => setState(() => _refining = true) : null,
                icon: const Icon(Icons.edit_outlined),
                label: Text(context.t.editor_ai_edit_more),
              ),
            ],
          ),
        ],
      );
    }
    final asking = _asking;
    final limit = asking != null ? maxAskWords : maxWords;
    final usage = _usage;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        ...notices,
        if (_refining) Text(context.t.editor_ai_edit_more_note, style: muted),
        if (features.geminiTools && kit != null) ...[
          for (final group in AiGroup.values) _buildGroup(context, kit, group),
          _buildHighlight(context, muted),
        ],
        if (asking != null)
          Row(
            children: [
              Expanded(child: Text(asking.label(context), style: context.textTheme.titleSmall)),
              TextButton(onPressed: () => setState(() => _picked = const []), child: Text(context.t.cancel)),
            ],
          ),
        TextField(
          controller: _words,
          focusNode: _focus,
          enabled: _composing,
          minLines: 1,
          maxLines: 3,
          maxLength: limit,
          textInputAction: TextInputAction.send,
          onSubmitted: (_) => _words.text.trim().isEmpty ? null : _generate(),
          decoration: InputDecoration(
            border: const OutlineInputBorder(),
            isDense: true,
            hintText:
                asking?.askHint(context) ??
                (features.geminiTools ? context.t.editor_ai_describe_or_brush : context.t.editor_ai_describe),
            counterText: '',
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Row(
                children: [
                  Text('${_words.text.characters.length}/$limit', style: muted),
                  if (usage != null) ...[Text(' · ', style: muted), Flexible(child: _editsLeft(context, usage))],
                ],
              ),
            ),
            FilledButton.icon(
              onPressed: _canGenerate ? _generate : null,
              icon: _phase == _Phase.working
                  ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.auto_awesome_outlined),
              label: Text(_refining ? context.t.editor_ai_edit_result : context.t.editor_ai_generate),
            ),
          ],
        ),
      ],
    );
  }

  static Widget _accordion({
    required Key key,
    required bool open,
    required ValueChanged<bool> onChanged,
    required Widget title,
    Widget? subtitle,
    Widget? trailing,
    required List<Widget> children,
  }) => ListTileTheme.merge(
    key: key,
    horizontalTitleGap: 8,
    minLeadingWidth: 24,
    child: ExpansionTile(
      initiallyExpanded: open,
      onExpansionChanged: onChanged,
      controlAffinity: ListTileControlAffinity.leading,
      tilePadding: EdgeInsets.zero,
      minTileHeight: 48,
      visualDensity: VisualDensity.compact,
      shape: const Border(),
      collapsedShape: const Border(),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      title: title,
      subtitle: subtitle,
      trailing: trailing,
      children: children,
    ),
  );

  Widget _buildGroup(BuildContext context, AiToolkit kit, AiGroup group) {
    final tools = [
      for (final tool in kit.tools)
        if (tool.group == group) tool,
    ];
    final picked = [
      for (final tool in _picked)
        if (tool.group == group) tool.label(context),
    ];
    final name = switch (group) {
      AiGroup.fix => context.t.editor_ai_fixes,
      AiGroup.style => context.t.editor_ai_styles,
    };
    return _accordion(
      key: ValueKey(group),
      open: _groupsOpen.contains(group),
      onChanged: (open) => open ? _groupsOpen.add(group) : _groupsOpen.remove(group),
      title: Text(
        picked.isEmpty ? name : '$name · ${picked.join(', ')}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: context.textTheme.titleSmall,
      ),
      children: [
        AdjustChoiceRow(
          gap: 2,
          lineUp: true,
          choices: [
            for (final tool in tools)
              AdjustChoice(
                icon: tool.icon,
                label: tool.label(context),
                selected: _picked.contains(tool),
                enabled: _composing,
                onPressed: () => _pick(tool),
              ),
          ],
        ),
      ],
    );
  }

  Widget _buildHighlight(BuildContext context, TextStyle? muted) {
    final canUndo = _composing && _strokes.isNotEmpty;
    return _accordion(
      key: const ValueKey('highlight'),
      open: _highlightOpen,
      onChanged: (open) => _highlightOpen = open,
      title: Text(context.t.editor_ai_highlight, style: context.textTheme.titleSmall),
      subtitle: _wholePhoto ? Text(context.t.editor_ai_brush_whole_photo, style: muted) : null,
      trailing: GestureDetector(
        onTap: () {},
        excludeFromSemantics: true,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              tooltip: context.t.undo,
              onPressed: canUndo ? () => setState(() => _strokes = _strokes.sublist(0, _strokes.length - 1)) : null,
              icon: const Icon(Icons.undo),
            ),
            IconButton(
              tooltip: context.t.clear,
              onPressed: canUndo ? () => setState(() => _strokes = const []) : null,
              icon: const Icon(Icons.delete_outline),
            ),
          ],
        ),
      ),
      children: [
        Text(context.t.editor_ai_highlight_description, style: muted),
        LabelledSlider(
          label: context.t.editor_ai_brush_size,
          hideLabel: true,
          value: _brushRadius * 100,
          min: 1,
          max: 10,
          onChanged: _composing ? (v) => setState(() => _brushRadius = v.roundToDouble() / 100) : null,
        ),
      ],
    );
  }
}

class _StrokesPainter extends CustomPainter {
  final List<AiStroke> strokes;
  final Color colour;

  const _StrokesPainter(this.strokes, this.colour);

  @override
  void paint(Canvas canvas, Size size) => paintStrokes(canvas, strokes, size, colour);

  @override
  bool shouldRepaint(_StrokesPainter old) => old.strokes != strokes || old.colour != colour;
}
