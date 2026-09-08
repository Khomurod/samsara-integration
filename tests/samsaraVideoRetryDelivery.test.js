const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isVideoRetryEnabled,
  getVideoRetryDelayMs,
  patchAlertVideoUrls,
  enqueueFormattedAlert,
  inferVideoRetrievalParams,
  pollRetrievedVideoUrls,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
} = require('../src/videoRetryDelivery');

const origRetryEnabled = process.env.SAMSARA_VIDEO_RETRY_ENABLED;
const origRetryDelay = process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;

test.after(() => {
  if (origRetryEnabled === undefined) delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  else process.env.SAMSARA_VIDEO_RETRY_ENABLED = origRetryEnabled;
  if (origRetryDelay === undefined) delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
  else process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = origRetryDelay;
});

test('getVideoRetryDelayMs defaults to five minutes and no longer caps a long wait', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
  assert.equal(getVideoRetryDelayMs(), DEFAULT_DELAY_MS);
  assert.equal(DEFAULT_DELAY_MS, 300_000, 'the shipped default is the 5 minutes the admin panel shows');

  // The old ceiling was three minutes, so the operator's chosen delay could
  // never actually be honoured — an admin-set 5 minutes silently became 3.
  process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = '600000';
  assert.equal(getVideoRetryDelayMs(), 600_000, 'a ten-minute wait is honoured, not clamped');

  // A floor survives, purely so a mis-set value cannot become a tight loop.
  process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = '100';
  assert.equal(getVideoRetryDelayMs(), MIN_DELAY_MS);
  delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
});

test('patchAlertVideoUrls sets forward and inward URLs', () => {
  const alert = { text: 'x' };
  patchAlertVideoUrls(alert, {
    forwardUrl: 'https://forward.mp4',
    inwardUrl: 'https://inward.mp4',
  });
  assert.equal(alert.videoUrl, 'https://forward.mp4');
  assert.equal(alert.inwardVideoUrl, 'https://inward.mp4');
});

test('enqueueFormattedAlert queues immediately when video present (no backfill)', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  let called = 0;
  const alert = { text: 'x', videoUrl: 'https://v.mp4' };
  enqueueFormattedAlert(alert, { id: 'evt-1' }, () => { called += 1; });
  assert.equal(called, 1);
  assert.equal(alert.samsaraEventId, 'evt-1');
  assert.equal(alert.videoBackfill, undefined);
});

test('enqueueFormattedAlert queues immediately and attaches backfill when video missing', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  let queued = 0;
  const alert = { text: 'x' };
  const rawEvent = { id: 'evt-nofood' };
  enqueueFormattedAlert(alert, rawEvent, () => { queued += 1; });
  // Immediate send — no timer/defer.
  assert.equal(queued, 1);
  assert.equal(alert.samsaraEventId, 'evt-nofood');
  assert.ok(alert.videoBackfill, 'expected a backfill descriptor');
  assert.equal(alert.videoBackfill.eventId, 'evt-nofood');
  assert.equal(alert.videoBackfill.rawEvent, rawEvent);
});

test('enqueueFormattedAlert carries custom refetch/retrieval fns into backfill descriptor', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  const alert = { text: 'x' };
  const refetchFn = async () => ({ forwardUrl: null, inwardUrl: null });
  const retrievalFn = async () => ({ forwardUrl: 'https://gen.mp4', inwardUrl: null });
  enqueueFormattedAlert(alert, { id: 'evt-speed' }, () => {}, { refetchFn, retrievalFn, delayMs: 1234 });
  assert.equal(alert.videoBackfill.refetchFn, refetchFn);
  assert.equal(alert.videoBackfill.retrievalFn, retrievalFn);
  assert.equal(alert.videoBackfill.delayMs, 1234);
});

test('enqueueFormattedAlert attaches no backfill when retry disabled', () => {
  process.env.SAMSARA_VIDEO_RETRY_ENABLED = 'false';
  let queued = 0;
  const alert = { text: 'x' };
  enqueueFormattedAlert(alert, { id: 'evt-off' }, () => { queued += 1; });
  assert.equal(queued, 1);
  assert.equal(alert.videoBackfill, undefined);
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
});

test('enqueueFormattedAlert attaches no backfill when eventId missing', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  let queued = 0;
  const alert = { text: 'x' };
  enqueueFormattedAlert(alert, {}, () => { queued += 1; });
  assert.equal(queued, 1);
  assert.equal(alert.videoBackfill, undefined);
});

test('inferVideoRetrievalParams tolerates invalid start with valid end', () => {
  const out = inferVideoRetrievalParams({
    asset: { id: 'veh-1' },
    startMs: 'not-a-time',
    endMs: '2026-05-29T14:56:32.338Z',
  });
  assert.equal(out.vehicleId, 'veh-1');
  // It used to answer start === end === the one usable timestamp. Samsara
  // cannot produce a clip of no duration, so that request could only ever come
  // back empty. The window is now anchored on the event and genuinely wide.
  assert.ok(out.durationSeconds > 0, 'a retrieval window must have real duration');
  assert.ok(Date.parse(out.endTime) > Date.parse(out.startTime));
  assert.equal(out.startTime, '2026-05-29T14:56:17.338Z');
  assert.equal(out.endTime, '2026-05-29T14:57:17.338Z');
});

test('inferVideoRetrievalParams never returns a zero-length window, whatever the event says', () => {
  // The common shape: one instant, reported as both ends.
  const instant = inferVideoRetrievalParams({
    vehicle: { id: 'veh-2' },
    startMs: '2026-05-29T14:56:00.000Z',
    endMs: '2026-05-29T14:56:00.000Z',
  });
  assert.ok(instant.durationSeconds >= 5);
  assert.notEqual(instant.startTime, instant.endTime);

  // And the other direction: a long event is bounded, so one alert cannot ask a
  // truck to upload half an hour of video.
  const long = inferVideoRetrievalParams({
    asset: { id: 'veh-3' },
    startMs: '2026-05-29T14:00:00.000Z',
    endMs: '2026-05-29T15:00:00.000Z',
  });
  assert.ok(long.durationSeconds <= 600, `expected a bounded window, got ${long.durationSeconds}s`);

  // No vehicle, or no usable time at all, is honestly nothing rather than a
  // request Samsara will reject.
  assert.equal(inferVideoRetrievalParams({ time: '2026-05-29T14:56:00.000Z' }), null);
  assert.equal(inferVideoRetrievalParams({ asset: { id: 'veh-4' } }), null);
});

test('pollRetrievedVideoUrls continues after transient polling failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 500,
        text: async () => 'temporary backend issue',
      };
    }
    return {
      ok: true,
      text: async () => JSON.stringify({
        data: {
          media: [
            {
              mediaType: 'videoHighRes',
              input: 'dashcamRoadFacing',
              urlInfo: { url: 'https://retrieved-after-retry.mp4' },
            },
          ],
        },
      }),
    };
  };

  const out = await pollRetrievedVideoUrls({
    vehicleId: 'veh-1',
    startTime: '2026-05-29T14:56:00.000Z',
    endTime: '2026-05-29T14:56:32.338Z',
    apiKey: 'k',
    baseUrl: 'https://api.samsara.com',
    fetchImpl,
    sleepImpl: async () => {},
    maxPolls: 2,
    pollIntervalMs: 0,
  });

  assert.equal(out.forwardUrl, 'https://retrieved-after-retry.mp4');
});

test('isVideoRetryEnabled defaults to true', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  assert.equal(isVideoRetryEnabled(), true);
});
