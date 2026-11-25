// SelfPhotos: what the widget tests that pump a whole page on a Pixel 9 share (Adjust's tools,
// Markup, AI Edit): the screen, the app's fonts and translations, a stand-in preview, and
// screenshots. Not a test itself (no _test in its name).
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:openapi/api.dart' show AssetMediaSize;

/// A Pixel 9: 1080×2424 pixels at 2.625 (about 411×923 dp), with its status bar and gesture bar.
const pixel9Ratio = 2.625;
const pixel9Screen = Size(1080, 2424);
const pixel9Insets = FakeViewPadding(top: 48 * pixel9Ratio, bottom: 24 * pixel9Ratio);

/// The test's screen is a Pixel 9's, until the test ends.
void usePixel9(WidgetTester tester) {
  tester.view
    ..physicalSize = pixel9Screen
    ..devicePixelRatio = pixel9Ratio
    ..padding = pixel9Insets
    ..viewPadding = pixel9Insets;
  addTearDown(tester.view.reset);
}

/// The app's fonts (the test font draws boxes, and its wide letters wrap text more than the phone
/// does): its text font, and with [icons], Flutter's icons.
Future<void> loadAppFonts({bool icons = true}) async {
  final sans = FontLoader('GoogleSans');
  for (final weight in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    sans.addFont(Future.value(ByteData.sublistView(File('fonts/GoogleSans/GoogleSans-$weight.ttf').readAsBytesSync())));
  }
  await sans.load();
  if (!icons) {
    return;
  }
  // flutter_tester is in <flutter>/bin/cache/artifacts/engine/<platform>/.
  final file = File(
    '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts/MaterialIcons-Regular.otf',
  );
  if (file.existsSync()) {
    await (FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(file.readAsBytesSync())))).load();
  }
}

/// The app's translations around [app].
Widget withAppTranslations(Widget Function(BuildContext context) app) => EasyLocalization(
  supportedLocales: locales.values.toList(),
  path: translationsPath,
  startLocale: locales.values.first,
  fallbackLocale: locales.values.first,
  saveLocale: false,
  useFallbackTranslations: true,
  assetLoader: const CodegenLoader(),
  child: Builder(builder: app),
);

/// [preview] as [asset]'s preview, already in the image cache, as the page loads it (null: it
/// never arrives). What an earlier test loaded belongs to its own clock, so it goes first.
void cachePreview(RemoteAsset asset, ui.Image? preview) {
  rootBundle.clear();
  PaintingBinding.instance.imageCache
    ..clear()
    ..clearLiveImages();
  PaintingBinding.instance.imageCache.putIfAbsent(
    RemoteImageProvider(url: getThumbnailUrlForRemoteId(asset.id, type: AssetMediaSize.preview)),
    () => OneFrameImageStreamCompleter(
      preview == null ? Completer<ImageInfo>().future : SynchronousFuture(ImageInfo(image: preview)),
    ),
  );
}

/// What the RepaintBoundary [screen] shows, at the phone's pixels.
Future<ui.Image> capture(WidgetTester tester, Finder screen) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(screen);
  return (await tester.runAsync(() => boundary.toImage(pixelRatio: pixel9Ratio)))!;
}

/// With SELFPHOTOS_SCREENSHOTS set to a folder, what [screen] shows is saved there as [name].png
/// (after the page settles, unless [settle] is false).
Future<void> saveScreenshot(WidgetTester tester, Finder screen, String name, {bool settle = true}) async {
  final folder = Platform.environment['SELFPHOTOS_SCREENSHOTS'];
  if (folder == null) {
    return;
  }
  if (settle) {
    await tester.pumpAndSettle();
  }
  final image = await capture(tester, screen);
  final png = await tester.runAsync(() async => (await image.toByteData(format: ui.ImageByteFormat.png))!);
  File('$folder/$name.png').writeAsBytesSync(png!.buffer.asUint8List());
}
