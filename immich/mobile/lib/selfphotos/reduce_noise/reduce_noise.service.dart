// SelfPhotos Reduce noise for videos: Memento's extras service cleans a video's sound on our own
// server (DeepFilterNet; memento-extras POST /videos/:id/reduce-noise) and saves a copy stacked
// on top of the video; the picture isn't touched. The job is followed here, outside any page
// (GET /videos/jobs/:id every few seconds), so the person can keep browsing: a message when it
// starts, one with "Open" when it's done, a plain one if it fails. Not part of Immich. The web
// does the same (web/src/lib/ai-edit/reduce-noise.ts).
import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_ui/immich_ui.dart';

/// What the service says about a job (memento-extras src/types/reduce-noise.types.ts).
class ReduceNoiseJob {
  final String jobId;
  final String state; // queued, running, done or failed
  final String? assetId; // the cleaned copy, once done
  final String? error; // why not, in words for the person

  const ReduceNoiseJob({required this.jobId, required this.state, this.assetId, this.error});

  bool get finished => state == 'done' || state == 'failed';

  factory ReduceNoiseJob.fromJson(Object? json) {
    final map = json is Map ? json : const {};
    final jobId = map['jobId'];
    final state = map['state'];
    if (jobId is! String || state is! String) {
      throw const ExtrasException(0, "Memento's extras service answered something unexpected.");
    }
    final assetId = map['assetId'];
    final error = map['error'];
    return ReduceNoiseJob(
      jobId: jobId,
      state: state,
      assetId: assetId is String ? assetId : null,
      error: error is String ? error : null,
    );
  }
}

class ReduceNoiseService {
  final ExtrasClient _client;

  const ReduceNoiseService([this._client = const ExtrasClient()]);

  Future<ReduceNoiseJob> start(String assetId) async => ReduceNoiseJob.fromJson(
    await _client.send('POST', '/videos/${Uri.encodeComponent(assetId)}/reduce-noise', body: const <String, Object>{}),
  );

  Future<ReduceNoiseJob> status(String jobId) async =>
      ReduceNoiseJob.fromJson(await _client.send('GET', '/videos/jobs/${Uri.encodeComponent(jobId)}'));
}

/// How a request ended.
sealed class ReduceNoiseOutcome {
  const ReduceNoiseOutcome();
}

class ReduceNoiseDone extends ReduceNoiseOutcome {
  final String copyId;

  const ReduceNoiseDone(this.copyId);
}

class ReduceNoiseFailed extends ReduceNoiseOutcome {
  /// The service's own words, or null for the app's ("couldn't reduce the noise").
  final String? message;

  /// Refused because other videos are being cleaned: the app says so in its own words.
  final bool busy;

  const ReduceNoiseFailed(this.message, {this.busy = false});
}

/// Already being cleaned, asked for from this app a moment ago.
class ReduceNoiseUnderWay extends ReduceNoiseOutcome {
  const ReduceNoiseUnderWay();
}

/// Followed for longer than [ReduceNoiseFollower.giveUpAfter]: given up on here (it may still
/// finish on the server, and the copy then lands on top of the video).
class ReduceNoiseTooLong extends ReduceNoiseOutcome {
  const ReduceNoiseTooLong();
}

/// Starts a video's cleaning and asks about it every [interval] until it ends, for at most
/// [giveUpAfter] in all.
class ReduceNoiseFollower {
  final ReduceNoiseService _service;
  final Duration interval;

  /// An hour: the server's longest wait and cleaning together. As on the web.
  final Duration giveUpAfter;
  final _following = <String>{};

  /// The service unreachable this many times in a row (a minute): given up on here (it carries
  /// on on the server; the copy still lands on top of the video).
  static const _maxMisses = 20;

  ReduceNoiseFollower(
    this._service, {
    this.interval = const Duration(seconds: 3),
    this.giveUpAfter = const Duration(hours: 1),
  });

  Future<ReduceNoiseOutcome> run(String assetId, {required void Function() onStarted}) async {
    if (!_following.add(assetId)) {
      return const ReduceNoiseUnderWay();
    }
    try {
      var job = await _service.start(assetId);
      onStarted();
      final clock = Stopwatch()..start();
      var misses = 0;
      while (!job.finished) {
        if (clock.elapsed >= giveUpAfter) {
          return const ReduceNoiseTooLong();
        }
        await Future<void>.delayed(interval);
        try {
          job = await _service.status(job.jobId);
          misses = 0;
        } on ExtrasException {
          rethrow; // the service answered: that's its answer
        } catch (_) {
          if (++misses >= _maxMisses) {
            rethrow;
          }
        }
      }
      final copyId = job.assetId;
      return job.state == 'done' && copyId != null ? ReduceNoiseDone(copyId) : ReduceNoiseFailed(job.error);
    } on ExtrasException catch (error) {
      final data = error.data;
      final busy = data is Map && data['code'] == 'busy';
      return ReduceNoiseFailed(error.status > 0 && data is Map ? error.message : null, busy: busy);
    } catch (_) {
      return const ReduceNoiseFailed(null);
    } finally {
      _following.remove(assetId);
    }
  }
}

/// The app's one follower, kept while the app runs (not tied to a page), with its messages.
final reduceNoiseProvider = Provider<ReduceNoiseController>((ref) => ReduceNoiseController(ref));

class ReduceNoiseController {
  final Ref _ref;
  final ReduceNoiseFollower _follower;

  ReduceNoiseController(this._ref) : _follower = ReduceNoiseFollower(const ReduceNoiseService());

  /// Cleans the video's sound: a message when it starts, and one when it ends (with "Open").
  /// The messages go wherever the person is by then.
  Future<void> start(String videoId) async {
    final t = StaticTranslations.instance;
    final outcome = await _follower.run(videoId, onStarted: () => snackbar.info(t.reduce_noise_started));
    switch (outcome) {
      case ReduceNoiseUnderWay():
        snackbar.info(t.reduce_noise_started);
      case ReduceNoiseTooLong():
        snackbar.info(t.reduce_noise_too_long);
      case ReduceNoiseDone(:final copyId):
        snackbar.success(
          t.reduce_noise_done,
          duration: const Duration(seconds: 10),
          action: SnackbarAction(label: t.open, onPressed: () => _open(copyId)),
        );
      case ReduceNoiseFailed(:final message, :final busy):
        snackbar.error(busy ? t.reduce_noise_busy : message ?? t.reduce_noise_failed);
    }
  }

  // The copy in the viewer. It reaches the app's own database with the next sync, so one is
  // asked for if it isn't there yet.
  Future<void> _open(String copyId) async {
    final assets = _ref.read(assetServiceProvider);
    var copy = await assets.getRemoteAsset(copyId);
    if (copy == null) {
      await _ref.read(backgroundSyncProvider).syncRemote();
      copy = await assets.getRemoteAsset(copyId);
    }
    if (copy == null) {
      snackbar.info(StaticTranslations.instance.reduce_noise_done);
      return;
    }
    // As AssetViewer.setAsset does, with this provider's ref (the page that asked may be gone).
    final viewer = _ref.read(assetViewerProvider.notifier)..reset();
    if (copy.isVideo) {
      viewer.setControls(false);
    }
    viewer.setAsset(copy);
    unawaited(
      _ref
          .read(appRouterProvider)
          .push(
            AssetViewerRoute(
              initialIndex: 0,
              timelineService: _ref.read(timelineFactoryProvider).fromAssets([copy], TimelineOrigin.deepLink),
            ),
          ),
    );
  }
}
