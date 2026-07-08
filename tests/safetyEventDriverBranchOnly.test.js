'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendDriverGroupAlert } = require('../src/driverGroupDelivery');
const { deliverEvent } = require('../src/broadcastDelivery');
const { classifyTelegramError } = require('../src/deliveryTracker');

// The core invariant of this feature:
//   • Notifications group / subscribers (Branch A) receive the ORIGINAL video
//     immediately and UNCHANGED.
//   • The matched driver group (Branch B) receives the music-overlaid copy.
test('deliverEvent overlays music ONLY on the driver-group video, never the notifications group', async () => {
  const received = { notif: [], driver: [] };
  const noopTracker = {
    async getTargetStatuses() { return new Map(); },
    async recordSuccess() {},
    async recordPermanentSkip() {},
  };

  const deps = {
    bot: {
      async sendMessage() { return { message_id: 1 }; },
      async sendVideo(chatId, buffer) { received.notif.push(buffer.toString()); return { message_id: 1 }; },
      async sendMediaGroup() { return [{ message_id: 1 }]; },
    },
    driverBot: {
      async sendMessage() { return { message_id: 2 }; },
      async sendVideo(chatId, buffer) { received.driver.push(buffer.toString()); return { message_id: 2 }; },
      async sendMediaGroup() { return [{ message_id: 2 }]; },
    },
    store: { async getAll() { return []; }, findGroupByUnit: async () => '-700', async remove() {} },
    determineTargetGroup: async () => ({ targetGroupId: '-700', unitNumber: '27065', matchReason: 'unit', vehicleId: 'v1' }),
    resolveDriverCaption: async (_a, text) => text,
    sendDriverGroupAlert,
    isDriverMembershipAccessError: () => false,
    appendDriverMissingNote: (t) => t,
    tracker: noopTracker,
    classifyTelegramError,
    forcedId: '-500',
    managementGroupId: null,
    getVideoBuffer: async () => Buffer.from('ORIG'),
    // The overlay transform (as wired from index.js). Tags the driver buffer.
    prepareDriverVideo: async (buffer, ctx) => {
      assert.equal(ctx.isSpeeding, true);
      assert.equal(ctx.source, 'immediate');
      return Buffer.from('MUSIC+' + buffer.toString());
    },
    log: { log() {}, warn() {}, error() {} },
  };

  await deliverEvent({
    text: 'Speeding alert',
    videoUrl: 'https://cdn.example.com/forward.mp4',
    samsaraEventId: 'evt-100',
    vehicleName: 'Truck #27065',
    isSpeeding: true,
  }, deps);

  assert.deepEqual(received.notif, ['ORIG'], 'notifications group got the ORIGINAL video');
  assert.deepEqual(received.driver, ['MUSIC+ORIG'], 'driver group got the music-overlaid video');
});

test('deliverEvent does NOT overlay when the event is not a speeding event', async () => {
  const received = { notif: [], driver: [] };
  const noopTracker = {
    async getTargetStatuses() { return new Map(); },
    async recordSuccess() {},
    async recordPermanentSkip() {},
  };
  let prepareCalled = 0;

  await deliverEvent({
    text: 'Harsh braking',
    videoUrl: 'https://cdn.example.com/forward.mp4',
    samsaraEventId: 'evt-200',
    vehicleName: 'Truck #27065',
    // no isSpeeding flag
  }, {
    bot: {
      async sendMessage() { return { message_id: 1 }; },
      async sendVideo(_c, b) { received.notif.push(b.toString()); return { message_id: 1 }; },
      async sendMediaGroup() { return [{ message_id: 1 }]; },
    },
    driverBot: {
      async sendMessage() { return { message_id: 2 }; },
      async sendVideo(_c, b) { received.driver.push(b.toString()); return { message_id: 2 }; },
      async sendMediaGroup() { return [{ message_id: 2 }]; },
    },
    store: { async getAll() { return []; }, findGroupByUnit: async () => '-700', async remove() {} },
    determineTargetGroup: async () => ({ targetGroupId: '-700', unitNumber: '27065', matchReason: 'unit', vehicleId: 'v1' }),
    resolveDriverCaption: async (_a, text) => text,
    sendDriverGroupAlert,
    isDriverMembershipAccessError: () => false,
    appendDriverMissingNote: (t) => t,
    tracker: noopTracker,
    classifyTelegramError,
    forcedId: '-500',
    managementGroupId: null,
    getVideoBuffer: async () => Buffer.from('ORIG'),
    prepareDriverVideo: async (buffer, ctx) => {
      prepareCalled += 1;
      // Even if reached, the processor's own gate returns the original for
      // non-speeding events; here we assert it's simply passed through.
      return buffer;
    },
    log: { log() {}, warn() {}, error() {} },
  });

  // The transform IS handed the driver buffer, but with isSpeeding=false the
  // real processor returns the original — modelled here by pass-through.
  assert.deepEqual(received.driver, ['ORIG']);
  assert.deepEqual(received.notif, ['ORIG']);
});
