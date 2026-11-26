// SelfPhotos Adjust's Markup for Android.
import 'package:flutter/material.dart';
import 'package:immich_mobile/selfphotos/adjust/markup.dart';

enum MarkupTool { pen, highlighter, text, shapes }

class MarkupEditor extends ChangeNotifier {
  MarkupHistory _history = const MarkupHistory();
  MarkupConfig? _config;
  MarkupTool _tool = MarkupTool.pen;
  MarkupShapeKind _shape = MarkupShapeKind.arrow;
  Color? _colour;
  int _size = 1;
  int? _selected;
  int _selection = 0;
  int _newText = 0;
  bool _typing = false;
  bool _holding = false;
  bool _unheard = false;

  /// adjust-markup.json, once loaded.
  MarkupConfig? get config => _config;
  List<MarkupItem> get items => _history.items;
  bool get canUndo => _history.past.isNotEmpty;
  bool get canRedo => _history.future.isNotEmpty;

  bool get isEmpty => items.every((item) => item is MarkupText && item.text.trim().isEmpty);
  MarkupTool get tool => _tool;
  MarkupShapeKind get shape => _shape;
  Color get colour => _colour ?? _config?.colours.first.fill ?? Colors.red;
  int get size => _size;

  int? get selected => _selected;

  /// Goes up each time another text (or none) is picked to edit.
  int get selection => _selection;

  /// Goes up each time a new text is placed.
  int get newText => _newText;

  MarkupText? get selectedText {
    final index = _selected;
    final item = index == null || index >= items.length ? null : items[index];
    return item is MarkupText ? item : null;
  }

  Future<void> load() async {
    _config = await MarkupConfig.load();
    notifyListeners();
  }

  @visibleForTesting
  set config(MarkupConfig? config) => _config = config;

  void _set(MarkupHistory history) {
    _history = history;
    if (_holding) {
      _unheard = true;
    } else {
      notifyListeners();
    }
  }

  /// While a finger moves: [change] goes in at once (Save and Undo see it), but listeners hear of it
  /// only at [release].
  void hold(VoidCallback change) {
    _holding = true;
    try {
      change();
    } finally {
      _holding = false;
    }
  }

  /// The finger lifted: listeners hear of what changed while it moved.
  void release() {
    if (_unheard) {
      _unheard = false;
      notifyListeners();
    }
  }

  /// A change that can be undone.
  void commit(List<MarkupItem> next) {
    _typing = false;
    _set(_history.commit(next));
  }

  /// More of the last change: a line growing, a drag going on.
  void amend(List<MarkupItem> next) => _set(_history.amend(next));

  /// Changes item [index].
  void update(int index, MarkupItem item, {required bool newChange}) {
    final next = [...items]..[index] = item;
    newChange ? commit(next) : amend(next);
  }

  void undo() {
    final steps = _history.past.length;
    select(null);
    if (_history.past.length == steps) {
      _set(_history.undo());
    }
  }

  void redo() {
    select(null);
    _set(_history.redo());
  }

  void clear() {
    select(null);
    if (!isEmpty) {
      commit(const []);
    }
  }

  /// Everything gone, the history too (Reset, or saved).
  void reset() {
    _pick(null);
    _set(const MarkupHistory());
  }

  set tool(MarkupTool tool) {
    select(null);
    _tool = tool;
    notifyListeners();
  }

  set shape(MarkupShapeKind shape) {
    _shape = shape;
    notifyListeners();
  }

  /// Picks the text to edit, or none.
  void select(int? index) {
    if (index == _selected) {
      return;
    }
    final left = selectedText;
    final leftIndex = _selected;
    var next = index;
    if (left != null && leftIndex != null && left.text.trim().isEmpty) {
      _history = _history.amend([...items]..removeAt(leftIndex));
      if (next != null && next > leftIndex) {
        next--;
      }
    }
    _pick(next);
    _typing = false;
    notifyListeners();
  }

  void _pick(int? index) {
    _selected = index;
    _selection++;
  }

  /// A new, empty text at [at], being edited.
  void addText(Offset at) {
    final config = _config;
    if (config == null) {
      return;
    }
    select(null);
    commit([...items, MarkupText(colour, config.sizes[_size].text, at, '')]);
    _pick(items.length - 1);
    _typing = true;
    _newText++;
    notifyListeners();
  }

  /// Typing in the selected text: one change, from the first letter to leaving it.
  void setText(String value) {
    final item = selectedText;
    final index = _selected;
    final config = _config;
    if (item != null && index != null && config != null) {
      final text = value.length > config.maxLength ? value.substring(0, config.maxLength) : value;
      update(index, item.copyWith(text: text), newChange: !_typing);
      _typing = true;
    }
  }

  /// A text moved to [at].
  void moveText(int index, MarkupText item, Offset at, {required bool newChange}) =>
      _changeText(index, item.copyWith(at: at), newChange: newChange);

  /// A text's size, within the limits.
  void resizeText(int index, MarkupText item, double fontSize, {required bool newChange}) {
    final config = _config;
    if (config != null) {
      _changeText(index, item.copyWith(fontSize: config.textSize(fontSize)), newChange: newChange);
    }
  }

  void deleteSelected() {
    final index = _selected;
    if (index != null) {
      _pick(null);
      commit([...items]..removeAt(index));
    }
  }

  /// A colour or size picked: for what's drawn next, and the text being edited.
  set colour(Color colour) {
    _colour = colour;
    final item = selectedText;
    final index = _selected;
    if (item != null && index != null && item.colour != colour) {
      _changeText(index, item.copyWith(colour: colour), newChange: true);
    } else {
      notifyListeners();
    }
  }

  set size(int size) {
    _size = size;
    final item = selectedText;
    final index = _selected;
    final config = _config;
    if (item != null && index != null && config != null) {
      _changeText(index, item.copyWith(fontSize: config.sizes[size].text), newChange: true);
    } else {
      notifyListeners();
    }
  }

  void _changeText(int index, MarkupText item, {required bool newChange}) =>
      update(index, item, newChange: newChange && item.text.isNotEmpty);
}
