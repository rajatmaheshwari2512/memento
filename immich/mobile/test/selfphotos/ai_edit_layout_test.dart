// SelfPhotos AI Edit: on a Pixel 9 (about 411×923 dp) the photo keeps most of the height below
// the app bar, with the whole tools panel (the Fixes, Styles and Highlight accordions, instruction
// box and Generate with the box's length and the edits left beside it) on screen without
// scrolling, the panel's text readable in light mode too, and the discard question in the app's
// own theme. Presets are in the Fixes and Styles accordions, whose headers say what's picked, and
// are only picked by a tap (several at once, by the rules in ai_tools.dart); Generate makes the
// one edit. Pumps the real page, opened as the app opens it, with the app's font and
// theme, a stand-in preview and a stand-in for Memento's extras service.
import 'dart:async';
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
import 'package:http/http.dart' show ClientException;
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/providers/theme.provider.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_export.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_native.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_tabs.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_align.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_area.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_edit.page.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_edit.service.dart';
import 'package:immich_mobile/selfphotos/ai_edit/ai_tools.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/theme/theme_data.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart' show AssetMediaSize;

import '../unit/factories/remote_asset_factory.dart';
import '../unit/presentation/presentation_context.dart';

// A Pixel 9: 1080×2424 pixels at 2.625, with its status bar and gesture bar.
const _pixelRatio = 2.625;
const _screen = Size(1080, 2424);
const _insets = FakeViewPadding(top: 48 * _pixelRatio, bottom: 24 * _pixelRatio);
const _keyboard = 300.0;

// 20 AI edits a day, 3 used; the server's monthly limit is far off. An edit (only when [result]
// is given) returns [result] as its picture, and uses one more; or throws [failure], if set. An
// edit of the photo is 'edit'; an edit of a result (Edit more), 'more', whose picture is [more]
// if given. [edits]: what each edit sent. [discarded]: the edits thrown away. [unloadable]: how
// many more times an edit's picture won't load. [arrival]: if set, an edit's picture comes only
// once it completes; [loads]: how many times one was asked for. [answer]: if set, an edit is made
// only once it completes. [saves] and [savedAreas]: the edits saved whole or not, and pasted;
// [areaRefusal]: what the service says to a pasted copy, if it refuses it.
class _Service extends AiEditService {
  final Uint8List? result;
  Uint8List? more;
  Exception? failure;
  int unloadable = 0;
  Completer<void>? arrival;
  Completer<void>? answer;
  int loads = 0;
  Exception? areaRefusal;
  final edits = <({String prompt, List<String> tools})>[];
  final discarded = <String>[];
  final saves = <({String editId, bool whole})>[];
  final savedAreas = <String>[];

  _Service({this.result, this.failure});

  @override
  Future<AiEditUsage?> usage() async =>
      const AiEditUsage(todayUsed: 3, todayLimit: 20, monthUsed: 100, monthLimit: 500);

  @override
  Future<({String editId, AiEditUsage? usage})> create(
    String assetId,
    String prompt, {
    String? fromEditId,
    List<String> tools = const [],
    Uint8List? mark,
    Uint8List? photo,
  }) async {
    edits.add((prompt: prompt, tools: tools));
    await answer?.future;
    final failure = this.failure;
    if (failure != null) {
      throw failure;
    }
    return (
      editId: fromEditId == null ? 'edit' : 'more',
      usage: const AiEditUsage(todayUsed: 4, todayLimit: 20, monthUsed: 101, monthLimit: 500),
    );
  }

  @override
  Future<Uint8List> image(String editId) async {
    loads++;
    await arrival?.future;
    if (unloadable > 0) {
      unloadable--;
      throw const AiEditException(500, "Couldn't load the edited photo (500).", code: aiEditImageUnavailable);
    }
    return editId == 'more' ? more ?? result! : result!;
  }

  @override
  Future<String> save(String editId, {bool whole = false}) async {
    saves.add((editId: editId, whole: whole));
    return 'copy';
  }

  @override
  Future<String> saveArea(String editId, Uint8List bytes, String mime) async {
    savedAreas.add(editId);
    final refusal = areaRefusal;
    if (refusal != null) {
      throw refusal;
    }
    return 'copy';
  }

  @override
  Future<void> discard(String editId) async => discarded.add(editId);
}

// How readable [text] is on [background] (WCAG: at least 4.5 for small text).
double _contrast(Color text, Color background) {
  final a = Color.alphaBlend(text, background).computeLuminance();
  final b = background.computeLuminance();
  return (max(a, b) + 0.05) / (min(a, b) + 0.05);
}

// The app's font: the test font's wide letters would wrap text more than the phone does.
Future<void> _loadFont() async {
  final sans = FontLoader('GoogleSans');
  for (final weight in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    sans.addFont(Future.value(ByteData.sublistView(File('fonts/GoogleSans/GoogleSans-$weight.ttf').readAsBytesSync())));
  }
  await sans.load();
}

// The tools file (ai-tools.json, shared with the web), as the page reads it.
final kit = AiToolkit.parse(File('../web/src/lib/ai-edit/ai/ai-tools.json').readAsStringSync());

// The too-large text with ai-tools.json's limits, as it read before it took them from there.
const _tooLarge = 'This photo is too large for AI edits (over 100 megapixels or 12,000 pixels on a side).';

// What the page logs, from now until the test ends (the tests turn logging off).
List<LogRecord> _logs() {
  final level = Logger.root.level;
  Logger.root.level = Level.ALL;
  final records = <LogRecord>[];
  final listening = Logger.root.onRecord.listen(records.add);
  addTearDown(() async {
    Logger.root.level = level;
    await listening.cancel();
  });
  return records;
}

// [message] logged, with [error] (a value or a matcher) as its cause.
Matcher _logged(String message, Object error) =>
    contains(isA<LogRecord>().having((r) => r.message, 'message', message).having((r) => r.error, 'error', error));

// The app's translations around [app].
Widget _localized(Widget Function(BuildContext context) app) => EasyLocalization(
  supportedLocales: locales.values.toList(),
  path: translationsPath,
  startLocale: locales.values.first,
  fallbackLocale: locales.values.first,
  saveLocale: false,
  useFallbackTranslations: true,
  assetLoader: const CodegenLoader(),
  child: Builder(builder: app),
);

void main() {
  late PresentationContext ctx;

  setUpAll(_loadFont);
  setUp(() async => ctx = await PresentationContext.create());
  tearDown(() async => ctx.dispose());

  // The AI page for a portrait photo (3:4, as a phone takes them), loaded and idle, AI tools on
  // unless [flags] say otherwise; the phone in dark mode unless [light]. [upright]: the photo as
  // read upright for a highlighted edit, standing in for the phone's side of it, read once
  // [reading] completes, if given. [align]: stands in for lining a result up with the photo;
  // [pasteOnto], for pasting its area onto the preview; [pasteBack], for pasting it at full size at
  // Save. Opened over an empty page, as the app opens it over the viewer. [previewLoads] false: the
  // preview never arrives (the test waits for what it needs).
  Future<void> pumpPage(
    WidgetTester tester,
    RemoteAsset asset, {
    bool light = false,
    MementoFlags flags = MementoFlags.unknown, // AI edits and tools on
    _Service? service,
    ui.Image? upright,
    Future<void>? reading,
    Future<AiAlignment> Function(ui.Image base, ui.Image result, List<AiStroke> strokes, AiAreaSettings area)? align,
    Future<ui.Image> Function(
      ui.Image base,
      ui.Image result,
      List<AiStroke> strokes,
      AiAreaSettings area, [
      AiAlignment alignment,
    ])?
    pasteOnto,
    Future<AdjustExport> Function()? pasteBack,
    bool previewLoads = true,
  }) async {
    tester.view
      ..physicalSize = _screen
      ..devicePixelRatio = _pixelRatio
      ..padding = _insets
      ..viewPadding = _insets;
    addTearDown(tester.view.reset);

    // The preview the page loads, already in the image cache. What an earlier test loaded
    // belongs to its own clock, so it goes first.
    rootBundle.clear();
    PaintingBinding.instance.imageCache
      ..clear()
      ..clearLiveImages();
    final preview = (await tester.runAsync(() => createTestImage(width: 300, height: 400, cache: false)))!;
    PaintingBinding.instance.imageCache.putIfAbsent(
      RemoteImageProvider(url: getThumbnailUrlForRemoteId(asset.id, type: AssetMediaSize.preview)),
      () => OneFrameImageStreamCompleter(
        previewLoads ? SynchronousFuture(ImageInfo(image: preview)) : Completer<ImageInfo>().future,
      ),
    );

    await tester.pumpWidget(
      _localized(
        (context) => ProviderScope(
          overrides: [
            ...ctx.overrides,
            mementoFeaturesProvider.overrideWithValue(flags),
            aiEditServiceProvider.overrideWithValue(service ?? _Service()),
            if (upright != null)
              aiUprightPhotoProvider.overrideWithValue((asset, area) async {
                await reading;
                return (jpeg: Uint8List(1), image: upright.clone()); // the page disposes it
              }),
            if (align != null) aiAlignProvider.overrideWithValue(align),
            if (pasteOnto != null) aiPasteOntoProvider.overrideWithValue(pasteOnto),
            if (pasteBack != null)
              aiPasteBackProvider.overrideWithValue(
                (asset, result, strokes, area, alignment, {onProgress}) => pasteBack(),
              ),
          ],
          child: Consumer(
            builder: (context, ref, _) {
              final theme = ref.watch(immichThemeProvider);
              return MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: getThemeData(colorScheme: light ? theme.light : theme.dark, locale: context.locale),
                localizationsDelegates: context.localizationDelegates,
                supportedLocales: context.supportedLocales,
                locale: context.locale,
                onGenerateRoute: (_) => MaterialPageRoute<bool>(builder: (_) => AiEditPage(asset: asset)),
                onGenerateInitialRoutes: (_) => [
                  MaterialPageRoute<void>(builder: (_) => const Scaffold()),
                  MaterialPageRoute<bool>(builder: (_) => AiEditPage(asset: asset)),
                ],
              );
            },
          ),
        ),
      ),
    );
    if (!previewLoads) {
      return;
    }
    // The tools file and the preview load outside the test's clock.
    for (var i = 0; i < 50 && find.byType(RawImage).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect(find.byType(RawImage), findsOneWidget);
    await tester.pumpAndSettle();
  }

  Rect photoArea(WidgetTester tester) =>
      tester.getRect(find.ancestor(of: find.byType(RawImage), matching: find.byType(Expanded)).first);

  ScrollPosition panelScroll(WidgetTester tester) => tester
      .state<ScrollableState>(
        find
            .descendant(
              of: find.byWidgetPredicate((w) => w is SingleChildScrollView && w.scrollDirection == Axis.vertical),
              matching: find.byType(Scrollable),
            )
            .first,
      )
      .position;

  double belowAppBar(WidgetTester tester) => _screen.height / _pixelRatio - tester.getRect(find.byType(AppBar)).bottom;

  // A small picture for an edit's result: the photo's shape (3:4) unless said.
  Future<Uint8List> resultPng(WidgetTester tester, {int width = 30, int height = 40}) async =>
      (await tester.runAsync(() async {
        final image = await createTestImage(width: width, height: height, cache: false);
        return (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      }))!;

  // The mark and the result's picture are made and read outside the test's clock: until [shown]
  // is on screen.
  Future<void> waitFor(WidgetTester tester, Finder shown) async {
    for (var i = 0; i < 100 && shown.evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.pumpAndSettle();
  }

  Future<void> waitForResult(WidgetTester tester) =>
      waitFor(tester, find.text(tester.element(find.byType(AppBar)).t.editor_ai_edit_more));

  // What happens outside the test's clock (pictures read, marks made, the page's own steps): until
  // [done] is true, or a while.
  Future<void> waitUntil(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 50 && !done(); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump();
    }
  }

  // Leaving while an edit is being made: it asks first (Immich's question), and the person
  // confirms; the page goes. (Its spinner never settles, so frames are pumped instead.)
  Future<void> leaveConfirmed(WidgetTester tester) async {
    final t = tester.element(find.byType(AppBar)).t;
    await tester.tap(find.byType(ImmichCloseButton));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byType(AlertDialog), findsOneWidget);
    await tester.tap(find.text(t.confirm));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(AiEditPage), findsNothing);
  }

  // The phone's side of the mark (ai_area.dart markedCopy), for a highlighted edit: it encodes a
  // file.
  void fakeMarkEncoding() {
    const native = MethodChannel('selfphotos/adjust_image');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(native, (call) async {
      if (call.method == 'encode') {
        File((call.arguments as Map)['path'] as String).writeAsBytesSync([0]);
      }
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(native, null));
  }

  // A context inside the app's translations, to read texts with.
  Future<BuildContext> localizedContext(WidgetTester tester) async {
    late BuildContext context;
    await tester.pumpWidget(
      _localized(
        (outer) => MaterialApp(
          localizationsDelegates: outer.localizationDelegates,
          supportedLocales: outer.supportedLocales,
          locale: outer.locale,
          home: Builder(
            builder: (inner) {
              context = inner;
              return const SizedBox();
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return context;
  }

  testWidgets('on a Pixel 9 the photo keeps most of the height, the tools all on screen', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());

    // 480 of 819 dp (59%) with the Fixes, Styles and Highlight accordions closed (as with the
    // presets' one row and Highlight before) and the box's length and the edits left beside
    // Generate; 452 (55%) with the brush in a row, the length under the box and the
    // edits left at the bottom; 528 (64%) with one-line pills; 273 (33%) with the editor's tabs
    // and the price.
    expect(photoArea(tester).height / belowAppBar(tester), greaterThanOrEqualTo(0.58));
    expect(panelScroll(tester).maxScrollExtent, 0); // nothing of the panel hidden
    final generate = find.ancestor(
      of: find.text('Generate'),
      matching: find.byWidgetPredicate((w) => w is FilledButton),
    );
    expect(tester.getRect(generate).bottom, lessThanOrEqualTo(_screen.height / _pixelRatio));
    expect(tester.getSize(generate).height, greaterThanOrEqualTo(48));

    // The box's length and the AI edits left are on Generate's row, to its left (and only there).
    for (final text in ['0/500', '17 AI edits left today']) {
      final box = tester.getRect(find.text(text));
      expect(box.right, lessThan(tester.getRect(generate).left), reason: text);
      expect(box.top, greaterThanOrEqualTo(tester.getRect(generate).top), reason: text);
      expect(box.bottom, lessThanOrEqualTo(tester.getRect(generate).bottom), reason: text);
    }

    // The instruction box's hint (with the AI tools on, it also says how to brush) shows whole.
    final t = tester.element(find.byType(TextField)).t;
    expect(tester.renderObject<RenderParagraph>(find.text(t.editor_ai_describe_or_brush)).didExceedMaxLines, isFalse);

    // The Highlight accordion starts closed: its header, with undo and clear, but not how to
    // brush or the brush size.
    expect(find.text(t.editor_ai_highlight), findsOneWidget);
    expect(find.byIcon(Icons.undo), findsOneWidget);
    expect(find.byIcon(Icons.delete_outline), findsOneWidget);
    expect(find.text(t.editor_ai_highlight_description), findsNothing);
    expect(find.byType(Slider), findsNothing);
    // Nothing brushed yet: undo is off, and tapping it leaves the accordion closed.
    await tester.tap(find.byIcon(Icons.undo));
    await tester.pumpAndSettle();
    expect(find.byType(Slider), findsNothing);
  });

  testWidgets('with the Highlight accordion closed, brushing and undo still work', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());

    await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.undo));
    await tester.pumpAndSettle();
    expect(find.byType(Slider), findsNothing); // still closed

    // The stroke is gone, so leaving doesn't ask (with it, it does: see the discard question).
    await tester.tap(find.byType(ImmichCloseButton));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('opened, the Highlight accordion says how to brush and has the brush size', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());

    final t = tester.element(find.byType(TextField)).t;
    await tester.tap(find.text(t.editor_ai_highlight));
    await tester.pumpAndSettle();

    expect(find.text(t.editor_ai_highlight_description), findsOneWidget);
    // The brush size slider has no label row, but still says what it is.
    final semantics = tester.ensureSemantics();
    expect(tester.getSemantics(find.byType(Slider)), isSemantics(label: 'Brush size', isSlider: true));
    semantics.dispose();
    // 416 of 819 dp (51%) with it open, and still nothing of the panel hidden.
    expect(photoArea(tester).height / belowAppBar(tester), greaterThanOrEqualTo(0.5));
    expect(panelScroll(tester).maxScrollExtent, 0);

    await tester.tap(find.text(t.editor_ai_highlight));
    await tester.pumpAndSettle();
    expect(find.text(t.editor_ai_highlight_description), findsNothing);
    expect(find.byType(Slider), findsNothing);
  });

  testWidgets('on a phone in light mode the panel\'s text is still light on the dark panel', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create(), light: true);

    final t = tester.element(find.byType(TextField)).t;
    await tester.tap(find.text(t.editor_ai_highlight));
    await tester.pumpAndSettle();

    final panel = tester
        .widgetList<Container>(find.ancestor(of: find.byType(TextField), matching: find.byType(Container)))
        .map((container) => container.decoration)
        .whereType<BoxDecoration>()
        .first
        .color!;
    for (final text in [
      t.editor_ai_fixes,
      t.editor_ai_styles,
      t.editor_ai_highlight,
      t.editor_ai_highlight_description,
      '0/500',
      '17 AI edits left today',
    ]) {
      final colour = tester.renderObject<RenderParagraph>(find.text(text)).text.style!.color!;
      expect(_contrast(colour, panel), greaterThanOrEqualTo(4.5), reason: text);
    }
  });

  testWidgets('on a phone in light mode the discard question is in the app\'s light theme, as on Immich\'s '
      'crop screen', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create(), light: true);

    // A brush stroke: leaving now asks first.
    await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(ImmichCloseButton));
    await tester.pumpAndSettle();

    final dialog = find.byType(AlertDialog);
    expect(dialog, findsOneWidget);
    expect(Theme.of(tester.element(dialog)).brightness, Brightness.light);
  });

  testWidgets('with the AI tools off there\'s no brush, and the hint doesn\'t mention brushing', (tester) async {
    final toolsOff = MementoFlags.fromJson({
      'flags': {
        'gemini': {'enabled': true, 'tools': false},
      },
    });
    await pumpPage(tester, RemoteAssetFactory.create(), flags: toolsOff);

    final t = tester.element(find.byType(TextField)).t;
    expect(find.text(t.editor_ai_describe), findsOneWidget);
    expect(find.text(t.editor_ai_describe_or_brush), findsNothing);
    expect(find.text(t.editor_ai_highlight), findsNothing); // nor is there a brush
  });

  testWidgets('with a result, "edits left today" shows at the bottom; after Edit more, beside Generate again', (
    tester,
  ) async {
    await pumpPage(tester, RemoteAssetFactory.create(), service: _Service(result: await resultPng(tester)));

    final t = tester.element(find.byType(AppBar)).t; // the box goes while the result shows
    await tester.enterText(find.byType(TextField), 'brighter');
    await tester.pump();
    await tester.tap(find.text(t.editor_ai_generate));
    await waitForResult(tester);

    final left = find.text('16 AI edits left today');
    expect(left, findsOneWidget);
    expect(tester.getRect(left).top, greaterThan(tester.getRect(find.text(t.editor_ai_edit_more)).bottom));

    await tester.tap(find.text(t.editor_ai_edit_more));
    await tester.pumpAndSettle();
    expect(left, findsOneWidget);
    final editResult = tester.getRect(
      find.ancestor(of: find.text(t.editor_ai_edit_result), matching: find.byWidgetPredicate((w) => w is FilledButton)),
    );
    expect(tester.getRect(left).right, lessThan(editResult.left));
    expect(tester.getRect(left).bottom, lessThanOrEqualTo(editResult.bottom));
  });

  group('picking presets', () {
    AiTool tool(String id) => kit.tools.firstWhere((t) => t.id == id);

    Finder preset(String label) => find.widgetWithText(AdjustChoice, label);
    bool picked(WidgetTester tester, String label) => tester.widget<AdjustChoice>(preset(label)).selected;
    Iterable<AdjustChoice> allPicked(WidgetTester tester) =>
        tester.widgetList<AdjustChoice>(find.byType(AdjustChoice)).where((choice) => choice.selected);
    // Generate (or "Edit result"): the panel's one filled button while writing.
    bool canGenerate(WidgetTester tester) =>
        tester.widget<FilledButton>(find.byWidgetPredicate((w) => w is FilledButton)).onPressed != null;

    // A group's accordion header, and what it says.
    Finder header(AiGroup group) => find.descendant(of: find.byKey(ValueKey(group)), matching: find.byType(ListTile));
    String headerText(WidgetTester tester, AiGroup group) =>
        tester.widget<Text>(find.descendant(of: header(group), matching: find.byType(Text))).data!;
    Future<void> toggleGroup(WidgetTester tester, AiGroup group) async {
      await tester.ensureVisible(header(group));
      await tester.pumpAndSettle();
      await tester.tap(header(group));
      await tester.pumpAndSettle();
    }

    List<String> labels(BuildContext context, AiGroup group) => [
      for (final tool in kit.tools)
        if (tool.group == group) tool.label(context),
    ];

    // Taps a preset, opening its group's accordion first if it's closed.
    Future<void> tapPreset(WidgetTester tester, String label) async {
      if (preset(label).evaluate().isEmpty) {
        final context = tester.element(find.byType(AppBar));
        await toggleGroup(tester, kit.tools.firstWhere((tool) => tool.label(context) == label).group);
      }
      await tester.ensureVisible(preset(label));
      await tester.pumpAndSettle();
      await tester.tap(preset(label));
      await tester.pumpAndSettle();
    }

    // A refusal shows as a toast for 3 seconds: let it go.
    Future<void> toastGone(WidgetTester tester) async {
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
    }

    testWidgets('Fixes, then Styles, then Highlight, then the box: accordions, all closed when the page opens', (
      tester,
    ) async {
      await pumpPage(tester, RemoteAssetFactory.create());

      final t = tester.element(find.byType(TextField)).t;
      final tops = [
        tester.getRect(header(AiGroup.fix)).top,
        tester.getRect(header(AiGroup.style)).top,
        tester.getRect(find.text(t.editor_ai_highlight)).top,
        tester.getRect(find.byType(TextField)).top,
      ];
      expect(tops, [...tops]..sort());
      expect(headerText(tester, AiGroup.fix), t.editor_ai_fixes);
      expect(headerText(tester, AiGroup.style), t.editor_ai_styles);
      expect(find.byType(AdjustChoice), findsNothing); // no presets showing
      expect(find.byType(Slider), findsNothing);
      // The headers are as high as Highlight's, a line each.
      final highlight = find.ancestor(of: find.text(t.editor_ai_highlight), matching: find.byType(ListTile));
      for (final group in AiGroup.values) {
        expect(tester.getSize(header(group)).height, tester.getSize(highlight).height);
      }
    });

    testWidgets('opened, a group shows its presets in one row, lined up; closed, they go', (tester) async {
      await pumpPage(tester, RemoteAssetFactory.create());

      final context = tester.element(find.byType(TextField));
      final t = context.t;
      final fixes = labels(context, AiGroup.fix);
      await toggleGroup(tester, AiGroup.fix);
      expect(find.byType(AdjustChoice), findsNWidgets(fixes.length));
      expect(find.byType(AdjustChoiceRow), findsOneWidget);
      // The same width each, all their icons on one line (also beside "Remove reflections", whose
      // name is on two lines), and each name centred under its icon.
      final widths = {
        for (final choice in find.byType(AdjustChoice).evaluate()) (choice.renderObject! as RenderBox).size.width,
      };
      expect(widths, {AdjustChoiceRow.cellWidth});
      Finder icon(String label) => find.descendant(of: preset(label), matching: find.byType(Icon));
      expect({for (final label in fixes) tester.getRect(icon(label)).top}, hasLength(1));
      for (final label in fixes) {
        expect(tester.getCenter(find.text(label)).dx, closeTo(tester.getCenter(icon(label)).dx, 0.5), reason: label);
      }
      expect(
        tester.getSize(find.text(t.editor_ai_tool_reflections)).height,
        greaterThan(tester.getSize(find.text(t.editor_ai_tool_enhance)).height),
      );
      // 384 of 819 dp (47%) with it open, and still nothing of the panel hidden.
      expect(photoArea(tester).height / belowAppBar(tester), greaterThanOrEqualTo(0.46));
      expect(panelScroll(tester).maxScrollExtent, 0);

      await toggleGroup(tester, AiGroup.fix);
      expect(find.byType(AdjustChoice), findsNothing);
      await toggleGroup(tester, AiGroup.style);
      expect(
        tester.widgetList<AdjustChoice>(find.byType(AdjustChoice)).map((choice) => choice.label),
        labels(context, AiGroup.style),
      );
    });

    testWidgets('each header says what\'s picked in its group, open or closed', (tester) async {
      await pumpPage(tester, RemoteAssetFactory.create());

      final t = tester.element(find.byType(TextField)).t;
      final oneLine = tester.getSize(header(AiGroup.fix)).height;
      await tapPreset(tester, t.editor_ai_tool_enhance);
      await tapPreset(tester, t.editor_ai_tool_unblur);
      await tapPreset(tester, t.editor_ai_tool_watercolour);
      expect(headerText(tester, AiGroup.fix), 'Fixes · Enhance, Unblur');
      expect(headerText(tester, AiGroup.style), 'Styles · Watercolour');

      await toggleGroup(tester, AiGroup.fix);
      await toggleGroup(tester, AiGroup.style);
      expect(find.byType(AdjustChoice), findsNothing);
      expect(headerText(tester, AiGroup.fix), 'Fixes · Enhance, Unblur');
      expect(headerText(tester, AiGroup.style), 'Styles · Watercolour');
      // All closed, with the Highlight header saying why brushing is off (a style is picked):
      // 457 of 819 dp (56%), as with the presets' one row before.
      expect(photoArea(tester).height / belowAppBar(tester), greaterThanOrEqualTo(0.55));
      expect(panelScroll(tester).maxScrollExtent, 0);

      // Unpicked: just the group's name again.
      await tapPreset(tester, t.editor_ai_tool_watercolour);
      expect(headerText(tester, AiGroup.style), t.editor_ai_styles);

      // Too long for the line: cut with "…", still one line.
      await tapPreset(tester, t.editor_ai_tool_enhance);
      await tapPreset(tester, t.editor_ai_tool_unblur);
      for (final label in [t.editor_ai_tool_relight, t.editor_ai_tool_reflections, t.editor_ai_tool_glare]) {
        await tapPreset(tester, label);
      }
      const long = 'Fixes · Portrait light, Remove reflections, Remove glare';
      expect(headerText(tester, AiGroup.fix), long);
      final paragraph = tester.renderObject<RenderParagraph>(find.text(long));
      expect(paragraph.didExceedMaxLines, isTrue);
      expect(paragraph.text.toPlainText(), long);
      expect(tester.widget<Text>(find.text(long)).overflow, TextOverflow.ellipsis);
      expect(tester.getSize(header(AiGroup.fix)).height, oneLine);
    });

    testWidgets('a tap only picks a preset: Generate makes one edit of them all, and the result clears them', (
      tester,
    ) async {
      final service = _Service(result: await resultPng(tester));
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);

      final t = tester.element(find.byType(AppBar)).t; // the box goes while the result shows
      expect(canGenerate(tester), isFalse);
      final labels = [t.editor_ai_tool_watercolour, t.editor_ai_tool_enhance, t.editor_ai_tool_sky];
      for (final label in labels) {
        await tapPreset(tester, label);
      }
      expect(service.edits, isEmpty);
      expect(allPicked(tester), hasLength(3));
      for (final label in labels) {
        expect(picked(tester, label), isTrue, reason: label);
      }
      expect(canGenerate(tester), isTrue); // no words needed with presets

      await tester.enterText(find.byType(TextField), 'make it warmer');
      await tester.pump();
      await tester.tap(find.text(t.editor_ai_generate));
      await waitForResult(tester);

      expect(service.edits, hasLength(1));
      expect(service.edits.single.tools, ['enhance', 'sky', 'watercolour']);
      expect(
        service.edits.single.prompt,
        combinedInstruction([tool('enhance'), tool('sky'), tool('watercolour')], 'make it warmer'),
      );
      expect(find.text('“Enhance + Better sky + Watercolour + make it warmer”'), findsOneWidget);

      // Edit more starts again with nothing picked and no words, the groups still open as they
      // were left (remembered for the visit).
      await tester.tap(find.text(t.editor_ai_edit_more));
      await tester.pumpAndSettle();
      expect(find.byType(AdjustChoice), findsNWidgets(kit.tools.length));
      expect(allPicked(tester), isEmpty);
      expect(headerText(tester, AiGroup.fix), t.editor_ai_fixes);
      expect(headerText(tester, AiGroup.style), t.editor_ai_styles);
      expect(canGenerate(tester), isFalse);
    });

    testWidgets('a second tap unpicks; with 3 picked the others say why; Move goes alone, its words where to', (
      tester,
    ) async {
      final service = _Service();
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);

      final t = tester.element(find.byType(TextField)).t;
      await tapPreset(tester, t.editor_ai_tool_glare);
      await tapPreset(tester, t.editor_ai_tool_glare);
      expect(allPicked(tester), isEmpty);
      expect(canGenerate(tester), isFalse);

      for (final label in [t.editor_ai_tool_enhance, t.editor_ai_tool_unblur, t.editor_ai_tool_relight]) {
        await tapPreset(tester, label);
      }
      await tapPreset(tester, t.editor_ai_tool_sky);
      expect(picked(tester, t.editor_ai_tool_sky), isFalse);
      expect(find.text(t.editor_ai_up_to(count: 3)), findsOneWidget);
      await toastGone(tester);

      // Move needs a highlight (that's what it says, even with 3 picked), and replaces the others.
      await tapPreset(tester, t.editor_ai_tool_move);
      expect(picked(tester, t.editor_ai_tool_move), isFalse);
      expect(find.text(t.editor_ai_needs_highlight), findsOneWidget);
      await toastGone(tester);
      await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
      await tester.pumpAndSettle();
      await tapPreset(tester, t.editor_ai_tool_move);
      expect(allPicked(tester).map((choice) => choice.label), [t.editor_ai_tool_move]);
      expect(find.text(t.editor_ai_tool_move_ask), findsOneWidget);
      expect(find.text('0/150'), findsOneWidget);
      expect(canGenerate(tester), isFalse); // where to?
      await tester.enterText(find.byType(TextField), 'to the left');
      await tester.pump();
      expect(canGenerate(tester), isTrue);
      // Its highlight cleared: Move can't be made until there's one again.
      await tester.tap(find.byIcon(Icons.delete_outline));
      await tester.pumpAndSettle();
      expect(canGenerate(tester), isFalse);
      await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
      await tester.pumpAndSettle();
      expect(canGenerate(tester), isTrue);

      // Any other preset replaces Move.
      await tapPreset(tester, t.editor_ai_tool_erase);
      expect(allPicked(tester).map((choice) => choice.label), [t.editor_ai_tool_erase]);
      expect(find.text('11/500'), findsOneWidget);
      expect(service.edits, isEmpty);
    });

    testWidgets('the send key sends only typed words, and only when Generate is on', (tester) async {
      final service = _Service();
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);

      final t = tester.element(find.byType(TextField)).t;
      final box = find.byType(TextField);
      Future<void> sendKey() async {
        await tester.showKeyboard(box);
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();
      }

      // Presets and no words: Generate is on, the send key does nothing.
      await tapPreset(tester, t.editor_ai_tool_enhance);
      expect(canGenerate(tester), isTrue);
      await sendKey();
      expect(service.edits, isEmpty);
      await tapPreset(tester, t.editor_ai_tool_enhance);

      // Move with no words: Generate is off, and the send key does nothing.
      await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
      await tester.pumpAndSettle();
      await tapPreset(tester, t.editor_ai_tool_move);
      expect(canGenerate(tester), isFalse);
      await sendKey();
      expect(service.edits, isEmpty);
      // Its words typed, then its highlight cleared: Generate is off again, and so is the key.
      await tester.enterText(box, 'to the left');
      await tester.pump();
      await tester.tap(find.byIcon(Icons.delete_outline));
      await tester.pumpAndSettle();
      expect(canGenerate(tester), isFalse);
      await sendKey();
      expect(service.edits, isEmpty);

      // Words alone: the send key sends them.
      await tapPreset(tester, t.editor_ai_tool_move); // unpicked
      await tester.enterText(box, 'make it warmer');
      await sendKey();
      expect(service.edits, hasLength(1));
      expect(service.edits.single.prompt, 'make it warmer');
      expect(service.edits.single.tools, isEmpty);
    });

    testWidgets('one preset alone sends its id and its own instruction, as before', (tester) async {
      final service = _Service(result: await resultPng(tester));
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);

      final t = tester.element(find.byType(AppBar)).t; // the box goes while the result shows
      await tapPreset(tester, t.editor_ai_tool_unblur);
      await tester.tap(find.text(t.editor_ai_generate));
      await waitForResult(tester);

      expect(service.edits, hasLength(1));
      expect(service.edits.single.tools, ['unblur']);
      expect(service.edits.single.prompt, tool('unblur').instruction);
      expect(find.text('“${t.editor_ai_tool_unblur}”'), findsOneWidget);
    });

    testWidgets('a result that can\'t be pasted: Try again resends the same presets, and using it whole '
        'clears them', (tester) async {
      // The AI's picture in another shape (landscape, for a portrait photo): it can't be pasted.
      final landscape = await resultPng(tester, width: 40, height: 30);
      final upright = (await tester.runAsync(() => createTestImage(width: 300, height: 400, cache: false)))!;
      addTearDown(upright.dispose);
      fakeMarkEncoding();
      final service = _Service(result: landscape);
      await pumpPage(tester, RemoteAssetFactory.create(), service: service, upright: upright);

      final t = tester.element(find.byType(AppBar)).t; // the box goes while the result shows
      await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
      await tester.pumpAndSettle();
      await tapPreset(tester, t.editor_ai_tool_enhance);
      await tapPreset(tester, t.editor_ai_tool_sky);
      await tester.tap(find.text(t.editor_ai_generate));
      await tester.pump();
      final tryAgain = find.text(t.editor_ai_try_again);
      await waitFor(tester, tryAgain);
      expect(service.edits, hasLength(1));
      expect(service.edits.single.tools, ['enhance', 'sky']);
      // Still picked while the note shows.
      expect(picked(tester, t.editor_ai_tool_enhance), isTrue);
      expect(picked(tester, t.editor_ai_tool_sky), isTrue);

      await tester.tap(tryAgain);
      await tester.pump();
      await waitFor(tester, tryAgain);
      expect(service.edits, hasLength(2));
      expect(service.edits[1].tools, ['enhance', 'sky']);
      expect(service.edits[1].prompt, service.edits[0].prompt);

      // Used whole: the selection and the words are cleared.
      await tester.tap(find.text(t.editor_ai_use_whole));
      await tester.pumpAndSettle();
      expect(find.text('“Enhance + Better sky”'), findsOneWidget);
      await tester.tap(find.text(t.editor_ai_edit_more));
      await tester.pumpAndSettle();
      expect(allPicked(tester), isEmpty);
      expect(find.text('0/500'), findsOneWidget);
      expect(canGenerate(tester), isFalse);
    });

    testWidgets('a paid result is kept when lining it up fails some other way: its own note, then try again or '
        'use it whole', (tester) async {
      final records = _logs();
      final upright = (await tester.runAsync(() => createTestImage(width: 300, height: 400, cache: false)))!;
      addTearDown(upright.dispose);
      fakeMarkEncoding();
      final service = _Service(result: await resultPng(tester));
      // Lining up, off the screen's thread, fails (e.g. no memory for it there).
      await pumpPage(
        tester,
        RemoteAssetFactory.create(),
        service: service,
        upright: upright,
        align: (base, result, strokes, area) async => throw StateError('Isolate failed'),
      );

      final t = tester.element(find.byType(AppBar)).t; // the box goes while the result shows
      await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
      await tester.pumpAndSettle();
      await tapPreset(tester, t.editor_ai_tool_enhance);
      await tester.tap(find.text(t.editor_ai_generate));
      await tester.pump();
      final tryAgain = find.text(t.editor_ai_try_again);
      await waitFor(tester, tryAgain);

      // Kept, with its own note, no technical text and no error; nothing thrown away.
      expect(find.text(t.editor_ai_paste_failed), findsOneWidget);
      expect(find.text(t.editor_ai_shape_note), findsNothing);
      expect(find.textContaining('Isolate failed'), findsNothing);
      expect(find.textContaining(t.editor_ai_failed(error: '')), findsNothing);
      expect(service.discarded, isEmpty);
      expect(records, _logged('Pasting the highlighted area failed', isA<StateError>()));

      // Try again: the same edit again, the first try thrown away.
      await tester.tap(tryAgain);
      await tester.pump();
      await waitFor(tester, tryAgain);
      expect(service.edits, hasLength(2));
      expect(service.edits[1].prompt, service.edits[0].prompt);
      expect(service.discarded, ['edit']);

      // Used whole: the AI's whole result, kept.
      await tester.tap(find.text(t.editor_ai_use_whole));
      await tester.pumpAndSettle();
      expect(find.text('“${t.editor_ai_tool_enhance}”'), findsOneWidget);
      expect(find.text(t.editor_ai_whole_note), findsOneWidget);
      expect(service.discarded, ['edit']);
    });

    testWidgets('while a whole-photo preset is picked brushing is off, and the Highlight header says why', (
      tester,
    ) async {
      await pumpPage(tester, RemoteAssetFactory.create());

      final t = tester.element(find.byType(TextField)).t;
      final undo = find.ancestor(of: find.byIcon(Icons.undo), matching: find.byType(IconButton));
      bool brushed() => tester.widget<IconButton>(undo).onPressed != null;
      Future<void> brush() async {
        await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
        await tester.pumpAndSettle();
      }

      await tapPreset(tester, t.editor_ai_tool_sketch);
      expect(find.text(t.editor_ai_brush_whole_photo), findsOneWidget);
      await brush();
      expect(brushed(), isFalse);

      // Unpicked: brushing works again, and then the whole-photo presets can't be picked.
      await tapPreset(tester, t.editor_ai_tool_sketch);
      expect(find.text(t.editor_ai_brush_whole_photo), findsNothing);
      await brush();
      expect(brushed(), isTrue);
      await tapPreset(tester, t.editor_ai_tool_reframe);
      expect(picked(tester, t.editor_ai_tool_reframe), isFalse);
      expect(find.text(t.editor_ai_whole_only), findsOneWidget);
      await toastGone(tester);
    });
  });

  group('a paid result is never thrown away by a failure on the phone', () {
    // The AI's picture: the photo's shape (3:4).
    Future<_Service> paidService(WidgetTester tester) async => _Service(result: await resultPng(tester));
    // Lining up stands in as exact, so the area is pasted onto the preview.
    Future<AiAlignment> lined(ui.Image base, ui.Image result, List<AiStroke> strokes, AiAreaSettings area) async =>
        AiAlignment.identity;
    final copy = AdjustExport(Uint8List(1), 'image/jpeg', const AdjustSize(300, 400), fromPreview: false);

    // The AI page, with a stand-in for reading the photo upright (once [reading] completes, if
    // given) and for its mark; lining up is exact unless [align] says otherwise.
    Future<void> pumpHighlighting(
      WidgetTester tester,
      _Service service, {
      Future<AdjustExport> Function()? pasteBack,
      Future<void>? reading,
      Future<AiAlignment> Function(ui.Image base, ui.Image result, List<AiStroke> strokes, AiAreaSettings area)? align,
      Future<ui.Image> Function(
        ui.Image base,
        ui.Image result,
        List<AiStroke> strokes,
        AiAreaSettings area, [
        AiAlignment alignment,
      ])?
      pasteOnto,
    }) async {
      final upright = (await tester.runAsync(() => createTestImage(width: 300, height: 400, cache: false)))!;
      addTearDown(upright.dispose);
      fakeMarkEncoding();
      await pumpPage(
        tester,
        RemoteAssetFactory.create(),
        service: service,
        upright: upright,
        reading: reading,
        align: align ?? lined,
        pasteOnto: pasteOnto,
        pasteBack: pasteBack,
      );
    }

    // A stroke on the photo, a few words, Generate.
    Future<void> generateHighlighted(WidgetTester tester) async {
      final t = tester.element(find.byType(AppBar)).t;
      await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'brighter');
      await tester.pump();
      await tester.tap(find.text(t.editor_ai_generate));
      await tester.pump();
    }

    // A highlighted edit, until its result (its area pasted onto the preview) shows.
    Future<void> makeHighlightedEdit(WidgetTester tester) async {
      await generateHighlighted(tester);
      await waitForResult(tester);
      expect(find.text(tester.element(find.byType(AppBar)).t.editor_ai_area_note), findsOneWidget);
    }

    // A few words and Generate: an edit of the whole photo.
    Future<void> generateWords(WidgetTester tester) async {
      await tester.enterText(find.byType(TextField), 'brighter');
      await tester.pump();
      await tester.tap(find.text(tester.element(find.byType(AppBar)).t.editor_ai_generate));
      await tester.pump();
    }

    Future<void> save(WidgetTester tester) async {
      await tester.tap(find.byIcon(Icons.done_rounded));
      await tester.pump();
      for (var i = 0; i < 20; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump();
      }
      await tester.pumpAndSettle();
    }

    testWidgets('a paste that fails at full size at Save keeps the result: used whole, it saves the whole result', (
      tester,
    ) async {
      final records = _logs();
      final service = await paidService(tester);
      const failure = AdjustNativeException('too-large', 'Not enough memory.');
      await pumpHighlighting(tester, service, pasteBack: () async => throw failure);
      await makeHighlightedEdit(tester);
      final t = tester.element(find.byType(AppBar)).t;

      await save(tester);
      // Kept, with the note for Save (trying again is free) and both its buttons; nothing sent or
      // thrown away.
      expect(find.text(t.editor_ai_save_paste_failed), findsOneWidget);
      expect(find.text(t.editor_ai_paste_failed), findsNothing);
      expect(find.text(t.editor_ai_use_whole), findsOneWidget);
      expect(find.text(t.editor_ai_try_again), findsOneWidget);
      expect(find.textContaining(t.editor_ai_failed(error: '')), findsNothing);
      expect(service.savedAreas, isEmpty);
      expect(service.saves, isEmpty);
      expect(service.discarded, isEmpty);
      expect(records, _logged('Pasting the highlighted area at full size failed', failure));

      await tester.tap(find.text(t.editor_ai_use_whole));
      await tester.pumpAndSettle();
      expect(find.text(t.editor_ai_whole_note), findsOneWidget);
      await save(tester);
      expect(service.saves, [(editId: 'edit', whole: true)]);
      expect(service.edits, hasLength(1)); // no other edit made
      expect(find.byType(AiEditPage), findsNothing); // saved and closed
      await tester.pump(const Duration(seconds: 4)); // the "saved" toast goes
    });

    testWidgets('a paste that fails at full size at Save can be tried again: saved again, no new edit', (tester) async {
      final records = _logs();
      final service = await paidService(tester);
      var pastes = 0;
      await pumpHighlighting(
        tester,
        service,
        pasteBack: () async => ++pastes == 1 ? throw const OutOfMemoryError() : copy,
      );
      await makeHighlightedEdit(tester);
      final t = tester.element(find.byType(AppBar)).t;

      await save(tester);
      expect(find.text(t.editor_ai_save_paste_failed), findsOneWidget);
      expect(find.text(t.editor_ai_try_again), findsOneWidget);
      expect(records, _logged('Pasting the highlighted area at full size failed', isA<OutOfMemoryError>()));

      await tester.tap(find.text(t.editor_ai_try_again));
      await tester.pump();
      for (var i = 0; i < 20; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      expect(pastes, 2);
      expect(service.savedAreas, ['edit']);
      expect(service.edits, hasLength(1));
      expect(service.discarded, isEmpty);
      expect(find.byType(AiEditPage), findsNothing); // saved and closed
      await tester.pump(const Duration(seconds: 4)); // the "saved" toast goes
    });

    testWidgets('the service refusing the pasted copy is said in its words, and the result stays as it was', (
      tester,
    ) async {
      final records = _logs();
      const refusal = "That isn't this photo at its full size.";
      final service = await paidService(tester)
        ..areaRefusal = const AiEditException(400, refusal, fromService: true);
      await pumpHighlighting(tester, service, pasteBack: () async => copy);
      await makeHighlightedEdit(tester);
      final t = tester.element(find.byType(AppBar)).t;

      await save(tester);
      expect(service.savedAreas, ['edit']);
      expect(find.text(t.editor_ai_failed(error: refusal)), findsOneWidget);
      expect(find.text(t.editor_ai_edit_more), findsOneWidget);
      expect(find.text(t.editor_ai_save_paste_failed), findsNothing);
      expect(service.discarded, isEmpty);
      expect(records, _logged('Saving the edit failed', service.areaRefusal!));
    });

    testWidgets("an edit whose picture didn't load is kept, and loads again without a new edit", (tester) async {
      final records = _logs();
      final service = await paidService(tester)
        ..unloadable = 1;
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);
      final t = tester.element(find.byType(AppBar)).t;

      await tester.enterText(find.byType(TextField), 'brighter');
      await tester.pump();
      await tester.tap(find.text(t.editor_ai_generate));
      await tester.pump();
      await waitFor(tester, find.text(t.editor_ai_load_again));
      expect(find.text(t.editor_ai_load_failed), findsOneWidget);
      expect(find.textContaining(t.editor_ai_failed(error: '')), findsNothing);
      expect(service.discarded, isEmpty);
      final generate = find.ancestor(
        of: find.text(t.editor_ai_generate),
        matching: find.byWidgetPredicate((w) => w is FilledButton),
      );
      expect(tester.widget<FilledButton>(generate).onPressed, isNull);
      expect(records, _logged("Loading the edit's picture failed", isA<AiEditException>()));

      await tester.tap(find.text(t.editor_ai_load_again));
      await tester.pump();
      await waitForResult(tester);
      expect(find.text(t.editor_ai_load_failed), findsNothing);
      expect(find.text('“brighter”'), findsOneWidget);
      expect(service.edits, hasLength(1));
      expect(service.discarded, isEmpty);
    });

    testWidgets("leaving with an edit whose picture didn't load discards it, as before", (tester) async {
      final records = _logs();
      final service = await paidService(tester)
        ..unloadable = 1;
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);
      final t = tester.element(find.byType(AppBar)).t;

      await tester.enterText(find.byType(TextField), 'brighter');
      await tester.pump();
      await tester.tap(find.text(t.editor_ai_generate));
      await tester.pump();
      await waitFor(tester, find.text(t.editor_ai_load_again));
      expect(records, _logged("Loading the edit's picture failed", isA<AiEditException>()));

      // Leaving asks first, then the edit is discarded.
      await tester.tap(find.byType(ImmichCloseButton));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.text(t.confirm));
      await tester.pumpAndSettle();
      expect(find.byType(AiEditPage), findsNothing);
      expect(service.discarded, ['edit']);
    });

    testWidgets("an edit whose picture didn't load: failing to load it again has its own note, and Discard drops it", (
      tester,
    ) async {
      final records = _logs();
      final service = await paidService(tester)
        ..unloadable = 2;
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);
      final t = tester.element(find.byType(AppBar)).t;

      await tester.enterText(find.byType(TextField), 'brighter');
      await tester.pump();
      await tester.tap(find.text(t.editor_ai_generate));
      await tester.pump();
      await waitFor(tester, find.text(t.editor_ai_load_again));
      expect(find.textContaining(t.editor_ai_failed(error: '')), findsNothing);

      await tester.tap(find.text(t.editor_ai_load_again));
      await tester.pump();
      await waitFor(tester, find.text(t.editor_ai_load_failed_again));
      expect(find.text(t.editor_ai_load_failed), findsNothing);
      expect(find.textContaining(t.editor_ai_failed(error: '')), findsNothing);
      expect(records.where((record) => record.message == "Loading the edit's picture failed"), hasLength(2));

      // Discarded: back to writing the next edit; no other edit made.
      await tester.tap(find.text(t.editor_ai_discard));
      await tester.pumpAndSettle();
      expect(find.text(t.editor_ai_load_failed_again), findsNothing);
      expect(service.discarded, ['edit']);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
      expect(service.edits, hasLength(1));
    });

    testWidgets('while Save pastes the result, a kept Edit more try waits; a failed paste keeps both, with the '
        'error', (tester) async {
      final records = _logs();
      // Edit more's result is another shape (landscape), so its area can't be pasted: it's kept.
      final service = await paidService(tester)
        ..more = await resultPng(tester, width: 40, height: 30);
      final pasting = Completer<AdjustExport>();
      await pumpHighlighting(tester, service, pasteBack: () => pasting.future);
      await makeHighlightedEdit(tester);
      final t = tester.element(find.byType(AppBar)).t;

      await tester.tap(find.text(t.editor_ai_edit_more));
      await tester.pumpAndSettle();
      await tester.dragFrom(tester.getCenter(find.byType(RawImage)), const Offset(40, 40));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'warmer');
      await tester.pump();
      await tester.tap(find.text(t.editor_ai_edit_result));
      await tester.pump();
      await waitFor(tester, find.text(t.editor_ai_shape_note));
      expect(service.edits, hasLength(2));
      expect(records, _logged('Pasting the highlighted area failed', isA<ShapeChangedException>()));

      // Save, of the result Edit more was applied to: its full-size paste runs, and meanwhile the
      // kept try can't take that result's place.
      await tester.tap(find.byIcon(Icons.done_rounded));
      await tester.pump();
      final useWhole = find.ancestor(
        of: find.text(t.editor_ai_use_whole),
        matching: find.byWidgetPredicate((w) => w is FilledButton),
      );
      expect(tester.widget<FilledButton>(useWhole).onPressed, isNull);

      // The paste fails: said as an error; the result and the try both stay, nothing thrown away.
      const failure = AdjustNativeException('too-large', 'Not enough memory.');
      pasting.completeError(failure);
      for (var i = 0; i < 20; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      expect(find.text(t.editor_ai_failed(error: t.editor_ai_too_large_device)), findsOneWidget);
      expect(find.text(t.editor_ai_shape_note), findsOneWidget);
      expect(find.text(t.editor_ai_save_paste_failed), findsNothing);
      expect(tester.widget<FilledButton>(useWhole).onPressed, isNotNull);
      expect(service.savedAreas, isEmpty);
      expect(service.discarded, isEmpty);
      expect(records, _logged('Pasting the highlighted area at full size failed', failure));

      // Used whole now: the try takes the place of the result it was made from, which is discarded.
      await tester.tap(find.text(t.editor_ai_use_whole));
      await tester.pumpAndSettle();
      expect(find.text(t.editor_ai_whole_note), findsOneWidget);
      expect(service.discarded, ['edit']);
    });

    testWidgets('leaving while an edit is being made asks first; once left, the edit that arrives is discarded', (
      tester,
    ) async {
      final service = await paidService(tester)
        ..arrival = Completer<void>();
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);
      final t = tester.element(find.byType(AppBar)).t;

      await generateWords(tester);
      await waitUntil(tester, () => service.loads == 1);
      expect(service.loads, 1);

      // No result or highlight yet, but leaving asks first (Immich's question); cancelled, it stays.
      await tester.tap(find.byType(ImmichCloseButton));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      final question = find.byType(AlertDialog);
      expect(question, findsOneWidget);
      await tester.tap(find.descendant(of: question, matching: find.text(t.cancel)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(question, findsNothing);
      expect(find.byType(AiEditPage), findsOneWidget);
      expect(service.discarded, isEmpty);

      // Confirmed: it leaves, and the edit, when its picture arrives, is discarded.
      await leaveConfirmed(tester);
      service.arrival!.complete();
      await waitUntil(tester, () => service.discarded.isNotEmpty);
      expect(service.discarded, ['edit']);
    });

    testWidgets('an edit whose picture fails to load after the page was left is discarded, not kept', (tester) async {
      final service = await paidService(tester)
        ..unloadable = 1
        ..arrival = Completer<void>();
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);

      await generateWords(tester);
      await waitUntil(tester, () => service.loads == 1);
      await leaveConfirmed(tester);
      service.arrival!.complete();
      await waitUntil(tester, () => service.discarded.isNotEmpty);
      expect(service.discarded, ['edit']);
    });

    testWidgets('a highlighted edit whose area is refused after the page was left is discarded, not kept', (
      tester,
    ) async {
      final service = await paidService(tester);
      final aligning = Completer<void>();
      var aligned = false;
      await pumpHighlighting(
        tester,
        service,
        align: (base, result, strokes, area) async {
          aligned = true;
          await aligning.future;
          throw const ShapeChangedException();
        },
      );

      await generateHighlighted(tester);
      await waitUntil(tester, () => aligned);
      await leaveConfirmed(tester);
      aligning.complete();
      await waitUntil(tester, () => service.discarded.isNotEmpty);
      expect(service.discarded, ['edit']);
    });

    testWidgets('a highlighted edit whose area is pasted after the page was left is discarded', (tester) async {
      final service = await paidService(tester);
      final showing = Completer<void>();
      var pasted = false;
      await pumpHighlighting(
        tester,
        service,
        pasteOnto: (base, result, strokes, area, [alignment = AiAlignment.identity]) async {
          final shown = await pasteOnto(base, result, strokes, area, alignment);
          pasted = true;
          await showing.future;
          return shown;
        },
      );

      await generateHighlighted(tester);
      await waitUntil(tester, () => pasted);
      await leaveConfirmed(tester);
      showing.complete();
      await waitUntil(tester, () => service.discarded.isNotEmpty);
      expect(service.discarded, ['edit']);
    });

    testWidgets('leaving while the photo is still read for a highlighted edit sends no edit, so nothing is paid '
        'for', (tester) async {
      final service = await paidService(tester);
      final reading = Completer<void>();
      await pumpHighlighting(tester, service, reading: reading.future);

      await generateHighlighted(tester);
      await leaveConfirmed(tester);
      reading.complete();
      // Long enough for the photo to be read, its mark made and the edit sent, if it were.
      await waitUntil(tester, () => false);
      expect(service.edits, isEmpty);
    });

    testWidgets('an edit made after the page was left is discarded without downloading its picture', (tester) async {
      final service = await paidService(tester)
        ..answer = Completer<void>();
      await pumpPage(tester, RemoteAssetFactory.create(), service: service);

      await generateWords(tester);
      await waitUntil(tester, () => service.edits.isNotEmpty);
      await leaveConfirmed(tester);
      service.answer!.complete();
      await waitUntil(tester, () => service.discarded.isNotEmpty);
      expect(service.discarded, ['edit']);
      expect(service.loads, 0);
    });
  });

  testWidgets('with AI edits off there\'s no "edits left today"', (tester) async {
    final aiOff = MementoFlags.fromJson({
      'flags': {
        'gemini': {'enabled': false},
      },
    });
    await pumpPage(tester, RemoteAssetFactory.create(), flags: aiOff);

    expect(find.text(tester.element(find.byType(AppBar)).t.editor_ai_off), findsOneWidget);
    expect(find.textContaining('left today'), findsNothing);
  });

  testWidgets('a failure making an edit reads as plain words, never an exception\'s own text', (tester) async {
    final service = _Service(
      failure: ClientException('Connection refused', Uri.parse('https://example.com/extras/edits')),
    );
    await pumpPage(tester, RemoteAssetFactory.create(), service: service);

    final t = tester.element(find.byType(TextField)).t;
    await tester.enterText(find.byType(TextField), 'brighter');
    await tester.pump();
    Future<void> generate() async {
      await tester.ensureVisible(find.text(t.editor_ai_generate));
      await tester.pumpAndSettle();
      await tester.tap(find.text(t.editor_ai_generate));
      await tester.pumpAndSettle();
    }

    await generate();
    expect(find.text(t.editor_ai_failed(error: t.errors.unable_to_connect)), findsOneWidget);
    expect(find.textContaining('Connection refused'), findsNothing);
    expect(find.textContaining('ClientException'), findsNothing);

    // The service refuses a photo too large for AI edits.
    service.failure = const AiEditException(413, 'Too large.', code: aiEditPhotoTooLarge);
    await generate();
    expect(find.text(t.editor_ai_failed(error: _tooLarge)), findsOneWidget);

    service.failure = Exception('Invalid image data');
    await generate();
    expect(find.text(t.editor_ai_failed(error: t.errors.something_went_wrong)), findsOneWidget);
    expect(find.textContaining('Exception'), findsNothing);

    // The service's own words are already plain.
    service.failure = const AiEditException(429, 'You have used all your AI edits for today.', fromService: true);
    await generate();
    expect(find.text(t.editor_ai_failed(error: 'You have used all your AI edits for today.')), findsOneWidget);
  });

  // The web's test (ai-failure.spec.ts) checks the same.
  testWidgets('every failure reads as the service\'s own words or a translated text', (tester) async {
    final context = await localizedContext(tester);
    final t = context.t;
    String say(Object error) => aiEditFailure(context, error, kit);

    expect(
      say(const AiEditException(429, 'You have used all your AI edits for today.', fromService: true)),
      'You have used all your AI edits for today.',
    );
    expect(say(const AiEditException(413, 'Too large.', code: aiEditPhotoTooLarge)), _tooLarge);
    expect(aiTooLarge(context, kit), _tooLarge);
    expect(
      say(const AiEditException(500, "Couldn't load the edited photo (500).", code: aiEditImageUnavailable)),
      t.error_loading_image,
    );
    // The app's own English, when something other than the service answered.
    for (final own in [
      const AiEditException(502, "Memento's extras service answered 502."),
      const AiEditException(0, "Memento's extras service sent an unexpected answer."),
    ]) {
      expect(say(own), t.errors.something_went_wrong);
    }
    for (final offline in [
      ClientException('Connection refused'),
      const SocketException('Network is unreachable'),
      TimeoutException('No answer'),
    ]) {
      expect(say(offline), t.errors.unable_to_connect);
    }
    expect(
      say(const AdjustNativeException('unreadable', 'java.io.IOException: unknown format')),
      t.error_loading_image,
    );
    // Too large for the device's memory: no mention of a browser.
    expect(
      say(const AdjustNativeException('too-large', 'Not enough memory for a photo this large.')),
      t.editor_ai_too_large_device,
    );
    expect(say(const OutOfMemoryError()), t.editor_ai_too_large_device);
    expect(t.editor_ai_too_large_device, isNot(contains('browser')));
    expect(say(const NeedsOriginalException()), t.editor_ai_needs_original);
    // Never the shape note, which offers buttons only a kept result has.
    for (final other in [
      StateError('no element'),
      Exception('Invalid image data'),
      const AdjustNativeException('gpu', null),
      const ShapeChangedException(),
    ]) {
      expect(say(other), t.errors.something_went_wrong);
    }
  });

  testWidgets('a photo too large for AI edits says so in place of the tools, and nothing can be sent', (tester) async {
    final service = _Service();
    // 108 megapixels.
    await pumpPage(tester, RemoteAssetFactory.create().copyWith(width: 12000, height: 9000), service: service);

    final t = tester.element(find.byType(AppBar)).t;
    expect(find.text(_tooLarge), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    expect(find.text(t.editor_ai_generate), findsNothing);
    expect(find.text(t.editor_ai_highlight), findsNothing);
    // No brushing on the photo either.
    final photo = find.ancestor(of: find.byType(RawImage), matching: find.byType(Stack)).first;
    expect(find.descendant(of: photo, matching: find.byType(GestureDetector)), findsNothing);
    expect(service.edits, isEmpty);
  });

  testWidgets('a photo too large for AI edits says so at once, without waiting for its preview', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create().copyWith(width: 12000, height: 9000), previewLoads: false);

    for (var i = 0; i < 50 && find.text(_tooLarge).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect(find.text(_tooLarge), findsOneWidget);
    expect(find.byType(RawImage), findsNothing); // the preview is still loading
  });

  testWidgets('with the keyboard open the photo shrinks but stays usable', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create());

    tester.view.viewInsets = const FakeViewPadding(bottom: _keyboard * _pixelRatio);
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();

    // 231 dp when written; it was 87.
    expect(photoArea(tester).height, greaterThanOrEqualTo(200));
    expect(tester.getRect(find.byType(TextField)).bottom, lessThanOrEqualTo(_screen.height / _pixelRatio - _keyboard));
  });

  testWidgets('"edits left today" reads right for 0, 1 and several', (tester) async {
    final context = await localizedContext(tester);

    expect(context.t.editor_ai_left_today(count: 0), '0 AI edits left today');
    expect(context.t.editor_ai_left_today(count: 1), '1 AI edit left today');
    expect(context.t.editor_ai_left_today(count: 7), '7 AI edits left today');
  });

  test('"edits left today" is the closer of today\'s and this month\'s limits, never below 0', () {
    AiEditUsage usage(int todayUsed, int monthUsed) => AiEditUsage.fromJson({
      'today': {'used': todayUsed, 'limit': 20},
      'thisMonth': {'used': monthUsed, 'limit': 500, 'estimatedCostUsd': 1.5},
    })!;
    expect(usage(3, 100).editsLeft, 17); // today's
    expect(usage(3, 490).editsLeft, 10); // this month's
    expect(usage(20, 100).editsLeft, 0);
    expect(usage(25, 100).editsLeft, 0); // a lowered limit
    expect(usage(3, 520).editsLeft, 0);
  });
}
