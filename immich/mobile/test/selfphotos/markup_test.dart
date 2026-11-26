import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/markup.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_editor.dart';

const _webDir = '../web/src/lib/ai-edit/adjust';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final config = MarkupConfig.parse(File('assets/selfphotos/adjust-markup.json').readAsStringSync());
  final parity = jsonDecode(File('$_webDir/markup-parity.json').readAsStringSync()) as Map<String, Object?>;
  Size size(Object? photo) {
    final list = (photo! as List).cast<num>();
    return Size(list[0].toDouble(), list[1].toDouble());
  }

  Offset offset(Object? point) {
    final list = (point! as List).cast<num>();
    return Offset(list[0].toDouble(), list[1].toDouble());
  }

  group('the markup settings, as the web works them out (markup-parity.json)', () {
    test('give each size the same line, highlighter and text sizes', () {
      for (final entry in (parity['widths']! as List).cast<Map<String, Object?>>()) {
        final photo = size(entry['photo']);
        final chosen = config.sizes[entry['size']! as int];
        expect(markupPixels(chosen.width, photo), closeTo(entry['pen']! as num, 1e-3));
        expect(
          markupPixels(chosen.width * config.highlighterWidthScale, photo),
          closeTo(entry['highlighter']! as num, 1e-3),
        );
        expect(markupPixels(chosen.text, photo), closeTo(entry['text']! as num, 1e-3));
        expect(markupPixels(chosen.text, photo) * config.textOutline, closeTo(entry['textOutline']! as num, 1e-3));
      }
    });

    test('give arrows the same line end and head', () {
      for (final arrow in (parity['arrows']! as List).cast<Map<String, Object?>>()) {
        final photo = size(arrow['photo']);
        final from = offset(arrow['from']);
        final to = offset(arrow['to']);
        final geometry = arrowGeometry(
          Offset(from.dx * photo.width, from.dy * photo.height),
          Offset(to.dx * photo.width, to.dy * photo.height),
          markupPixels(config.sizes[arrow['size']! as int].width, photo),
          config,
        );
        final expected = [arrow['lineEnd'], ...(arrow['head']! as List)].map(offset).toList();
        final actual = [geometry.lineEnd, ...geometry.head];
        for (var i = 0; i < expected.length; i++) {
          expect(actual[i].dx, closeTo(expected[i].dx, 1e-3), reason: '$arrow');
          expect(actual[i].dy, closeTo(expected[i].dy, 1e-3), reason: '$arrow');
        }
      }
    });

    test('give a text the same box, centred on its place, in GoogleSans Bold', () async {
      final bold = File('fonts/GoogleSans/GoogleSans-Bold.ttf').readAsBytesSync();
      await (FontLoader('GoogleSans')..addFont(Future.value(ByteData.sublistView(bold)))).load();
      for (final entry in (parity['texts']! as List).cast<Map<String, Object?>>()) {
        final text = entry['text']! as String;
        final item = MarkupText(Colors.white, config.sizes[entry['size']! as int].text, offset(entry['at']), text);
        final box = markupTextBox(item, size(entry['photo']), config);
        final expected = (entry['box']! as Map).cast<String, num>();
        expect(box.width, closeTo(expected['width']!, 0.1), reason: text);
        expect(box.left, closeTo(expected['x']!, 0.1), reason: text);
        expect(box.height, closeTo(expected['height']!, 1), reason: text);
        expect(box.top, closeTo(expected['y']!, 0.5), reason: text);
      }
    });

    test('has 6 to 8 colours, black and white among them, as the web reads them', () {
      final fills = config.colours.map((c) => c.fill).toList();
      expect(fills.length, inInclusiveRange(6, 8));
      expect(fills, contains(const Color(0xff000000)));
      expect(fills, contains(const Color(0xffffffff)));
      expect(config.weight, FontWeight.w700);
      expect(config.font, 'GoogleSans');
    });
  });

  MarkupLine pen(double x) => MarkupLine(MarkupLineKind.pen, Colors.black, 0.01, [Offset(x, x)]);

  group('MarkupHistory', () {
    test('undoes and redoes each change, and a new change ends the redo', () {
      final a = pen(0.1);
      final b = pen(0.2);
      var history = const MarkupHistory().commit([a]).commit([a, b]);
      history = history.undo();
      expect(history.items, [a]);
      history = history.redo();
      expect(history.items, [a, b]);
      history = history.undo().undo();
      expect(history.items, isEmpty);
      expect(history.undo().items, isEmpty);
      history = history.redo().commit([a, pen(0.3)]);
      expect(history.future, isEmpty);
      expect(history.redo().items, hasLength(2));
    });

    test('keeps more of the last change with it, and forgets a change that came to nothing', () {
      final a = pen(0.1);
      const grown = MarkupLine(MarkupLineKind.pen, Colors.black, 0.01, [Offset(0.1, 0.1), Offset(0.2, 0.2)]);
      var history = const MarkupHistory().commit([a]).amend([grown]);
      expect(history.past, hasLength(1));
      expect(history.undo().items, isEmpty);
      history = history.commit([grown, pen(0.5)]).amend([grown]);
      expect(history.past, hasLength(1));
    });
  });

  group('MarkupEditor', () {
    MarkupEditor editor() => MarkupEditor()..config = config;

    test('drops a text left empty, with no undo step for it', () {
      final markup = editor()..addText(const Offset(0.5, 0.5));
      expect(markup.items, hasLength(1));
      expect(markup.isEmpty, isTrue);
      markup.setText('Hi');
      expect(markup.isEmpty, isFalse);
      markup.setText(' ');
      markup.select(null);
      expect(markup.items, isEmpty);
      expect(markup.canUndo, isFalse);
    });

    test('undoes typing, a move and a new colour each as one step', () {
      final markup = editor()
        ..addText(const Offset(0.5, 0.5))
        ..setText('H')
        ..setText('Hi');
      markup.update(0, markup.selectedText!.copyWith(at: const Offset(0.2, 0.3)), newChange: true);
      markup.colour = config.colours[6].fill;
      expect(markup.selectedText!.colour, const Color(0xffffffff));
      markup.undo();
      final item = markup.items.single as MarkupText;
      expect((item.text, item.at, item.colour), ('Hi', const Offset(0.2, 0.3), config.colours.first.fill));
      markup.undo();
      expect((markup.items.single as MarkupText).at, const Offset(0.5, 0.5));
      markup.undo();
      expect(markup.items, isEmpty);
      markup.redo();
      expect((markup.items.single as MarkupText).text, 'Hi');
    });

    test('undoes only a text placed but not typed, not the drawing before it', () {
      final line = pen(0.1);
      final markup = editor()
        ..commit([line])
        ..addText(const Offset(0.5, 0.5))
        ..undo();
      expect(markup.items, [line]);
      expect(markup.canUndo, isTrue);
    });

    test('keeps moving or resizing a text before anything is typed in the step that placed it', () {
      final line = pen(0.1);
      final markup = editor()
        ..commit([line])
        ..addText(const Offset(0.5, 0.5));
      markup.moveText(1, markup.selectedText!, const Offset(0.2, 0.2), newChange: true);
      markup.resizeText(1, markup.selectedText!, 0.1, newChange: true);
      expect((markup.selectedText!.at, markup.selectedText!.fontSize), (const Offset(0.2, 0.2), 0.1));
      markup.select(null);
      expect(markup.items, [line]);
      markup.undo();
      expect(markup.items, isEmpty);
      expect(markup.canUndo, isFalse);
    });

    test('counts each change of the text being edited, also when a text left empty moves the next one up', () {
      final markup = editor()
        ..addText(const Offset(0.2, 0.2))
        ..setText('A')
        ..addText(const Offset(0.8, 0.8))
        ..setText('B')
        ..select(0)
        ..setText('');
      final before = markup.selection;
      markup.select(1);
      expect((markup.selected, markup.selectedText!.text), (0, 'B'));
      expect(markup.selection, greaterThan(before));
    });

    test('keeps a text within its size limits, and clears in one undoable step', () {
      final markup = editor()
        ..addText(const Offset(0.5, 0.5))
        ..setText('Big');
      markup.resizeText(0, markup.selectedText!, 5, newChange: true);
      expect(markup.selectedText!.fontSize, config.maxTextSize);
      markup.resizeText(0, markup.selectedText!, 0, newChange: true);
      expect(markup.selectedText!.fontSize, config.minTextSize);
      markup.clear();
      expect(markup.isEmpty, isTrue);
      markup.undo();
      expect(markup.items, hasLength(1));
      markup.reset();
      expect(markup.isEmpty && !markup.canUndo && !markup.canRedo, isTrue);
    });
  });

  testWidgets('markup drawn tile by tile gives the one-pass picture', (tester) async {
    await tester.runAsync(() async {
      const output = AdjustSize(301, 203);
      final items = <MarkupItem>[
        const MarkupLine(MarkupLineKind.pen, Color(0xffe53935), 0.02, [
          Offset(0.05, 0.1),
          Offset(0.4, 0.6),
          Offset(0.9, 0.3),
        ]),
        const MarkupLine(MarkupLineKind.highlighter, Color(0xfffdd835), 0.05, [Offset(0.1, 0.8), Offset(0.9, 0.8)]),
        const MarkupShape(MarkupShapeKind.arrow, Colors.white, 0.01, Offset(0.2, 0.2), Offset(0.7, 0.7)),
        const MarkupShape(MarkupShapeKind.box, Colors.black, 0.01, Offset(0.3, 0.1), Offset(0.6, 0.5)),
        const MarkupShape(MarkupShapeKind.circle, Color(0xff1e88e5), 0.015, Offset(0.5, 0.4), Offset(0.95, 0.95)),
        const MarkupText(Colors.white, 0.15, Offset(0.5, 0.5), 'MMM'),
      ];
      Future<ui.Image> grey(int width, int height) {
        final recorder = ui.PictureRecorder();
        Canvas(
          recorder,
        ).drawRect(Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()), Paint()..color = const Color(0xff808080));
        return recorder.endRecording().toImage(width, height);
      }

      Future<Uint8List> pixels(ui.Image image) async =>
          (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!.buffer.asUint8List();

      final whole = await markupTile(
        await grey(output.width, output.height),
        const AdjustRect(0, 0, 301, 203),
        output,
        items,
        config,
      );
      final expected = await pixels(whole);
      final tiled = Uint8List(expected.length);
      for (final tile in tiles(output, 64)) {
        final part = await markupTile(await grey(tile.width, tile.height), tile, output, items, config);
        final bytes = await pixels(part);
        for (var row = 0; row < tile.height; row++) {
          tiled.setRange(
            ((tile.y + row) * output.width + tile.x) * 4,
            ((tile.y + row) * output.width + tile.x + tile.width) * 4,
            bytes,
            row * tile.width * 4,
          );
        }
      }
      var worst = 0;
      var drawn = 0;
      var differ = 0;
      for (var i = 0; i < expected.length; i += 4) {
        var difference = 0;
        for (var c = 0; c < 4; c++) {
          final d = (expected[i + c] - tiled[i + c]).abs();
          difference = d > difference ? d : difference;
        }
        worst = difference > worst ? difference : worst;
        differ += difference > 2 ? 1 : 0;
        drawn += expected[i] != 0x80 || expected[i + 1] != 0x80 || expected[i + 2] != 0x80 ? 1 : 0;
      }
      expect(drawn, greaterThan(5000));
      expect(worst, lessThanOrEqualTo(48));
      expect(differ, lessThan(drawn * 0.1));
    });
  });
}
