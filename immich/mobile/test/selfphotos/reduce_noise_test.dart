import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/selfphotos/reduce_noise/reduce_noise.service.dart';

class _Service extends ExtrasClient {
  final List<Object> answers;
  final requests = <String>[];

  _Service(this.answers);

  @override
  Future<Object?> send(String method, String path, {Object? body}) async {
    requests.add('$method $path');
    final answer = answers.removeAt(0);
    if (answer is Exception) {
      throw answer;
    }
    return answer;
  }
}

ReduceNoiseFollower _follower(_Service service) =>
    ReduceNoiseFollower(ReduceNoiseService(service), interval: Duration.zero);

void main() {
  test('starts the job, says so once, asks until it is done, and gives the copy', () async {
    final service = _Service([
      {'jobId': 'j1', 'state': 'queued'},
      {'jobId': 'j1', 'state': 'running'},
      {'jobId': 'j1', 'state': 'done', 'assetId': 'copy-1'},
    ]);
    var started = 0;
    final outcome = await _follower(service).run('video 1', onStarted: () => started++);

    expect(outcome, isA<ReduceNoiseDone>().having((o) => o.copyId, 'copyId', 'copy-1'));
    expect(started, 1);
    expect(service.requests, ['POST /videos/video%201/reduce-noise', 'GET /videos/jobs/j1', 'GET /videos/jobs/j1']);
  });

  test("a failed job gives the service's own words", () async {
    final service = _Service([
      {'jobId': 'j2', 'state': 'queued'},
      {'jobId': 'j2', 'state': 'failed', 'error': 'This video has no sound to clean up.'},
    ]);
    final outcome = await _follower(service).run('v2', onStarted: () {});

    expect(
      outcome,
      isA<ReduceNoiseFailed>().having((o) => o.message, 'message', 'This video has no sound to clean up.'),
    );
  });

  test("refused at once: busy in the app's own words, anything else in the service's; never 'started'", () async {
    var started = 0;
    final busy = await _follower(
      _Service([
        const ExtrasException(503, 'Memento is cleaning other videos right now.', data: {'error': '…', 'code': 'busy'}),
      ]),
    ).run('v3', onStarted: () => started++);
    final tooLong = await _follower(
      _Service([
        const ExtrasException(413, 'Reduce noise works on videos up to 10 minutes long.', data: {'error': '…'}),
      ]),
    ).run('v4', onStarted: () => started++);
    final noService = await _follower(
      _Service([const SocketException('no route')]),
    ).run('v5', onStarted: () => started++);

    expect(busy, isA<ReduceNoiseFailed>().having((o) => o.busy, 'busy', true));
    expect(
      tooLong,
      isA<ReduceNoiseFailed>().having(
        (o) => o.message,
        'message',
        'Reduce noise works on videos up to 10 minutes long.',
      ),
    );
    expect(noService, isA<ReduceNoiseFailed>().having((o) => o.message, 'message', isNull));
    expect(started, 0);
  });

  test('a moment without the service is waited out; a second tap meanwhile only says it is under way', () async {
    final service = _Service([
      {'jobId': 'j6', 'state': 'queued'},
      const SocketException('offline for a moment'),
      {'jobId': 'j6', 'state': 'done', 'assetId': 'copy-6'},
    ]);
    final follower = _follower(service);
    final running = follower.run('v6', onStarted: () {});
    final again = await follower.run('v6', onStarted: () => fail('not started twice'));

    expect(again, isA<ReduceNoiseUnderWay>());
    expect(await running, isA<ReduceNoiseDone>());
    expect(service.requests.length, 3);
  });

  test('gives up after its time limit with "taking too long", and stops asking', () async {
    final service = _Service([
      {'jobId': 'j7', 'state': 'queued'},
      for (var i = 0; i < 1000; i++) {'jobId': 'j7', 'state': 'running'},
    ]);
    final follower = ReduceNoiseFollower(
      ReduceNoiseService(service),
      interval: const Duration(milliseconds: 5),
      giveUpAfter: const Duration(milliseconds: 40),
    );
    final outcome = await follower.run('v7', onStarted: () {});

    expect(outcome, isA<ReduceNoiseTooLong>());
    final asked = service.requests.length;
    expect(asked, greaterThan(1));
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(service.requests.length, asked, reason: 'no longer asked about');
    service.answers.insert(0, {'jobId': 'j7', 'state': 'done', 'assetId': 'copy-7'});
    expect(await follower.run('v7', onStarted: () {}), isA<ReduceNoiseDone>());
  });

  test('the follower gives up after an hour by default', () {
    expect(ReduceNoiseFollower(const ReduceNoiseService()).giveUpAfter, const Duration(hours: 1));
  });

  test("an answer that isn't a job is a failure, not a crash", () {
    expect(() => ReduceNoiseJob.fromJson({'state': 'done'}), throwsA(isA<ExtrasException>()));
    expect(ReduceNoiseJob.fromJson({'jobId': 'j', 'state': 'done', 'assetId': 7}).assetId, isNull);
  });
}
