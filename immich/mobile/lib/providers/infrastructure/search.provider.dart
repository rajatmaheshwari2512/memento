import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/infrastructure/repositories/search_api.repository.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/selfphotos/ask/ask.service.dart';

final searchApiRepositoryProvider = Provider((ref) => SearchApiRepository(ref.watch(apiServiceProvider).searchApi));

// SelfPhotos Ask Photos: Immich's search, with Ask questions sent to Memento's extras service.
final searchServiceProvider = Provider<SearchService>(
  (ref) => AskSearchService(ref.watch(searchApiRepositoryProvider), ref.watch(askServiceProvider)),
);
