import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.service.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_export.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_native.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_align.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_area.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_tools.dart';

import '../unit/factories/remote_asset_factory.dart';
import 'work_folder_stub.dart';

final _kit = AiToolkit.parse(File('../web/src/lib/ai-edit/ai/ai-tools.json').readAsStringSync());

const _maxPromptChars = 1500;
final _toolName = RegExp(r'^[a-z][a-z0-9-]{0,39}$');

const _header =
    'Make all of these changes to the photo in one edit. Where an item says to keep something the same, that means apart from the other changes in this list:';

AiTool _tool(String id) => _kit.tools.firstWhere((t) => t.id == id);
List<String> _ids(List<AiTool> tools) => [for (final t in tools) t.id];
List<AiTool> _tapAll(Iterable<AiTool> taps) => taps.fold(const [], _kit.toggle);
List<AiTool> _pick(List<String> taps) => _tapAll(taps.map(_tool));

Future<ui.Image> _image(int width, int height, List<int> rgba) {
  final pixels = Uint8List(width * height * 4);
  for (var i = 0; i < width * height; i++) {
    pixels.setAll(i * 4, rgba);
  }
  return imageFromPixels(pixels, width, height);
}

class _Source extends AdjustService {
  const _Source();

  @override
  List<String> sourceUrls(RemoteAsset asset) => const ['original'];

  @override
  Future<void> download(String url, File file) => file.writeAsBytes(const [0]);
}

class _Native extends AdjustNative {
  final Uint8List encoded;
  final outputs = <AdjustSize>[];

  _Native(this.encoded);

  @override
  Future<AdjustSize> open(String path) async => const AdjustSize(600, 400);

  @override
  Future<Uint8List> read(AdjustRect rect) async => Uint8List(rect.width * rect.height * 4);

  @override
  Future<void> createOutput(AdjustSize size) async => outputs.add(size);

  @override
  Future<void> write(AdjustRect tile, Uint8List pixels) async {}

  @override
  Future<void> encode(String path, {required bool png, int quality = 92}) => File(path).writeAsBytes(encoded);

  @override
  Future<void> close() async {}
}

void main() {
  setUpAll(stubWorkFolderRoot);

  group('the tools', () {
    test('every tool has a name the service accepts, a label, and an instruction with room for words', () {
      final en = jsonDecode(File('../i18n/en.json').readAsStringSync()) as Map<String, Object?>;
      expect(_kit.tools.map((t) => t.id).toSet().length, _kit.tools.length);
      for (final tool in _kit.tools) {
        expect(tool.id, matches(_toolName));
        expect(en['editor_ai_tool_${tool.id}'], isNotNull, reason: tool.id);
        expect(tool.instructionWith('x' * maxAskWords).length, lessThanOrEqualTo(_maxPromptChars), reason: tool.id);
        if (tool.highlight != AiHighlight.optional) {
          expect(tool.pasteBack, isFalse, reason: tool.id);
        }
      }
      final move = _kit.tools.firstWhere((t) => t.id == 'move');
      expect(move.ask, isTrue);
      expect(move.instructionWith('  to the left '), '${move.instruction} to the left');
    });

    test('the fixes come first, then the styles; Move goes alone; at most 3 at a time', () {
      expect(_kit.maxSelected, 3);
      expect(
        [
          for (final t in _kit.tools)
            if (t.group == AiGroup.style) t.id,
        ],
        ['watercolour', 'sketch', 'painting'],
      );
      expect(_kit.tools.map((t) => t.group).toList(), [
        ..._kit.tools.where((t) => t.group == AiGroup.fix).map((t) => t.group),
        ..._kit.tools.where((t) => t.group == AiGroup.style).map((t) => t.group),
      ]);
      expect(
        [
          for (final t in _kit.tools)
            if (t.alone) t.id,
        ],
        ['move'],
      );
    });

    test('the longest edit that can be picked fits in what the service accepts', () {
      var longest = 0;
      for (final first in _kit.tools) {
        for (final second in _kit.tools) {
          for (final third in _kit.tools) {
            final picked = _tapAll([first, second, third]);
            final words = 'x' * (picked.any((t) => t.ask) ? maxAskWords : maxWords);
            longest = max(longest, combinedInstruction(picked, words).length);
          }
        }
      }
      expect(longest, greaterThan(1000));
      expect(longest, lessThanOrEqualTo(_maxPromptChars));
    });
  });

  group('picking several', () {
    test('toggles: several fixes, one style (another swaps it), a style with fixes', () {
      expect(_ids(_pick(['sky', 'enhance'])), ['enhance', 'sky']);
      expect(_ids(_pick(['enhance', 'sky', 'enhance'])), ['sky']);
      expect(_ids(_pick(['watercolour', 'sketch'])), ['sketch']);
      expect(_ids(_pick(['watercolour', 'enhance', 'sky'])), ['enhance', 'sky', 'watercolour']);
      expect(_ids(_pick(['enhance', 'sky', 'watercolour', 'painting'])), ['enhance', 'sky', 'painting']);
    });

    test('never combines Move: picking it clears the others, picking another clears it', () {
      expect(_ids(_pick(['enhance', 'watercolour', 'move'])), ['move']);
      expect(_ids(_pick(['move', 'sky'])), ['sky']);
      expect(_ids(_pick(['move', 'move'])), isEmpty);
    });

    test('takes at most 3; then the unselected tools say why they wait, the selected ones can be unselected', () {
      final three = _pick(['enhance', 'unblur', 'sky']);
      expect(_ids(_kit.toggle(three, _tool('glare'))), ['enhance', 'unblur', 'sky']);
      expect(_kit.blocked(_tool('glare'), three, highlighted: false), AiBlock.upTo);
      expect(_kit.blocked(_tool('watercolour'), three, highlighted: false), AiBlock.upTo);
      expect(_kit.blocked(_tool('sky'), three, highlighted: false), isNull);
      expect(_kit.blocked(_tool('glare'), _pick(['enhance', 'sky']), highlighted: false), isNull);
    });

    test('with 3 selected, another style swaps in, Move goes alone, and the rest still wait', () {
      final withStyle = _pick(['enhance', 'sky', 'watercolour']);
      expect(_kit.blocked(_tool('painting'), withStyle, highlighted: false), isNull);
      expect(_ids(_kit.toggle(withStyle, _tool('painting'))), ['enhance', 'sky', 'painting']);
      expect(_kit.blocked(_tool('glare'), withStyle, highlighted: false), AiBlock.upTo);
      expect(_ids(_kit.toggle(withStyle, _tool('glare'))), ['enhance', 'sky', 'watercolour']);

      final fixes = _pick(['enhance', 'unblur', 'sky']);
      expect(_kit.blocked(_tool('move'), fixes, highlighted: true), isNull);
      expect(_ids(_kit.toggle(fixes, _tool('move'))), ['move']);
      expect(_kit.blocked(_tool('move'), fixes, highlighted: false), AiBlock.needsHighlight);
      expect(_kit.blocked(_tool('move'), withStyle, highlighted: true), isNull);
      expect(_ids(_kit.toggle(withStyle, _tool('move'))), ['move']);
      expect(_kit.blocked(_tool('watercolour'), fixes, highlighted: false), AiBlock.upTo);
      expect(_ids(_kit.toggle(fixes, _tool('watercolour'))), ['enhance', 'unblur', 'sky']);
    });

    test("keeps today's highlight rules: Move needs one, whole-photo tools need none", () {
      expect(_kit.blocked(_tool('move'), const [], highlighted: false), AiBlock.needsHighlight);
      expect(_kit.blocked(_tool('move'), const [], highlighted: true), isNull);
      expect(_kit.blocked(_tool('move'), _pick(['move']), highlighted: false), isNull);
      expect(_kit.blocked(_tool('watercolour'), const [], highlighted: true), AiBlock.wholeOnly);
      expect(_kit.blocked(_tool('reframe'), const [], highlighted: true), AiBlock.wholeOnly);
      expect(_kit.blocked(_tool('enhance'), const [], highlighted: true), isNull);
    });

    test('the whole-photo presets are Auto frame and the styles', () {
      final whole = [
        for (final t in _kit.tools)
          if (t.highlight == AiHighlight.ignored) t.id,
      ];
      expect(whole, ['reframe', 'watercolour', 'sketch', 'painting']);
      for (final id in whole) {
        expect(_kit.blocked(_tool(id), const [], highlighted: true), AiBlock.wholeOnly, reason: id);
        expect(_kit.blocked(_tool(id), const [], highlighted: false), isNull, reason: id);
      }
    });

    test('Generate needs a tool or words; Move its words and a highlight; a whole-photo tool no highlight', () {
      expect(canGenerate(const [], '  ', highlighted: false), isFalse);
      expect(canGenerate(const [], 'make it warmer', highlighted: false), isTrue);
      expect(canGenerate(_pick(['enhance', 'sky']), '', highlighted: true), isTrue);
      expect(canGenerate(_pick(['move']), 'to the left', highlighted: true), isTrue);
      expect(canGenerate(_pick(['move']), ' ', highlighted: true), isFalse);
      expect(canGenerate(_pick(['move']), 'to the left', highlighted: false), isFalse);
      expect(canGenerate(_pick(['watercolour']), '', highlighted: false), isTrue);
      expect(canGenerate(_pick(['watercolour']), '', highlighted: true), isFalse);
    });
  });

  group('combinedInstruction', () {
    test('several presets and words: one list, the style last, then the words (the web expects the same)', () {
      expect(
        combinedInstruction([_tool('enhance'), _tool('sky'), _tool('watercolour')], '  make it warmer '),
        '$_header\n'
        "- Enhance this photo the way a skilled photo editor would: balanced exposure, natural colour and white "
        "balance, more clarity and detail, less noise. Keep it realistic, and keep the content, the framing and every "
        "person's face exactly the same.\n"
        "- Replace the sky with a beautiful, natural sky that suits the scene's time of day, and gently match the "
        "light on the rest of the scene to it. Keep everything that isn't sky where it is.\n"
        '- Turn this photo into a delicate watercolour painting on textured paper, with soft washes of colour and '
        'visible brush strokes. Keep the composition, and keep the people recognisable.\n'
        '- make it warmer',
      );
    });

    test('one preset, or words alone, are sent as they always were', () {
      expect(combinedInstruction([_tool('enhance')], ''), _tool('enhance').instruction);
      expect(combinedInstruction([_tool('enhance')], '   '), _tool('enhance').instruction);
      expect(combinedInstruction(const [], ' make it warmer '), 'make it warmer');
      expect(
        combinedInstruction([_tool('move')], ' a little to the left '),
        '${_tool('move').instruction} a little to the left',
      );
    });

    test('two presets, or one preset with words: a list', () {
      expect(
        combinedInstruction([_tool('sky'), _tool('glare')], ''),
        '$_header\n- ${_tool('sky').instruction}\n- ${_tool('glare').instruction}',
      );
      expect(combinedInstruction([_tool('sky')], 'at sunset'), '$_header\n- ${_tool('sky').instruction}\n- at sunset');
    });
  });

  group('combinedLabel', () {
    String name(AiTool tool) => tool.id.toUpperCase();

    test("names the tools in order, then the words, joined with ' + '", () {
      expect(combinedLabel(_pick(['watercolour', 'enhance']), ' warmer ', name), 'ENHANCE + WATERCOLOUR + warmer');
      expect(combinedLabel([_tool('unblur')], '', name), 'UNBLUR');
      expect(combinedLabel(const [], 'make it warmer', name), 'make it warmer');
    });

    test('names Move with its words after a colon, as before', () {
      expect(combinedLabel([_tool('move')], ' to the left ', name), 'MOVE: to the left');
    });
  });

  group('the shape check', () {
    test("allows the AI's own size class, not a different shape", () {
      final tolerance = _kit.area.shapeTolerance;
      expect(sameShape(const AdjustSize(3050, 1408), const AdjustSize(3120, 1440), tolerance), isTrue);
      expect(sameShape(const AdjustSize(4096, 3072), const AdjustSize(4080, 3072), tolerance), isTrue);
      expect(sameShape(const AdjustSize(3072, 4096), const AdjustSize(4080, 3072), tolerance), isFalse);
      expect(sameShape(const AdjustSize(2048, 2048), const AdjustSize(4080, 3072), tolerance), isFalse);
    });

    testWidgets('refuses to paste a result of another shape: it would misalign', (tester) async {
      await tester.runAsync(() async {
        final base = await _image(40, 30, [10, 20, 30, 255]);
        final portrait = await _image(30, 40, [200, 0, 0, 255]);
        final strokes = [
          const AiStroke([Offset(0.5, 0.5)], 0.1),
        ];
        await expectLater(pasteOnto(base, portrait, strokes, _kit.area), throwsA(isA<ShapeChangedException>()));
      });
    });
  });

  group('pasteOnto', () {
    testWidgets('takes the result inside the highlight and keeps the photo outside it', (tester) async {
      await tester.runAsync(() async {
        final base = await _image(80, 60, [10, 20, 30, 255]);
        final result = await _image(78, 58, [200, 150, 100, 255]);
        final strokes = [
          const AiStroke([Offset(0.5, 0.5)], 0.1),
        ];
        final pasted = await pasteOnto(base, result, strokes, _kit.area);
        expect([pasted.width, pasted.height], [80, 60]);
        final pixels = (await pasted.toByteData())!.buffer.asUint8List();
        List<int> at(int x, int y) => pixels.sublist((y * 80 + x) * 4, (y * 80 + x) * 4 + 4);
        expect(at(2, 2), [10, 20, 30, 255]);
        expect(at(77, 57), [10, 20, 30, 255]);
        final centre = at(40, 30);
        for (final (i, value) in [200, 150, 100].indexed) {
          expect((centre[i] - value).abs(), lessThanOrEqualTo(3));
        }
      });
    });
  });

  group('alignment', () {
    Future<ui.Image> photo() {
      const width = 1024;
      const height = 768;
      final pixels = Uint8List(width * height * 4);
      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          final v =
              128 +
              40 * sin(x / 4.3 + y / 9.1) +
              35 * sin(y / 5.2 - x / 13.7) +
              25 * sin((x + 2 * y) / 7.9) +
              20 * sin(x / 11.3);
          pixels.setAll((y * width + x) * 4, [v.round(), (v * 0.8 + 20).round(), (255 - v).round(), 255]);
        }
      }
      return imageFromPixels(pixels, width, height);
    }

    Future<ui.Image> drifted(ui.Image base, double scale, Offset offset) {
      const size = Size(1000, 750);
      final recorder = ui.PictureRecorder();
      Canvas(recorder).drawImageRect(
        base,
        Rect.fromLTWH(0, 0, base.width.toDouble(), base.height.toDouble()),
        Rect.fromLTWH(offset.dx * size.width, offset.dy * size.height, scale * size.width, scale * size.height),
        Paint()..filterQuality = FilterQuality.medium,
      );
      return recorder.endRecording().toImage(1000, 750);
    }

    final dot = [
      const AiStroke([Offset(0.5, 0.5)], 0.1),
    ];

    testWidgets('finds how far the result drifted', (tester) async {
      await tester.runAsync(() async {
        final base = await photo();
        final alignment = await alignFor(base, await drifted(base, 1.006, const Offset(-0.001, 0.004)), dot, _kit.area);
        expect(alignment.scaleX, closeTo(1.006, 0.001));
        expect(alignment.scaleY, closeTo(1.006, 0.001));
        expect(alignment.offsetX, closeTo(-0.001, 0.001));
        expect(alignment.offsetY, closeTo(0.004, 0.001));
        expect(alignment.error * 1024, lessThan(0.5));
        final corners = [
          const AiStroke([Offset(0.1, 0.1)], 0.05),
          const AiStroke([Offset(0.9, 0.9)], 0.05),
        ];
        final apart = await alignFor(base, await drifted(base, 1.006, const Offset(-0.001, 0.004)), corners, _kit.area);
        expect(apart.scaleX, closeTo(1.006, 0.001));
        expect(apart.offsetY, closeTo(0.004, 0.001));
        final plain = await alignFor(base, await drifted(base, 1, Offset.zero), dot, _kit.area);
        expect(plain.scaleX, closeTo(1, 0.001));
        expect(plain.offsetX * 1024, closeTo(0, 0.5));
      });
    });

    test('gives up when nothing has texture to match', () {
      final flat = Grey(300, 200, Float32List(300 * 200)..fillRange(0, 300 * 200, 90));
      expect(estimateAlignment(flat, flat, null), isNull);
    });
  });

  group('feather', () {
    test('softens an edge symmetrically and keeps the inside and far outside as they were', () {
      const width = 40;
      final alpha = Float32List.fromList([for (var x = 0; x < width; x++) x < 20 ? 255.0 : 0.0]);
      final soft = feather(alpha, width, 1, 2);
      expect(soft[0], closeTo(255, 0.01));
      expect(soft[width - 1], closeTo(0, 0.01));
      expect(soft[19] + soft[20], closeTo(255, 0.5));
      expect(soft[19], greaterThan(soft[20]));
      expect(soft[20], greaterThan(0));
      expect(soft[20 - 7], closeTo(255, 0.01));
      expect(soft[20 + 6], closeTo(0, 0.01));
    });
  });

  group('which photos AI edits take', () {
    test('refuses a photo over 100 megapixels or 12,000 px on its longer side, by its size as shown', () {
      expect((_kit.maxMegapixels, _kit.maxLongSide), (100, 12000));
      expect(_kit.tooLargeForAi(10000, 10000), isFalse);
      expect(_kit.tooLargeForAi(10000, 10001), isTrue);
      expect(_kit.tooLargeForAi(12000, 8000), isFalse);
      expect(_kit.tooLargeForAi(8000, 12001), isTrue);
      expect(_kit.tooLargeForAi(12001, 100), isTrue);
      expect(_kit.tooLargeForAi(4080, 3072), isFalse);
    });

    test("takes a photo whose size Immich doesn't know (the service checks it too)", () {
      expect(_kit.tooLargeForAi(null, null), isFalse);
    });
  });

  group("isFullSize (the service's check of a pasted copy)", () {
    bool full(int width, int height) => isFullSize(AdjustSize(width, height), 6000, 4000);

    test('takes the photo itself, and a picture down to 90% on each side, never larger', () {
      expect((fullSizeMinShare, fullSizeAspectTolerance), (0.9, 0.01));
      expect(full(6000, 4000), isTrue);
      expect(full(5760, 3840), isTrue);
      expect(full(5400, 3600), isTrue);
      expect(full(5399, 3600), isFalse);
      expect(full(6001, 4000), isFalse);
      expect(full(1440, 960), isFalse);
    });

    test('wants the same shape within 1%, upright as Immich shows it', () {
      expect(full(6000, 3970), isTrue);
      expect(full(6000, 3960), isFalse);
      expect(full(4000, 6000), isFalse);
      expect(isFullSize(const AdjustSize(1000, 998), 1000, 1005), isFalse);
      expect(isFullSize(const AdjustSize(998, 1000), 1000, 1005), isTrue);
    });

    test("takes any picture of a photo whose size isn't known", () {
      expect(isFullSize(const AdjustSize(1440, 960), null, null), isTrue);
    });
  });

  group('the full-size picture a highlighted edit needs', () {
    RemoteAsset photo(int width, int height) => RemoteAssetFactory.create().copyWith(width: width, height: height);
    final strokes = [
      const AiStroke([Offset(0.5, 0.5)], 0.1),
    ];
    Future<_Native> native() async => _Native(
      (await (await _image(600, 400, [
        128,
        128,
        128,
        255,
      ])).toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List(),
    );

    testWidgets('uprightPhoto takes the photo at full size, and refuses a smaller picture (nothing is sent or paid '
        'for)', (tester) async {
      await tester.runAsync(() async {
        final android = await native();
        final upright = await uprightPhoto(photo(600, 400), _kit.area, service: const _Source(), native: android);
        expect([upright.image.width, upright.image.height], [600, 400]);
        upright.image.dispose();
        expect(android.outputs, [const AdjustSize(600, 400)]);

        await expectLater(
          uprightPhoto(photo(6000, 4000), _kit.area, service: const _Source(), native: android),
          throwsA(isA<NeedsOriginalException>()),
        );
        expect(android.outputs, hasLength(1));
      });
    });

    testWidgets('pasteBack pastes onto the photo at full size, and refuses a smaller picture (nothing is '
        'uploaded)', (tester) async {
      await tester.runAsync(() async {
        final android = await native();
        final result = await _image(600, 400, [200, 150, 100, 255]);
        Future<AdjustExport> paste(RemoteAsset asset) => pasteBack(
          asset,
          result,
          strokes,
          _kit.area,
          AiAlignment.identity,
          service: const _Source(),
          native: android,
        );
        expect((await paste(photo(600, 400))).size, const AdjustSize(600, 400));

        await expectLater(paste(photo(6000, 4000)), throwsA(isA<NeedsOriginalException>()));
        expect(android.outputs, hasLength(1));
      });
    });
  });

  group('refusalOf', () {
    test("counts a result of another shape as the normal refusal ('shape'), anything else as a failure ('failed')", () {
      expect(refusalOf(const ShapeChangedException()), AiRefusal.shape);
      expect(refusalOf(StateError('the isolate died')), AiRefusal.failed);
      expect(
        refusalOf(const AdjustNativeException('too-large', 'Not enough memory for a photo this large.')),
        AiRefusal.failed,
      );
    });
  });
}
