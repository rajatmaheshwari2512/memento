// SelfPhotos Adjust's Markup on a Pixel 9 (about 411×923 dp): the five tabs fit on one row, the
// tools show, and a finger draws on the photo with each tool: a held finger draws too (it doesn't
// show the original, as holding the photo does on the other tabs); a tap places a text, typed in
// the field, then dragged to move it; leaving with markup asks first. Also: a short stroke stays a
// stroke; while drawing only the markup repaints, and Undo with another finger ends the line; the
// field shows the text picked, also when an emptied one before it goes; a pinch resizes a text
// from outside it; and on a phone 360 wide the tabs still fit on one row. Pumps the real page,
// opened as the app opens it, with the app's fonts and theme and a stand-in preview.
//
// With SELFPHOTOS_SCREENSHOTS set to a folder, a screenshot of each tool is saved there.
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/providers/theme.provider.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.page.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_tabs.dart';
import 'package:immich_mobile/selfphotos/adjust/markup.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_editor.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_layer.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/theme/theme_data.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:openapi/api.dart' show AssetMediaSize;

import '../unit/factories/remote_asset_factory.dart';
import '../unit/presentation/presentation_context.dart';

// A Pixel 9: 1080×2424 pixels at 2.625, with its status bar and gesture bar.
const _pixelRatio = 2.625;
const _screen = Size(1080, 2424);
// A phone 360 wide: 1080×2400 pixels at 3.
const _narrowRatio = 3.0;
const _narrowScreen = Size(1080, 2400);
final _screenKey = GlobalKey();

// The app's fonts (the test font draws boxes): its text font, and Flutter's icons.
Future<void> _loadFonts() async {
  final sans = FontLoader('GoogleSans');
  for (final weight in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    sans.addFont(Future.value(ByteData.sublistView(File('fonts/GoogleSans/GoogleSans-$weight.ttf').readAsBytesSync())));
  }
  await sans.load();
  // flutter_tester is in <flutter>/bin/cache/artifacts/engine/<platform>/.
  final icons = File(
    '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts/MaterialIcons-Regular.otf',
  );
  if (icons.existsSync()) {
    await (FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())))).load();
  }
}

// A stand-in photo: sky, sun, grass and three boxes.
Future<ui.Image> _photo() {
  const size = Size(400, 300);
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Offset.zero & size,
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, const Offset(0, 160), [
        const Color(0xff1f4e8c),
        const Color(0xff8cc4ec),
      ]),
  );
  canvas.drawRect(const Rect.fromLTWH(0, 160, 400, 140), Paint()..color = const Color(0xff3a7a35));
  canvas.drawCircle(const Offset(310, 70), 30, Paint()..color = const Color(0xffffb84d));
  canvas.drawRect(const Rect.fromLTWH(40, 180, 60, 70), Paint()..color = const Color(0xffc0392b));
  canvas.drawRect(const Rect.fromLTWH(130, 190, 50, 60), Paint()..color = const Color(0xfff1c40f));
  canvas.drawRect(const Rect.fromLTWH(210, 185, 40, 65), Paint()..color = const Color(0xff8e44ad));
  return recorder.endRecording().toImage(400, 300);
}

void main() {
  late PresentationContext ctx;

  setUpAll(_loadFonts);
  setUp(() async => ctx = await PresentationContext.create());
  tearDown(() async => ctx.dispose());

  // Adjust's page on its Markup tab, for a landscape photo, opened over an empty page as the app
  // opens it over the viewer; loaded and idle.
  // With its status bar and gesture bar, and the system font at [textScale].
  Future<void> pumpPage(
    WidgetTester tester,
    RemoteAsset asset, {
    Size screen = _screen,
    double pixelRatio = _pixelRatio,
    double textScale = 1,
  }) async {
    final insets = FakeViewPadding(top: 48 * pixelRatio, bottom: 24 * pixelRatio);
    tester.view
      ..physicalSize = screen
      ..devicePixelRatio = pixelRatio
      ..padding = insets
      ..viewPadding = insets;
    addTearDown(tester.view.reset);
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

    rootBundle.clear();
    PaintingBinding.instance.imageCache
      ..clear()
      ..clearLiveImages();
    final preview = (await tester.runAsync(_photo))!;
    PaintingBinding.instance.imageCache.putIfAbsent(
      RemoteImageProvider(url: getThumbnailUrlForRemoteId(asset.id, type: AssetMediaSize.preview)),
      () => OneFrameImageStreamCompleter(SynchronousFuture(ImageInfo(image: preview))),
    );

    await tester.pumpWidget(
      RepaintBoundary(
        key: _screenKey,
        child: EasyLocalization(
          supportedLocales: locales.values.toList(),
          path: translationsPath,
          startLocale: locales.values.first,
          fallbackLocale: locales.values.first,
          saveLocale: false,
          useFallbackTranslations: true,
          assetLoader: const CodegenLoader(),
          child: Builder(
            builder: (context) => ProviderScope(
              overrides: [...ctx.overrides, mementoFeaturesProvider.overrideWithValue(MementoFlags.unknown)],
              child: Consumer(
                builder: (context, ref, _) => MaterialApp(
                  debugShowCheckedModeBanner: false,
                  theme: getThemeData(colorScheme: ref.watch(immichThemeProvider).dark, locale: context.locale),
                  localizationsDelegates: context.localizationDelegates,
                  supportedLocales: context.supportedLocales,
                  locale: context.locale,
                  onGenerateRoute: (_) => MaterialPageRoute<void>(builder: (_) => const Scaffold()),
                  onGenerateInitialRoutes: (_) => [
                    MaterialPageRoute<void>(builder: (_) => const Scaffold()),
                    MaterialPageRoute<bool>(
                      builder: (_) => AdjustPage(asset: asset, tab: AdjustTab.markup, fromCropScreen: true),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    // The shader, the files and the preview load outside the test's clock.
    for (var i = 0; i < 100 && find.text('Pen').evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();
  }

  Future<void> screenshot(WidgetTester tester, String name) async {
    final folder = Platform.environment['SELFPHOTOS_SCREENSHOTS'];
    if (folder == null) {
      return;
    }
    await tester.pumpAndSettle();
    final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(_screenKey));
    final png = await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: tester.view.devicePixelRatio);
      return (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
    });
    File('$folder/$name.png').writeAsBytesSync(png!);
  }

  Rect photo(WidgetTester tester) => tester.getRect(find.byType(MarkupLayer));
  Offset at(WidgetTester tester, double x, double y) {
    final rect = photo(tester);
    return Offset(rect.left + rect.width * x, rect.top + rect.height * y);
  }

  // A finger drawn through [points] (shares of the photo).
  Future<void> draw(WidgetTester tester, List<(double, double)> points, {Duration hold = Duration.zero}) async {
    final gesture = await tester.startGesture(at(tester, points.first.$1, points.first.$2));
    if (hold > Duration.zero) {
      await tester.pump(hold);
    }
    for (final (x, y) in points.skip(1)) {
      final to = at(tester, x, y);
      await gesture.moveTo(to);
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pumpAndSettle();
  }

  MarkupEditor editor(WidgetTester tester) => tester.widget<MarkupLayer>(find.byType(MarkupLayer)).editor;
  List<MarkupItem> items(WidgetTester tester) => editor(tester).items;

  // A tool, or a shape's chip, by its name.
  Future<void> choose(WidgetTester tester, String label) async {
    final chip = find.widgetWithText(ChoiceChip, label);
    await tester.tap(chip.evaluate().isEmpty ? find.text(label).last : chip);
    await tester.pumpAndSettle();
  }

  Future<void> pick(WidgetTester tester, String semantics) async {
    await tester.tap(find.bySemanticsLabel(semantics).last);
    await tester.pumpAndSettle();
  }

  testWidgets('on a Pixel 9 the five tabs fit, the tools show, and each tool draws', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());
    final t = tester.element(find.byType(AppBar)).t;
    final screen = _screen / _pixelRatio;

    // The five tabs on one row, inside the screen; the tools all on screen.
    final tabs = [t.crop, t.editor_adjust, t.filters, t.editor_straighten, t.editor_markup];
    final rows = {for (final label in tabs) tester.getCenter(find.text(label).first).dy.round()};
    expect(rows, hasLength(1));
    for (final label in [...tabs, t.editor_markup_pen, t.editor_markup_shapes, t.color, t.size]) {
      final rect = tester.getRect(find.text(label).last);
      expect(rect.right, lessThanOrEqualTo(screen.width), reason: label);
      expect(rect.bottom, lessThanOrEqualTo(screen.height), reason: label);
    }
    expect(photo(tester).height, greaterThan(200));
    await screenshot(tester, 'android-pixel9-0-empty');

    // Pen: a loop round the sun.
    await draw(tester, [
      for (var i = 0; i <= 24; i++) (0.77 + 0.1 * cos(i / 24 * 6.6), 0.23 + 0.13 * sin(i / 24 * 6.6)),
    ]);
    expect(items(tester).single, isA<MarkupLine>());
    await screenshot(tester, 'android-pixel9-1-pen');

    // Highlighter, in yellow, held still before moving: it still draws.
    await choose(tester, t.editor_markup_highlighter);
    await pick(tester, '${t.color} 3');
    await draw(tester, [(0.3, 0.45), (0.5, 0.45), (0.7, 0.45)], hold: const Duration(milliseconds: 700));
    expect((items(tester).last as MarkupLine).kind, MarkupLineKind.highlighter);
    await screenshot(tester, 'android-pixel9-2-highlighter');

    // Shapes: an arrow, a box and a circle.
    await choose(tester, t.editor_markup_shapes);
    await pick(tester, '${t.color} 7');
    await draw(tester, [(0.15, 0.15), (0.2, 0.35), (0.28, 0.55)]);
    await choose(tester, t.editor_markup_box);
    await pick(tester, '${t.color} 8');
    await draw(tester, [(0.3, 0.6), (0.4, 0.7), (0.48, 0.86)]);
    await choose(tester, t.editor_markup_circle);
    await pick(tester, '${t.color} 5');
    await draw(tester, [(0.5, 0.58), (0.6, 0.7), (0.66, 0.9)]);
    expect(items(tester).whereType<MarkupShape>().map((s) => s.kind), [
      MarkupShapeKind.arrow,
      MarkupShapeKind.box,
      MarkupShapeKind.circle,
    ]);
    final sizeLabel = tester.getRect(find.text(t.size).last);
    expect(sizeLabel.bottom, lessThanOrEqualTo(screen.height - 80), reason: 'the tools fit without scrolling');
    await screenshot(tester, 'android-pixel9-3-shapes');

    // Text: a tap places it, it's typed in the field, and dragged to move it.
    await choose(tester, t.editor_markup_text);
    await pick(tester, '${t.color} 7');
    await tester.tapAt(at(tester, 0.75, 0.62));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Beach day!');
    await tester.pumpAndSettle();
    final placed = items(tester).last as MarkupText;
    expect(placed.text, 'Beach day!');
    await draw(tester, [for (var i = 0; i <= 10; i++) (0.75 - i * 0.002, 0.62 + i * 0.008)]);
    expect((items(tester).last as MarkupText).at.dy, greaterThan(placed.at.dy + 0.05));

    // Its corner handle makes it bigger.
    MarkupText text() => items(tester).last as MarkupText;
    final config = tester.widget<MarkupLayer>(find.byType(MarkupLayer)).editor.config!;
    final small = text();
    final corner = photo(tester).topLeft + markupTextBox(small, photo(tester).size, config).bottomRight;
    final handle = await tester.startGesture(corner + const Offset(8, 8));
    for (var i = 1; i <= 10; i++) {
      await handle.moveTo(corner + Offset(8 + i * 3, 8 + i * 1));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await handle.up();
    await tester.pumpAndSettle();
    expect(text().fontSize, greaterThan(small.fontSize * 1.1));
    expect(text().at, small.at);
    await screenshot(tester, 'android-pixel9-4-text');

    // So does pinching it; lifting one finger and moving the other then does nothing.
    final before = text();
    final count = items(tester).length;
    final middle = at(tester, before.at.dx, before.at.dy);
    final first = await tester.startGesture(middle - const Offset(20, 0));
    final second = await tester.startGesture(middle + const Offset(20, 0), pointer: 7);
    for (var i = 1; i <= 10; i++) {
      await first.moveTo(middle - Offset(20.0 + i * 3, 0));
      await second.moveTo(middle + Offset(20.0 + i * 3, 0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await second.up();
    await tester.pump();
    final pinched = text();
    expect(pinched.fontSize, greaterThan(before.fontSize * 1.3));
    for (var i = 1; i <= 10; i++) {
      await first.moveTo(middle - Offset(50.0 - i * 4, i * 4.0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await first.up();
    await tester.pumpAndSettle();
    expect(items(tester), hasLength(count));
    expect(text().at, pinched.at);
    expect(text().fontSize, pinched.fontSize);

    // Leaving asks first.
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text(t.editor_discard_edits_title), findsOneWidget);
  });
  testWidgets('a short pen stroke stays a stroke, from where the finger touched down', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());
    final down = at(tester, 0.3, 0.3);
    final gesture = await tester.startGesture(down);
    for (var i = 1; i <= 4; i++) {
      await gesture.moveTo(down + Offset(3.0 * i, 0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pumpAndSettle();
    final line = items(tester).single as MarkupLine;
    final rect = photo(tester);
    Offset onScreen(Offset point) => rect.topLeft + Offset(point.dx * rect.width, point.dy * rect.height);
    expect(line.points, hasLength(5));
    expect(onScreen(line.points.first), within<Offset>(distance: 0.01, from: down));
    expect(onScreen(line.points[1]), within<Offset>(distance: 0.01, from: down + const Offset(3, 0)));
    expect(onScreen(line.points.last), within<Offset>(distance: 0.01, from: down + const Offset(12, 0)));
  });

  testWidgets('while drawing only the markup repaints, and Undo with another finger ends the line', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());
    final t = tester.element(find.byType(AppBar)).t;
    await draw(tester, [(0.2, 0.2), (0.3, 0.25), (0.4, 0.3)]);
    final first = items(tester).single;

    var notified = 0;
    editor(tester).addListener(() => notified++);
    var photoPaints = 0;
    var markupPaints = 0;
    debugOnProfilePaint = (object) {
      if (object is RenderCustomPaint) {
        final painter = object.painter.runtimeType.toString();
        photoPaints += painter == '_AdjustPainter' ? 1 : 0;
        markupPaints += painter == '_MarkupPainter' ? 1 : 0;
      }
    };

    final gesture = await tester.startGesture(at(tester, 0.5, 0.5));
    await tester.pump();
    expect(items(tester), hasLength(2)); // the line is there from the start (Undo works)
    final (notifiedAtDown, photoAtDown, markupAtDown) = (notified, photoPaints, markupPaints);
    for (var i = 1; i <= 24; i++) {
      await gesture.moveTo(at(tester, 0.5 + i * 0.01, 0.5 + i * 0.005));
      await tester.pump(const Duration(milliseconds: 16));
    }
    debugOnProfilePaint = null; // (a test must leave it unset)
    expect(notified, notifiedAtDown);
    expect(photoPaints, photoAtDown);
    expect(markupPaints - markupAtDown, greaterThanOrEqualTo(24));
    // The editor has the whole line so far (Save would take it), not only where it started.
    expect((items(tester).last as MarkupLine).points.length, greaterThan(20));
    await screenshot(tester, 'android-pixel9-5-drawing');

    // Undo with another finger takes the line away; moving on draws nothing more, and the line
    // before it isn't touched.
    final undo = await tester.startGesture(tester.getCenter(find.byTooltip(t.undo)), pointer: 9);
    await undo.up();
    await tester.pump();
    expect(items(tester), [first]);
    for (var i = 1; i <= 5; i++) {
      await gesture.moveTo(at(tester, 0.75 - i * 0.01, 0.6));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pumpAndSettle();
    expect(items(tester).single, same(first));

    // The next stroke draws as usual, once in the editor when the finger lifts.
    await draw(tester, [(0.6, 0.2), (0.7, 0.2), (0.8, 0.2)]);
    expect((items(tester).last as MarkupLine).points.length, greaterThan(2));
  });

  testWidgets("the field shows the text picked, also when an emptied one before it goes; a pinch from outside "
      'a text resizes it', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());
    final t = tester.element(find.byType(AppBar)).t;
    await choose(tester, t.editor_markup_text);
    Future<void> tap(double x, double y) async {
      await tester.tapAt(at(tester, x, y));
      await tester.pumpAndSettle();
    }

    Future<void> type(String text) async {
      await tester.enterText(find.byType(TextField), text);
      await tester.pumpAndSettle();
    }

    String field() => tester.widget<TextField>(find.byType(TextField)).controller!.text;

    await tap(0.25, 0.3);
    await type('a');
    await tap(0.5, 0.95); // stops editing it
    await tap(0.7, 0.6);
    await type('Bee');
    await tap(0.5, 0.95);
    await tap(0.25, 0.3);
    expect(field(), 'a');
    await type(''); // emptied: it goes when another is picked
    await tap(0.7, 0.6);
    expect(items(tester), hasLength(1));
    expect(field(), 'Bee');
    await type('Bees');
    expect((items(tester).single as MarkupText).text, 'Bees');

    // Two fingers either side of it, both outside its box, pinching out.
    final before = items(tester).single as MarkupText;
    final config = editor(tester).config!;
    final box = markupTextBox(before, photo(tester).size, config).shift(photo(tester).topLeft);
    final left = await tester.startGesture(box.centerLeft - const Offset(30, 0));
    final right = await tester.startGesture(box.centerRight + const Offset(30, 0), pointer: 7);
    for (var i = 1; i <= 10; i++) {
      await left.moveTo(box.centerLeft - Offset(30.0 + i * 3, 0));
      await right.moveTo(box.centerRight + Offset(30.0 + i * 3, 0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await left.up();
    await right.up();
    await tester.pumpAndSettle();
    final after = items(tester).single as MarkupText;
    expect(after.fontSize, greaterThan(before.fontSize * 1.2));
    expect((after.text, after.at), (before.text, before.at));
    expect(editor(tester).selected, 0);
  });

  testWidgets('leaving the tab while drawing keeps the line, and the pen draws again after', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());
    final t = tester.element(find.byType(AppBar)).t;
    final gesture = await tester.startGesture(at(tester, 0.2, 0.5));
    for (var i = 1; i <= 5; i++) {
      await gesture.moveTo(at(tester, 0.2 + i * 0.05, 0.5));
      await tester.pump(const Duration(milliseconds: 16));
    }
    final other = await tester.startGesture(tester.getCenter(find.text(t.filters).first), pointer: 9);
    await other.up();
    await tester.pumpAndSettle();
    await gesture.moveTo(at(tester, 0.6, 0.6));
    await gesture.up();
    await tester.pumpAndSettle();
    await tester.tap(find.text(t.editor_markup).first);
    await tester.pumpAndSettle();
    expect((items(tester).single as MarkupLine).points, hasLength(6));

    await draw(tester, [(0.3, 0.2), (0.4, 0.2), (0.5, 0.2)]);
    expect(items(tester), hasLength(2));
    expect((items(tester).last as MarkupLine).points.length, greaterThan(2));
  });

  testWidgets('Save pressed with another finger mid-stroke keeps the whole line, and the page hears of it', (
    tester,
  ) async {
    await pumpPage(tester, RemoteAssetFactory.create());
    final gesture = await tester.startGesture(at(tester, 0.2, 0.5));
    for (var i = 1; i <= 5; i++) {
      await gesture.moveTo(at(tester, 0.2 + i * 0.05, 0.5));
      await tester.pump(const Duration(milliseconds: 16));
    }
    var notified = 0;
    editor(tester).addListener(() => notified++);
    final save = await tester.startGesture(tester.getCenter(find.byIcon(Icons.done_rounded)), pointer: 9);
    await save.up();
    // Save starts (its spinner turns from now on, so the page never settles): the layer stops
    // drawing, and once that frame is over the page hears of the moves the editor held back.
    await tester.pump();
    await tester.pump();
    expect(find.byIcon(Icons.done_rounded), findsNothing);
    final line = items(tester).single as MarkupLine;
    expect(line.points, hasLength(6));
    expect(notified, greaterThan(0));

    // The finger goes on and lifts: the line Save took stays as it was.
    await gesture.moveTo(at(tester, 0.6, 0.6));
    await tester.pump(const Duration(milliseconds: 16));
    await gesture.up();
    await tester.pump();
    expect(items(tester).single, same(line));
  });

  for (final (textScale, name) in [(1.0, 'android-360-tabs'), (1.3, 'android-360-tabs-font-1.3')]) {
    testWidgets('on a phone 360 wide the five tabs fit on one row, with the font at $textScale×', (tester) async {
      await pumpPage(
        tester,
        RemoteAssetFactory.create(),
        screen: _narrowScreen,
        pixelRatio: _narrowRatio,
        textScale: textScale,
      );
      final t = tester.element(find.byType(AppBar)).t;
      final width = _narrowScreen.width / _narrowRatio;
      final tabs = [t.crop, t.editor_adjust, t.filters, t.editor_straighten, t.editor_markup];
      final labels = [for (final label in tabs) find.text(label).first];
      final rects = [for (final label in labels) tester.getRect(label)];
      expect({for (final rect in rects) rect.center.dy.round()}, hasLength(1), reason: 'one row');
      expect({for (final rect in rects) rect.height.round()}, hasLength(1), reason: 'each name on one line');
      for (final (index, rect) in rects.indexed) {
        expect(rect.left, greaterThanOrEqualTo(0), reason: tabs[index]);
        expect(rect.right, lessThanOrEqualTo(width), reason: tabs[index]);
        expect(tester.renderObject<RenderParagraph>(labels[index]).didExceedMaxLines, isFalse, reason: tabs[index]);
      }
      for (var i = 1; i < rects.length; i++) {
        expect(rects[i].left, greaterThan(rects[i - 1].right), reason: '${tabs[i]} after ${tabs[i - 1]}');
      }
      await screenshot(tester, name);

      // Still a tab each: Filters opens.
      await tester.tap(labels[2]);
      await tester.pumpAndSettle();
      expect(find.text(t.none), findsOneWidget);
    });
  }
}
