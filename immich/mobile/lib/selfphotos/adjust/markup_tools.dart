// SelfPhotos Adjust's Markup tab for Android.
import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_tabs.dart';
import 'package:immich_mobile/selfphotos/adjust/markup.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_editor.dart';

extension on MarkupTool {
  IconData get icon => switch (this) {
    MarkupTool.pen => Icons.edit_outlined,
    MarkupTool.highlighter => Icons.border_color_outlined,
    MarkupTool.text => Icons.text_fields,
    MarkupTool.shapes => Icons.category_outlined,
  };

  String label(BuildContext context) => switch (this) {
    MarkupTool.pen => context.t.editor_markup_pen,
    MarkupTool.highlighter => context.t.editor_markup_highlighter,
    MarkupTool.text => context.t.editor_markup_text,
    MarkupTool.shapes => context.t.editor_markup_shapes,
  };
}

extension on MarkupShapeKind {
  IconData get icon => switch (this) {
    MarkupShapeKind.arrow => Icons.north_east,
    MarkupShapeKind.box => Icons.crop_square,
    MarkupShapeKind.circle => Icons.circle_outlined,
  };

  String label(BuildContext context) => switch (this) {
    MarkupShapeKind.arrow => context.t.editor_markup_arrow,
    MarkupShapeKind.box => context.t.editor_markup_box,
    MarkupShapeKind.circle => context.t.editor_markup_circle,
  };
}

class MarkupTools extends StatefulWidget {
  final MarkupEditor editor;
  final bool enabled;

  const MarkupTools({super.key, required this.editor, required this.enabled});

  @override
  State<MarkupTools> createState() => _MarkupToolsState();
}

class _MarkupToolsState extends State<MarkupTools> {
  static const _dots = [6.0, 10.0, 16.0];

  final _field = TextEditingController();
  final _focus = FocusNode();
  int _selection = -1;
  int _newText = 0;

  MarkupEditor get _editor => widget.editor;

  @override
  void initState() {
    super.initState();
    _newText = _editor.newText;
    _editor.addListener(_follow);
    _follow();
  }

  @override
  void didUpdateWidget(MarkupTools old) {
    super.didUpdateWidget(old);
    if (old.editor != widget.editor) {
      old.editor.removeListener(_follow);
      widget.editor.addListener(_follow);
    }
  }

  @override
  void dispose() {
    _editor.removeListener(_follow);
    _field.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _follow() {
    if (_editor.selection != _selection) {
      _selection = _editor.selection;
      _field.text = _editor.selectedText?.text ?? '';
    }
    if (_editor.newText != _newText) {
      _newText = _editor.newText;
      WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? _focus.requestFocus() : null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = _editor.config;
    if (config == null) {
      return const SizedBox.shrink();
    }
    final enabled = widget.enabled;
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final heading = context.textTheme.displayMedium;
    final selected = _editor.tool == MarkupTool.text ? _editor.selectedText : null;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                _editor.tool == MarkupTool.text
                    ? context.t.editor_markup_text_description
                    : context.t.editor_markup_draw_description,
                style: muted,
              ),
            ),
            IconButton(
              tooltip: context.t.undo,
              onPressed: enabled && _editor.canUndo ? _editor.undo : null,
              icon: const Icon(Icons.undo),
            ),
            IconButton(
              tooltip: context.t.editor_markup_redo,
              onPressed: enabled && _editor.canRedo ? _editor.redo : null,
              icon: const Icon(Icons.redo),
            ),
            IconButton(
              tooltip: context.t.clear,
              onPressed: enabled && !_editor.isEmpty ? _editor.clear : null,
              icon: const Icon(Icons.delete_outline),
            ),
          ],
        ),
        AdjustChoiceRow(
          gap: 4,
          choices: [
            for (final tool in MarkupTool.values)
              AdjustChoice(
                icon: tool.icon,
                label: tool.label(context),
                selected: tool == _editor.tool,
                enabled: enabled,
                onPressed: () => _editor.tool = tool,
              ),
          ],
        ),
        if (_editor.tool == MarkupTool.shapes)
          Wrap(
            spacing: 8,
            children: [
              for (final shape in MarkupShapeKind.values)
                ChoiceChip(
                  avatar: Icon(shape.icon, size: 18),
                  label: Text(shape.label(context)),
                  selected: shape == _editor.shape,
                  showCheckmark: false,
                  onSelected: enabled ? (_) => _editor.shape = shape : null,
                ),
            ],
          ),
        if (selected != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _field,
                    focusNode: _focus,
                    enabled: enabled,
                    maxLength: config.maxLength,
                    textInputAction: TextInputAction.done,
                    decoration: InputDecoration(
                      hintText: context.t.editor_markup_text_placeholder,
                      counterText: '',
                      isDense: true,
                    ),
                    onChanged: _editor.setText,
                    onSubmitted: (_) => _editor.select(null),
                  ),
                ),
                IconButton(
                  tooltip: context.t.delete,
                  onPressed: enabled ? _editor.deleteSelected : null,
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ),
          ),
        const SizedBox(height: 8),
        Text(context.t.color, style: heading),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 8,
          children: [
            for (final (index, MarkupColour(:fill)) in config.colours.indexed)
              _Choice(
                label: '${context.t.color} ${index + 1}',
                selected: fill == _editor.colour,
                enabled: enabled,
                onPressed: () => _editor.colour = fill,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: fill,
                    shape: BoxShape.circle,
                    border: Border.all(color: Colors.white30),
                  ),
                  child: const SizedBox.square(dimension: 28),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Text(context.t.size, style: heading),
        const SizedBox(height: 8),
        Row(
          children: [
            for (final (index, dot) in _dots.indexed)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: _Choice(
                  label: '${context.t.size} ${index + 1}',
                  selected: index == _editor.size,
                  enabled: enabled,
                  onPressed: () => _editor.size = index,
                  child: SizedBox.square(
                    dimension: 28,
                    child: Center(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: index == _editor.size ? context.primaryColor : context.colorScheme.onSurface,
                          shape: BoxShape.circle,
                        ),
                        child: SizedBox.square(dimension: dot),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _Choice extends StatelessWidget {
  final String label;
  final bool selected;
  final bool enabled;
  final VoidCallback onPressed;
  final Widget child;

  const _Choice({
    required this.label,
    required this.selected,
    required this.enabled,
    required this.onPressed,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      selected: selected,
      button: true,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: enabled ? onPressed : null,
        child: Container(
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: selected ? context.primaryColor : Colors.transparent, width: 2),
          ),
          child: Opacity(opacity: enabled ? 1 : 0.4, child: child),
        ),
      ),
    );
  }
}
