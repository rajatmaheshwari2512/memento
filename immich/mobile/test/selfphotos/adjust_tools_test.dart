// SelfPhotos Adjust's Auto and Perspective on a Pixel 9 (about 411×923 dp). Auto is first in the
// Adjust tab's slider row and sets the sliders from the photo; again sets them again. Perspective
// is a mode of the Straighten tab: the photo shows whole with four corners that a finger drags
// (a magnifier shows the spot under it) and the result shows back in Straighten; Reset puts the
// corners back. Pumps the real page, opened as the app opens it, with the app's fonts and theme
// and a stand-in preview: a dull photo of a building that leans back.
//
// With SELFPHOTOS_SCREENSHOTS set to a folder, screenshots of each step are saved there.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/providers/theme.provider.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust.page.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_auto.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_geometry.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_params.dart';
import 'package:immich_mobile/selfphotos/adjust/adjust_tabs.dart';
import 'package:immich_mobile/selfphotos/adjust/markup_layer.dart';
import 'package:immich_mobile/selfphotos/adjust/perspective_corners.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/theme/theme_data.dart';

import '../unit/factories/remote_asset_factory.dart';
import '../unit/presentation/presentation_context.dart';
import 'pixel9.dart';

final _screenKey = GlobalKey();

// Where the building's corners are in the stand-in photo (shares of it): it leans back, narrower
// at the top.
const _building = [(0.32, 0.2), (0.68, 0.2), (0.82, 0.9), (0.18, 0.9)];

// A stand-in photo, portrait, dull and a little dark and blue: a pale sky, a grey building that
// leans back with rows of windows, and the ground.
Future<ui.Image> _photo() {
  const size = Size(300, 400);
  Offset at((double, double) p) => Offset(p.$1 * size.width, p.$2 * size.height);
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Offset.zero & size,
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, Offset(0, size.height * 0.9), [
        const Color(0xff8a9bb0),
        const Color(0xffa9b3bf),
      ]),
  );
  canvas.drawRect(
    Rect.fromLTRB(0, size.height * 0.9, size.width, size.height),
    Paint()..color = const Color(0xff5d6258),
  );
  canvas.drawPath(Path()..addPolygon(_building.map(at).toList(), true), Paint()..color = const Color(0xff7c7a7e));
  final windows = Paint()..color = const Color(0xff55565e);
  for (var row = 0; row < 9; row++) {
    final top = 0.24 + row * 0.072;
    final bottom = top + 0.04;
    for (final (from, to) in [(0.12, 0.3), (0.41, 0.59), (0.7, 0.88)]) {
      // Across the building at that height.
      (double, double) on(double share, double y) {
        final t = (y - 0.2) / 0.7;
        final left = 0.32 + (0.18 - 0.32) * t;
        final right = 0.68 + (0.82 - 0.68) * t;
        return (left + (right - left) * share, y);
      }

      canvas.drawPath(
        Path()..addPolygon([at(on(from, top)), at(on(to, top)), at(on(to, bottom)), at(on(from, bottom))], true),
        windows,
      );
    }
  }
  return recorder.endRecording().toImage(300, 400);
}

void main() {
  late PresentationContext ctx;
  late ui.Image preview;

  setUpAll(loadAppFonts);
  setUp(() async => ctx = await PresentationContext.create());
  tearDown(() async => ctx.dispose());

  // Adjust's page on [tab], opened over an empty page as the app opens it over the viewer; loaded
  // and idle.
  Future<void> pumpPage(WidgetTester tester, RemoteAsset asset, AdjustTab tab) async {
    usePixel9(tester);
    preview = (await tester.runAsync(_photo))!;
    cachePreview(asset, preview.clone());

    await tester.pumpWidget(
      RepaintBoundary(
        key: _screenKey,
        child: withAppTranslations(
          (context) => ProviderScope(
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
                    builder: (_) => AdjustPage(asset: asset, tab: tab, fromCropScreen: true),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    // The shader, the files and the preview load outside the test's clock.
    for (var i = 0; i < 100 && find.byType(CustomPaint).evaluate().length < 3; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();
  }

  Future<void> screenshot(WidgetTester tester, String name, {bool settle = true}) =>
      saveScreenshot(tester, find.byKey(_screenKey), name, settle: settle);

  // The slider shown, by its name: its value.
  double slider(WidgetTester tester, String label) =>
      tester.widget<LabelledSlider>(find.widgetWithText(LabelledSlider, label)).value;

  Future<void> tap(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  // A tap that runs code outside the test's clock (Auto reads the photo's pixels).
  Future<void> tapAndWait(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    for (var i = 0; i < 5; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    await tester.pumpAndSettle();
  }

  Finder choice(String label) => find.widgetWithText(AdjustChoice, label);

  testWidgets('Auto is first in the slider row and sets the sliders from the photo, again on a second tap', (
    tester,
  ) async {
    await pumpPage(tester, RemoteAssetFactory.create(), AdjustTab.adjust);
    final settings = AutoSettings.parse(File('assets/selfphotos/adjust-auto.json').readAsStringSync());
    final expected = (await tester.runAsync(() => autoAdjustImage(preview, settings)))!;
    expect(expected[AdjustSlider.contrast], greaterThan(0));

    final row = tester.widgetList<AdjustChoice>(find.byType(AdjustChoice)).map((c) => c.label).toList();
    expect(row.indexOf('Auto'), row.indexOf('Exposure') - 1, reason: '$row');
    await screenshot(tester, 'android-pixel9-1-auto-before');

    await tapAndWait(tester, choice('Auto'));
    expect(slider(tester, 'Exposure'), closeTo(expected[AdjustSlider.exposure]! * 100, 1e-9));
    await tap(tester, choice('Contrast'));
    expect(slider(tester, 'Contrast'), closeTo(expected[AdjustSlider.contrast]! * 100, 1e-9));
    await screenshot(tester, 'android-pixel9-2-auto-after');

    // Moved by hand, then Auto again: back to the photo's own values; tint isn't Auto's.
    await tap(tester, choice('Tint'));
    await tester.drag(find.byType(Slider), const Offset(60, 0));
    await tester.pumpAndSettle();
    final tint = slider(tester, 'Tint');
    expect(tint, isNot(0));
    await tap(tester, choice('Contrast'));
    await tester.drag(find.byType(Slider), const Offset(-120, 0));
    await tester.pumpAndSettle();
    expect(slider(tester, 'Contrast'), isNot(closeTo(expected[AdjustSlider.contrast]! * 100, 1e-9)));
    await tapAndWait(tester, choice('Auto'));
    expect(slider(tester, 'Contrast'), closeTo(expected[AdjustSlider.contrast]! * 100, 1e-9));
    await tap(tester, choice('Tint'));
    expect(slider(tester, 'Tint'), tint);
  });

  testWidgets('Perspective: the corners are dragged on the whole photo, the result shows in Straighten, Reset '
      'puts them back', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create(), AdjustTab.straighten);
    expect(find.byType(PerspectiveCorners), findsNothing);
    expect(find.byType(LabelledSlider), findsOneWidget);

    await tap(tester, choice('Perspective'));
    expect(find.byType(PerspectiveCorners), findsOneWidget);
    expect(find.byType(LabelledSlider), findsNothing); // the angle is Straighten's
    final photo = tester.widget<PerspectiveCorners>(find.byType(PerspectiveCorners)).photo;
    final origin = tester.getTopLeft(find.byType(PerspectiveCorners));
    Offset onScreen((double, double) p) => origin + photo.topLeft + Offset(p.$1 * photo.width, p.$2 * photo.height);

    // Each corner of the photo onto the building's.
    const corners = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
    for (var i = 0; i < 4; i++) {
      final gesture = await tester.startGesture(onScreen(corners[i]));
      for (var step = 1; step <= 10; step++) {
        await gesture.moveTo(Offset.lerp(onScreen(corners[i]), onScreen(_building[i]), step / 10)!);
        await tester.pump(const Duration(milliseconds: 16));
      }
      if (i == 3) {
        // The finger still down: the magnifier shows.
        expect(find.byType(RawMagnifier), findsOneWidget);
        await screenshot(tester, 'android-pixel9-3-perspective-corners', settle: false);
      }
      await gesture.up();
      await tester.pumpAndSettle();
    }
    expect(find.byType(RawMagnifier), findsNothing);
    final placed = tester.widget<PerspectiveCorners>(find.byType(PerspectiveCorners)).corners!;
    for (var i = 0; i < 4; i++) {
      expect(placed[i].$1, closeTo(_building[i].$1, 0.01));
      expect(placed[i].$2, closeTo(_building[i].$2, 0.01));
    }

    await tap(tester, choice('Straighten').last);
    expect(find.byType(PerspectiveCorners), findsNothing);
    await screenshot(tester, 'android-pixel9-4-perspective-result');

    // The result: the photo's box takes the crop's shape (the photo's own 3:4 here, which holds the
    // building, in the middle of it), and in it the building stands straight, whole, where the
    // maths says.
    final source = AdjustSize(preview.width, preview.height);
    final crop = outputSize(0, source, placed);
    final box = tester.getRect(find.byType(MarkupLayer));
    expect(box.width / box.height, closeTo(crop.width / crop.height, 0.01));
    expect(box.width / box.height, closeTo(3 / 4, 0.01));
    final (scaleX, scaleY) = framing(0, source, placed).scale;
    expect(scaleX, closeTo(scaleY, 1e-9));
    final building = [for (final corner in placed) _inCrop(corner, source, placed)];
    for (final (x, y) in building) {
      expect(x, inInclusiveRange(-1e-9, 1 + 1e-9));
      expect(y, inInclusiveRange(-1e-9, 1 + 1e-9));
    }
    final shot = await capture(tester, find.byKey(_screenKey));
    final pixels = (await tester.runAsync(() => shot.toByteData(format: ui.ImageByteFormat.rawRgba)))!;
    // The sky is bluish, the building and its windows grey: where it starts and ends across the box
    // at a height (a share of the box), as shares of the box's width.
    (double, double) across(double y) {
      final row = ((box.top + box.height * y) * pixel9Ratio).round();
      int? left;
      int? right;
      for (var x = (box.left * pixel9Ratio).ceil() + 1; x < (box.right * pixel9Ratio).floor() - 1; x++) {
        final i = (row * shot.width + x) * 4;
        if (pixels.getUint8(i + 2) - pixels.getUint8(i) < 15) {
          left ??= x;
          right = x;
        }
      }
      return ((left! / pixel9Ratio - box.left) / box.width, (right! / pixel9Ratio - box.left) / box.width);
    }

    final (top, bottom) = (building[0].$2, building[3].$2);
    final high = across(top + (bottom - top) * 0.2);
    final low = across(top + (bottom - top) * 0.8);
    final pixel = 1.5 / box.width;
    expect(high.$1, closeTo(low.$1, pixel), reason: 'its left edge straight');
    expect(high.$2, closeTo(low.$2, pixel), reason: 'its right edge straight');
    expect(high.$1, closeTo(building[0].$1, 2 * pixel));
    expect(high.$2, closeTo(building[1].$1, 2 * pixel));

    await tap(tester, find.text('Reset'));
    await tap(tester, choice('Perspective'));
    expect(tester.widget<PerspectiveCorners>(find.byType(PerspectiveCorners)).corners, isNull);
  });

  testWidgets('Perspective: a corner that can\'t go there says so, briefly, once a drag', (tester) async {
    await pumpPage(tester, RemoteAssetFactory.create(), AdjustTab.straighten);
    await tap(tester, choice('Perspective'));
    final photo = tester.widget<PerspectiveCorners>(find.byType(PerspectiveCorners)).photo;
    final origin = tester.getTopLeft(find.byType(PerspectiveCorners));
    Offset onScreen((double, double) p) => origin + photo.topLeft + Offset(p.$1 * photo.width, p.$2 * photo.height);
    const hint = "Corners can't get that close or cross.";

    // The top left corner dragged across to the bottom right: refused all the way.
    final gesture = await tester.startGesture(onScreen((0, 0)));
    for (var step = 1; step <= 10; step++) {
      await gesture.moveTo(Offset.lerp(onScreen((0, 0)), onScreen((0.95, 0.95)), step / 10)!);
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(find.text(hint), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 400)); // faded in
    await screenshot(tester, 'android-pixel9-5-perspective-hint', settle: false);
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 100));
    // The corner went as far as it could, not across.
    final corners = tester.widget<PerspectiveCorners>(find.byType(PerspectiveCorners)).corners!;
    expect(corners[0].$1, lessThan(0.9));
    // Gone after a moment.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text(hint), findsNothing);
  });
}

// Where [corner] (a share of the photo) shows in perspective's crop (shares of it).
(double, double) _inCrop((double, double) corner, AdjustSize source, Quad perspective) {
  final view = framing(0, source, perspective);
  final (x, y) = project(invert(view.toPhoto!), (corner.$1 * source.width, corner.$2 * source.height));
  final (c, s) = view.rotation;
  final (dx, dy) = (x - view.centre.$1, y - view.centre.$2);
  return (
    (c * dx - s * dy) / (source.width * view.scale.$1) + 0.5,
    (s * dx + c * dy) / (source.height * view.scale.$2) + 0.5,
  );
}
