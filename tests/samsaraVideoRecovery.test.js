/**
 * The DURABLE missing-video recovery — starting one.
 *
 * The alert is never held for video: a recovery is created only AFTER delivery,
 * from the messages that were actually sent, at the admin-configured delay. The
 * tick that works those jobs is pinned in samsaraVideoRecoveryWorker.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { enqueueVideoRecovery } = require('../src/videoRecoveryWorker');
const { silentLog, CONFIG, RAW_EVENT, fakeStore, jobRow } = require('./helpers/recoveryFakes');

// ── enqueue: the recovery starts only after the alert is out ──

test('a delivered alert with no video becomes a durable job at the configured delay', async () => {
  const store = fakeStore();
  const before = Date.now();
  const outcome = await enqueueVideoRecovery({
    store,
    settings: { load: async () => CONFIG },
    alertData: { videoBackfill: { eventId: 'evt-1', rawEvent: RAW_EVENT }, isSpeeding: true },
    result: { sentMessages: [{ botKind: 'notification', chatId: '-100111', messageId: 55, caption: 'Harsh braking' }] },
    log: silentLog,
  });

  assert.equal(outcome.enqueued, true);
  assert.equal(outcome.delaySeconds, 300, 'a 5-minute configuration is accepted and used');
  const [job] = store.calls.enqueue;
  assert.equal(job.eventId, 'evt-1');
  assert.equal(job.isSpeeding, true);
  assert.equal(job.targets.length, 1, 'the messages actually sent are what the video folds into');
  const dueInMs = new Date(job.nextCheckAt).getTime() - before;
  assert.ok(dueInMs > 290_000 && dueInMs < 310_000, `expected ~5 minutes, got ${dueInMs}ms`);
});

test('a re-delivered event does not create a second recovery', async () => {
  const store = fakeStore([jobRow()]);
  const outcome = await enqueueVideoRecovery({
    store,
    settings: { load: async () => CONFIG },
    alertData: { videoBackfill: { eventId: 'evt-1', rawEvent: RAW_EVENT } },
    result: { sentMessages: [{ botKind: 'notification', chatId: '-100111', messageId: 56 }] },
    log: silentLog,
  });
  assert.deepEqual(outcome, { enqueued: false, reason: 'already-queued' });
  assert.equal(store.jobs.size, 1);
});

test('nothing is queued when the alert already carried its video', async () => {
  const store = fakeStore();
  const outcome = await enqueueVideoRecovery({
    store,
    settings: { load: async () => CONFIG },
    alertData: { text: 'x' },   // no videoBackfill descriptor
    result: { sentMessages: [{ botKind: 'notification', chatId: '-1', messageId: 1 }] },
    log: silentLog,
  });
  assert.equal(outcome.enqueued, false);
  assert.deepEqual(store.calls.enqueue, []);
});

test('recovery disabled in the admin panel queues nothing', async () => {
  const store = fakeStore();
  const outcome = await enqueueVideoRecovery({
    store,
    settings: { load: async () => ({ ...CONFIG, videoRecoveryEnabled: false }) },
    alertData: { videoBackfill: { eventId: 'evt-1', rawEvent: RAW_EVENT } },
    result: { sentMessages: [{ botKind: 'notification', chatId: '-1', messageId: 1 }] },
    log: silentLog,
  });
  assert.deepEqual(outcome, { enqueued: false, reason: 'disabled' });
});
