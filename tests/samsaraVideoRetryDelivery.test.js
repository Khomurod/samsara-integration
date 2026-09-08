const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isVideoRetryEnabled,
  getVideoRetryDelayMs,
  enqueueFormattedAlert,
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

test('enqueueFormattedAlert carries an explicit delay into the backfill descriptor', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  const alert = { text: 'x' };
  enqueueFormattedAlert(alert, { id: 'evt-speed' }, () => {}, { delayMs: 1234 });
  assert.equal(alert.videoBackfill.delayMs, 1234);
});

test('the environment alone no longer decides whether a recovery happens', () => {
  // The descriptor is attached whenever a clip is missing. Whether a recovery
  // is CREATED is decided by enqueueVideoRecovery against the settings row —
  // see samsaraVideoRecovery.test.js. Deciding it here would mean deciding it
  // from the environment alone, which let a deployment carrying
  // SAMSARA_VIDEO_RETRY_ENABLED=false silently defeat an administrator who had
  // just switched recovery on in the panel.
  process.env.SAMSARA_VIDEO_RETRY_ENABLED = 'false';
  let queued = 0;
  const alert = { text: 'x' };
  enqueueFormattedAlert(alert, { id: 'evt-off' }, () => { queued += 1; });
  assert.equal(queued, 1, 'the alert still goes out immediately, as always');
  assert.ok(alert.videoBackfill, 'and the settings get the final say, not this');
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

test('isVideoRetryEnabled defaults to true', () => {
  delete process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  assert.equal(isVideoRetryEnabled(), true);
});
