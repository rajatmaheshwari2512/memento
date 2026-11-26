// SelfPhotos Adjust's Markup for Android.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:immich_mobile/selfphotos/adjust/markup.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_editor.dart';

class MarkupLayer extends StatefulWidget {
  final MarkupEditor editor;

  /// The Markup tab is open: touches draw.
  final bool active;

  const MarkupLayer({super.key, required this.editor, required this.active});

  @override
  State<MarkupLayer> createState() => _MarkupLayerState();
}

sealed class _Drag {}

class _Line extends _Drag {
  MarkupLine line;

  _Line(this.line);
}

class _Shape extends _Drag {
  final Offset start;
  MarkupShape? shape;

  _Shape(this.start);
}

sealed class _TextDrag extends _Drag {
  final int index;
  final MarkupText item;
  MarkupItem shown;
  bool moved = false;

  _TextDrag(this.index, this.item) : shown = item;
}

class _Move extends _TextDrag {
  final Offset start;

  _Move(super.index, super.item, this.start);
}

class _Resize extends _TextDrag {
  final double distance;

  _Resize(super.index, super.item, this.distance);
}

class _Pinch extends _TextDrag {
  _Pinch(super.index, super.item);
}

class _MarkupLayerState extends State<MarkupLayer> {
  static const _textPadding = 8.0;
  static const _handle = 24.0;

  _Drag? _drag;
  final _moves = ValueNotifier(0);
  int? _pointer;
  Offset? _down;

  MarkupEditor get _editor => widget.editor;

  @override
  void didUpdateWidget(MarkupLayer old) {
    super.didUpdateWidget(old);
    if (old.active && !widget.active) {
      _pointer = null;
      _drag = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          _finish();
        }
      });
    }
  }

  @override
  void dispose() {
    _moves.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final config = _editor.config;
    if (config == null) {
      return const SizedBox.shrink();
    }
    final changes = Listenable.merge([_editor, _moves]);
    return RepaintBoundary(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final size = constraints.biggest;
          return Stack(
            fit: StackFit.expand,
            children: [
              CustomPaint(
                painter: _MarkupPainter(
                  items: () => _editor.items,
                  selection: () => _selectionBox(size, config),
                  config: config,
                  active: widget.active,
                  repaint: changes,
                ),
              ),
              if (widget.active)
                Listener(
                  behavior: HitTestBehavior.opaque,
                  onPointerDown: (event) => _pointerDown(event, size, config),
                  onPointerMove: (event) => _pointerMove(event, size, config),
                  onPointerUp: _pointerEnd,
                  onPointerCancel: _pointerEnd,
                  child: _editor.tool == MarkupTool.text
                      ? GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          dragStartBehavior: DragStartBehavior.down,
                          onTapUp: (details) => _tap(details.localPosition, size, config),
                          onScaleStart: (details) => _start(details, size, config),
                          onScaleUpdate: (details) => _update(details, size, config),
                          onScaleEnd: (_) => _finish(),
                        )
                      : null,
                ),
              if (widget.active)
                ListenableBuilder(
                  listenable: changes,
                  builder: (context, _) {
                    final box = _selectionBox(size, config);
                    return Positioned(
                      left: (box?.right ?? 0) - _handle / 2,
                      top: (box?.bottom ?? 0) - _handle / 2,
                      width: box == null ? 0 : _handle,
                      height: box == null ? 0 : _handle,
                      child: IgnorePointer(
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            color: Theme.of(context).colorScheme.primary,
                            shape: BoxShape.circle,
                            border: Border.all(color: Colors.white, width: 2),
                            boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 2)],
                          ),
                        ),
                      ),
                    );
                  },
                ),
            ],
          );
        },
      ),
    );
  }

  Rect? _selectionBox(Size size, MarkupConfig config) {
    final item = widget.active ? _editor.selectedText : null;
    return item == null ? null : _boxOf(item, size, config);
  }

  void _change(bool first, VoidCallback change) {
    if (first) {
      change();
    } else {
      _editor.hold(change);
      _moves.value++;
    }
  }

  bool _there(int index, MarkupItem? item) {
    final items = _editor.items;
    return item != null && index >= 0 && index < items.length && identical(items[index], item);
  }

  Rect _boxOf(MarkupText item, Size size, MarkupConfig config) {
    final box = markupTextBox(item, size, config);
    final width = box.width > box.height / 2 ? box.width : box.height / 2;
    return Rect.fromCenter(center: box.center, width: width + _textPadding * 2, height: box.height + _textPadding * 2);
  }

  Offset _point(Offset local, Size size) =>
      Offset((local.dx / size.width).clamp(0.0, 1.0), (local.dy / size.height).clamp(0.0, 1.0));

  int? _textAt(Offset local, Size size, MarkupConfig config) {
    final items = _editor.items;
    for (var index = items.length - 1; index >= 0; index--) {
      final item = items[index];
      if (item is MarkupText && _boxOf(item, size, config).contains(local)) {
        return index;
      }
    }
    return null;
  }

  double _width(MarkupConfig config) => config.sizes[_editor.size].width;

  MarkupLine _newLine(Offset point, MarkupConfig config) {
    final highlighter = _editor.tool == MarkupTool.highlighter;
    return MarkupLine(
      highlighter ? MarkupLineKind.highlighter : MarkupLineKind.pen,
      _editor.colour,
      highlighter ? _width(config) * config.highlighterWidthScale : _width(config),
      [point],
    );
  }

  void _pointerDown(PointerDownEvent event, Size size, MarkupConfig config) {
    if (_editor.tool == MarkupTool.text) {
      _down = event.localPosition;
      return;
    }
    if (_pointer != null) {
      return;
    }
    _pointer = event.pointer;
    final point = _point(event.localPosition, size);
    if (_editor.tool == MarkupTool.shapes) {
      _drag = _Shape(point);
    } else {
      final line = _newLine(point, config);
      _editor.commit([..._editor.items, line]);
      _drag = _Line(line);
    }
  }

  void _pointerMove(PointerMoveEvent event, Size size, MarkupConfig config) {
    final drag = _drag;
    if (event.pointer != _pointer || drag == null || !mounted) {
      return;
    }
    final point = _point(event.localPosition, size);
    final last = _editor.items.length - 1;
    switch (drag) {
      case _Line(:final line):
        if (!_there(last, line)) {
          _drag = null;
        } else if ((point - line.points.last).distance > config.minStep) {
          final grown = MarkupLine(line.kind, line.colour, line.width, [...line.points, point]);
          _change(false, () => _editor.amend([..._editor.items]..[last] = grown));
          drag.line = grown;
        }
      case _Shape(:final start, :final shape):
        final next = MarkupShape(_editor.shape, _editor.colour, _width(config), start, point);
        if (shape != null && !_there(last, shape)) {
          _drag = null;
        } else if (shape != null) {
          _change(false, () => _editor.amend([..._editor.items]..[last] = next));
          drag.shape = next;
        } else if ((point - start).distance > config.minStep * 5) {
          _editor.commit([..._editor.items, next]);
          drag.shape = next;
        }
      case _TextDrag():
        break;
    }
  }

  void _pointerEnd(PointerEvent event) {
    if (event.pointer == _pointer && mounted) {
      _pointer = null;
      _finish();
    }
  }

  void _finish() {
    _drag = null;
    _editor.release();
  }

  void _tap(Offset local, Size size, MarkupConfig config) {
    final hit = _textAt(local, size, config);
    if (hit != null) {
      _editor.select(hit);
    } else if (_editor.selected == null) {
      _editor.addText(_point(local, size));
    } else {
      _editor.select(null);
    }
  }

  void _start(ScaleStartDetails details, Size size, MarkupConfig config) {
    final down = _down;
    _down = null;
    _drag = null;
    if (down == null && details.pointerCount == 1) {
      return;
    }
    final local = down ?? details.localFocalPoint;
    final selected = _editor.selectedText;
    final index = _editor.selected;
    if (details.pointerCount > 1) {
      if (selected != null && index != null) {
        _drag = _Pinch(index, selected);
      }
      return;
    }
    if (selected != null && index != null) {
      final box = _boxOf(selected, size, config);
      if ((local - box.bottomRight).distance <= _handle) {
        final middle = Offset(selected.at.dx * size.width, selected.at.dy * size.height);
        _drag = _Resize(index, selected, (local - middle).distance.clamp(1.0, double.infinity));
        return;
      }
    }
    final hit = _textAt(local, size, config);
    if (hit != null) {
      _editor.select(hit);
      final item = _editor.selectedText;
      final now = _editor.selected;
      if (item != null && now != null) {
        _drag = _Move(now, item, _point(local, size));
      }
    }
  }

  void _update(ScaleUpdateDetails details, Size size, MarkupConfig config) {
    final drag = _drag;
    final local = details.localFocalPoint;
    final point = _point(local, size);
    if (drag is! _TextDrag) {
      return;
    }
    if (!_there(drag.index, drag.shown)) {
      _drag = null;
      return;
    }
    final VoidCallback change;
    switch (drag) {
      case _Move(:final index, :final item, :final start):
        if (!drag.moved && (point - start).distance <= config.minStep) {
          return;
        }
        final moved = item.at + point - start;
        final at = Offset(moved.dx.clamp(0.0, 1.0), moved.dy.clamp(0.0, 1.0));
        change = () => _editor.moveText(index, item, at, newChange: !drag.moved);
      case _Resize(:final index, :final item, :final distance):
        final middle = Offset(item.at.dx * size.width, item.at.dy * size.height);
        final scale = (local - middle).distance / distance;
        change = () => _editor.resizeText(index, item, item.fontSize * scale, newChange: !drag.moved);
      case _Pinch(:final index, :final item):
        change = () => _editor.resizeText(index, item, item.fontSize * details.scale, newChange: !drag.moved);
    }
    _change(!drag.moved, change);
    drag.moved = true;
    drag.shown = _editor.items[drag.index];
  }
}

class _MarkupPainter extends CustomPainter {
  final List<MarkupItem> Function() items;

  /// The text being edited, with room around it: a dashed box.
  final Rect? Function() selection;
  final MarkupConfig config;
  final bool active;

  const _MarkupPainter({
    required this.items,
    required this.selection,
    required this.config,
    required this.active,
    required Listenable repaint,
  }) : super(repaint: repaint);

  @override
  void paint(Canvas canvas, Size size) {
    paintMarkup(canvas, items(), size, config);
    final box = selection();
    if (box != null) {
      final shadow = Paint()
        ..color = Colors.black54
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3;
      final line = Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1;
      canvas.drawRect(box, shadow);
      for (final (from, to) in [
        (box.topLeft, box.topRight),
        (box.topRight, box.bottomRight),
        (box.bottomRight, box.bottomLeft),
        (box.bottomLeft, box.topLeft),
      ]) {
        final length = (to - from).distance;
        final step = (to - from) / length;
        for (var at = 0.0; at < length; at += 8) {
          canvas.drawLine(from + step * at, from + step * (at + 4 < length ? at + 4 : length), line);
        }
      }
    }
  }

  @override
  bool shouldRepaint(_MarkupPainter old) => old.config != config || old.active != active;
}
