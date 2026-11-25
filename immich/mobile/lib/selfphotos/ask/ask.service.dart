// SelfPhotos Ask Photos: a question in plain English → matching photos, answered by Memento's
// extras service (POST /extras/ask) through the shared client. The search page offers it as
// one more search type ("Ask"); AskSearchService hands such searches here and everything else
// to Immich's own SearchService, so the results show in Immich's grid. Not part of Immich.
// See SelfPhotos FEATURES.md, section 4.
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/search_result.model.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/extensions/asset_extensions.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart' as api;

/// How a question was read, for the chips above its results, plus hints (how to make "me"
/// work) and the message when it couldn't be answered (Ask switched off, too long, …).
class AskUnderstood {
  final String question; // the question these belong to
  final String text; // the words left for the search model; '' when none
  final List<String> people;
  final String? dates;
  final String? place; // a place in the asker's photos, e.g. Goa
  final String? type; // IMAGE or VIDEO
  final bool favorite;
  final String? order; // newest or oldest
  final List<String> hints;

  const AskUnderstood({
    required this.question,
    this.text = '',
    this.people = const [],
    this.dates,
    this.place,
    this.type,
    this.favorite = false,
    this.order,
    this.hints = const [],
  });

  factory AskUnderstood.fromJson(String question, Map json) => AskUnderstood(
    question: question,
    text: (json['text'] as String?) ?? '',
    people: [
      for (final p in (json['people'] as List? ?? const []))
        if (p is Map && p['name'] is String) p['name'] as String,
    ],
    dates: json['dates'] is Map ? (json['dates'] as Map)['label'] as String? : null,
    place: json['place'] is Map ? (json['place'] as Map)['name'] as String? : null,
    type: json['type'] as String?,
    favorite: json['favorite'] == true,
    order: json['order'] as String?,
    hints: (json['hints'] as List? ?? const []).whereType<String>().toList(),
  );

  AskUnderstood withHint(String hint) => AskUnderstood(
    question: question,
    text: text,
    people: people,
    dates: dates,
    place: place,
    type: type,
    favorite: favorite,
    order: order,
    hints: [...hints, hint],
  );
}

final askUnderstoodProvider = StateProvider<AskUnderstood?>((ref) => null);

final askServiceProvider = Provider((ref) => AskService(ref));

class AskService {
  static const _client = ExtrasClient();
  final _log = Logger('AskService');
  final Ref _ref;
  String? _question;
  String? _cursor;

  AskService(this._ref);

  /// Page 1 asks afresh; later pages follow the service's cursor for the same question.
  Future<SearchResult?> search(String question, String? language, int page) async {
    final understood = _ref.read(askUnderstoodProvider.notifier);
    if (page == 1) {
      understood.state = null;
      _question = question;
      _cursor = null;
    } else if (question != _question || _cursor == null) {
      return null;
    }

    String? problem;
    try {
      final body = await _client.send(
        'POST',
        '/ask',
        body: {
          'question': question,
          'language': ?language,
          'timeZone': DateTime.now().timeZoneOffset.formatAsOffset(),
          'cursor': ?_cursor,
        },
      );
      if (question != _question) {
        return null; // a newer question was asked meanwhile
      }
      if (body is Map && body['assets'] is List) {
        if (page == 1 && body['understood'] is Map) {
          understood.state = AskUnderstood.fromJson(question, body['understood'] as Map);
        }
        _cursor = body['nextCursor'] as String?;
        final assets = api.AssetResponseDto.listFromJson(body['assets']).map((a) => a.toDto()).toList();
        return assets.isEmpty ? null : SearchResult(assets: assets, nextPage: _cursor == null ? null : page + 1);
      }
      problem = "Memento's extras service sent an unexpected answer.";
    } on ExtrasException catch (error) {
      problem = error.message;
    } catch (error, stackTrace) {
      _log.severe('Ask Photos failed', error, stackTrace);
      problem = "Couldn't reach Memento's extras service.";
    }

    if (question == _question) {
      // Shown with the question's chips; no more pages are tried.
      _cursor = null;
      final current = understood.state;
      understood.state = current?.question == question
          ? current!.withHint(problem)
          : AskUnderstood(question: question, hints: [problem]);
    }
    return null;
  }
}

/// Immich's SearchService, with Ask questions answered by AskService (search.provider.dart).
class AskSearchService extends SearchService {
  final AskService _ask;

  AskSearchService(super.searchApiRepository, this._ask);

  @override
  Future<SearchResult?> search(SearchFilter filter, int page) {
    final question = filter.ask;
    return question != null && question.isNotEmpty
        ? _ask.search(question, filter.language, page)
        : super.search(filter, page);
  }
}
