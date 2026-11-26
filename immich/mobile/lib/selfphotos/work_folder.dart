// SelfPhotos: temporary work folders for Adjust, AI Edit and Storage saver, in the app's cache folder.
import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// The folder that [createWorkFolder] makes its folders in.
Future<Directory> workFolderRoot() => getApplicationCacheDirectory();

/// A new empty folder whose name starts with [prefix]. Delete it when done.
Future<Directory> createWorkFolder(String prefix) async => (await workFolderRoot()).createTemp(prefix);
