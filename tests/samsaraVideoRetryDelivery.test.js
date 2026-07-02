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
} = require('../src/videoRetryDelivery');

const origRetryEnabled = process.env.SAMSARA_VIDEO_RETRY_ENABLED;
const origRetryDelay = process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;

test.after(() => {
  if (origRetryEnabled === undefined) delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  else process.env.SAMSARA_VIDEO_RETRY_ENABLED = origRetryEnabled;
  if (origRetryDelay === undefined) delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
  else process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = origRetryDelay;
});

test('getVideoRetryDelayMs defaults and clamps', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_DELAY_MS;
  assert.equal(getVideoRetryDelayMs(), DEFAULT_DELAY_MS);
  process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = '10000';
  assert.equal(getVideoRetryDelayMs(), 30_000);
  process.env.SAMSARA_VIDEO_RETRY_DELAY_MS = '999999';
  assert.equal(getVideoRetryDelayMs(), 180_000);
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
  assert.equal(out.startTime, '2026-05-29T14:56:32.338Z');
  assert.equal(out.endTime, '2026-05-29T14:56:32.338Z');
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
