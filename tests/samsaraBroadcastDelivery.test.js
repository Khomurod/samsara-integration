const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendDriverGroupAlert } = require('../src/driverGroupDelivery');
const { deliverEvent } = require('../src/broadcastDelivery');
const { classifyTelegramError } = require('../src/deliveryTracker');
const {
  appendDriverMissingNote,
  isDriverMembershipAccessError,
  shouldRetryDelivery,
} = require('../src/deliveryWarnings');
const poller = require('../src/poller');

test.afterEach(() => {
  poller._forTest.resetDeliveryStateForTest();
  poller.setBroadcastFn(null);
});

test('delivery state commits only after successful broadcast', async () => {
  let broadcastCalls = 0;
  poller.setBroadcastFn(async () => {
    broadcastCalls += 1;
  });

  poller._forTest.enqueueAlertForTest({ text: 'alert', samsaraEventId: 'evt-success-1' });
  const result = await poller._forTest.processNextQueuedAlertForTest();

  assert.equal(result.delivered, true);
  assert.equal(broadcastCalls, 1);
  assert.ok(poller._forTest.getSeenIds().has('evt-success-1'));
  assert.equal(poller._forTest.getPendingDeliveryIds().size, 0);
});

test('failed broadcast does not commit delivery state', async () => {
  poller.setBroadcastFn(async () => {
    throw new Error('simulated driver failure');
  });

  poller._forTest.enqueueAlertForTest({ text: 'alert', samsaraEventId: 'evt-fail-1' });
  const result = await poller._forTest.processNextQueuedAlertForTest();

  assert.equal(result.delivered, false);
  assert.equal(poller._forTest.getSeenIds().has('evt-fail-1'), false);
  assert.equal(poller._forTest.getPendingDeliveryIds().size, 0);
});

test('sendDriverGroupAlert falls back to text when sendVideo fails', async () => {
  const calls = [];
  const driverBot = {
    async sendVideo() {
      calls.push('sendVideo');
      throw new Error('video rejected');
    },
    async sendMessage(_groupId, caption) {
      calls.push('sendMessage');
      assert.match(caption, /safe/i);
      return { message_id: 1 };
    },
    async sendMediaGroup() {
      calls.push('sendMediaGroup');
      throw new Error('not used');
    },
  };

  await sendDriverGroupAlert(driverBot, '-100123', {
    caption: '<b>Hey</b> — drive safe out there!',
    videoUrl: 'https://cdn.example.com/forward.mp4',
    inwardVideoUrl: null,
    getVideoBuffer: async () => Buffer.from('fake'),
  });

  assert.deepEqual(calls, ['sendVideo', 'sendMessage']);
});

test('sendDriverGroupAlert sends dual camera when both URLs present', async () => {
  const calls = [];
  const driverBot = {
    async sendMediaGroup() {
      calls.push('sendMediaGroup');
      return [{ message_id: 1 }, { message_id: 2 }];
    },
    async sendVideo() {
      calls.push('sendVideo');
    },
    async sendMessage() {
      calls.push('sendMessage');
    },
  };

  await sendDriverGroupAlert(driverBot, '-100123', {
    caption: 'test',
    videoUrl: 'https://cdn.example.com/f.mp4',
    inwardVideoUrl: 'https://cdn.example.com/i.mp4',
    getVideoBuffer: async () => Buffer.from('fake'),
    log: { error: () => {} },
  });

  assert.deepEqual(calls, ['sendMediaGroup']);
});

test('driver membership/access errors are detected for warning notes', () => {
  const chatNotFoundErr = {
    response: { body: { error_code: 400, description: 'Bad Request: chat not found' } },
  };
  const forbiddenErr = {
    response: { body: { error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' } },
  };
  const genericErr = new Error('network timeout');

  assert.equal(isDriverMembershipAccessError(chatNotFoundErr), true);
  assert.equal(isDriverMembershipAccessError(forbiddenErr), true);
  assert.equal(isDriverMembershipAccessError(genericErr), false);
});

test('warning note appends once and keeps original content', () => {
  const original = '<b>Alert</b>\nDriver event details';
  const withNote = appendDriverMissingNote(original);
  const secondAppend = appendDriverMissingNote(withNote);

  assert.match(withNote, /@wenzefeedback_bot is not in the driver's group/i);
  assert.equal(secondAppend, withNote);
});

test('only notification failure should trigger retry signal', () => {
  assert.equal(shouldRetryDelivery('fail'), true);
  assert.equal(shouldRetryDelivery('ok'), false);
  assert.equal(shouldRetryDelivery('skip'), false);
});

function buildDeliverDeps(overrides = {}) {
  const noopTracker = {
    async getTargetStatuses() { return new Map(); },
    async recordSuccess() {},
    async recordPermanentSkip() {},
  };
  return {
    bot: {
      async sendMessage() { return { message_id: 100 }; },
      async sendVideo() { return { message_id: 100 }; },
      async sendMediaGroup() { return [{ message_id: 100 }]; },
    },
    driverBot: {
      async sendMessage() { return { message_id: 200 }; },
      async sendVideo() { return { message_id: 200 }; },
      async sendMediaGroup() { return [{ message_id: 200 }]; },
    },
    store: {
      async getAll() { return []; },
      findGroupByUnit: async () => '-700',
      async remove() {},
    },
    determineTargetGroup: async () => ({
      targetGroupId: '-700', unitNumber: '27065', matchReason: 'unit', vehicleId: 'veh-1',
    }),
    resolveDriverCaption: async (_alert, text) => text,
    sendDriverGroupAlert,
    isDriverMembershipAccessError: () => false,
    appendDriverMissingNote: (t) => t,
    tracker: noopTracker,
    classifyTelegramError,
    forcedId: '-500',
    managementGroupId: null,
    getVideoBuffer: async () => Buffer.from('x'),
    log: { log: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

test('deliverEvent reports no video at send and returns sent message refs (text)', async () => {
  const deps = buildDeliverDeps();
  const result = await deliverEvent(
    { text: 'alert', samsaraEventId: 'evt-nb' },
    deps,
  );

  assert.equal(result.hadVideoAtSend, false);
  // notifications group (-500) + driver group (-700) each got a text message.
  const kinds = result.sentMessages.map((m) => m.botKind).sort();
  assert.deepEqual(kinds, ['driver', 'notification']);
  const notif = result.sentMessages.find((m) => m.botKind === 'notification');
  const driver = result.sentMessages.find((m) => m.botKind === 'driver');
  assert.equal(notif.chatId, '-500');
  assert.equal(notif.messageId, 100);
  assert.equal(driver.chatId, '-700');
  assert.equal(driver.messageId, 200);
  // Each ref carries the exact caption text so the video backfill can preserve
  // it verbatim when it folds the video into the original message.
  assert.equal(notif.caption, 'alert');
  assert.equal(driver.caption, 'alert');
});

test('deliverEvent reports hadVideoAtSend true when alert already carries video', async () => {
  const deps = buildDeliverDeps();
  const result = await deliverEvent(
    { text: 'alert', videoUrl: 'https://f.mp4', samsaraEventId: 'evt-vid' },
    deps,
  );
  assert.equal(result.hadVideoAtSend, true);
});
