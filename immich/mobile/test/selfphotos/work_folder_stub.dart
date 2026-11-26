import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Answers path_provider for tests: the system temp folder as the cache folder that work folders go in
/// (lib/selfphotos/work_folder.dart), and 'test' for anything else.
void stubWorkFolderRoot() {
  TestWidgetsFlutterBinding.ensureInitialized();
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
    const MethodChannel('plugins.flutter.io/path_provider'),
    (MethodCall methodCall) async =>
        methodCall.method == 'getApplicationCacheDirectory' ? Directory.systemTemp.path : 'test',
  );
}
