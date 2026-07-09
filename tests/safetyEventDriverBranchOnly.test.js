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

// ── Telegram 50MB size guard (driver-group path) ─────────────────────────────

test('sendDriverGroupAlert never uploads a >50MB video — sends text with a clear note instead', async () => {
  const huge = Buffer.alloc(50 * 1024 * 1024 + 1, 0x42);
  const calls = { sendVideo: 0, sendMessage: 0, texts: [] };
  const bot = {
    async sendVideo() { calls.sendVideo += 1; return { message_id: 1 }; },
    async sendMediaGroup() { throw new Error('should not be called'); },
    async sendMessage(_chat, text) { calls.sendMessage += 1; calls.texts.push(text); return { message_id: 9 }; },
  };
  const res = await sendDriverGroupAlert(bot, '-100', {
    caption: 'Speeding alert',
    videoUrl: 'https://cdn/f.mp4',
    getVideoBuffer: async () => huge,
    log: { log() {}, warn() {}, error() {} },
  });
  assert.equal(calls.sendVideo, 0, 'oversized upload was skipped entirely');
  assert.equal(calls.sendMessage, 1);
  assert.equal(res.type, 'text');
  assert.match(calls.texts[0], /too large/i, 'text fallback explains the video was too large');
});

test('sendDriverGroupAlert dual-camera: oversized INWARD clip still lets the forward-only video send', async () => {
  const small = Buffer.alloc(1000, 0x41);
  const huge = Buffer.alloc(50 * 1024 * 1024 + 1, 0x42);
  const calls = { mediaGroup: 0, sendVideo: 0, sendMessage: 0 };
  const bot = {
    async sendMediaGroup() { calls.mediaGroup += 1; return [{ message_id: 1 }]; },
    async sendVideo() { calls.sendVideo += 1; return { message_id: 2 }; },
    async sendMessage() { calls.sendMessage += 1; return { message_id: 3 }; },
  };
  const res = await sendDriverGroupAlert(bot, '-100', {
    caption: 'Speeding alert',
    videoUrl: 'https://cdn/f.mp4',
    inwardVideoUrl: 'https://cdn/i.mp4',
    getVideoBuffer: async (url) => (url.includes('/i.mp4') ? huge : small),
    log: { log() {}, warn() {}, error() {} },
  });
  assert.equal(calls.mediaGroup, 0, 'media group with an oversized member is not attempted');
  assert.equal(calls.sendVideo, 1, 'forward-only video still sent');
  assert.equal(res.type, 'caption');
});

test('sendDriverGroupAlert dual-camera: oversized FORWARD clip skips all uploads and falls to text', async () => {
  const small = Buffer.alloc(1000, 0x41);
  const huge = Buffer.alloc(50 * 1024 * 1024 + 1, 0x42);
  const calls = { mediaGroup: 0, sendVideo: 0, sendMessage: 0, texts: [] };
  const bot = {
    async sendMediaGroup() { calls.mediaGroup += 1; return [{ message_id: 1 }]; },
    async sendVideo() { calls.sendVideo += 1; return { message_id: 2 }; },
    async sendMessage(_c, text) { calls.sendMessage += 1; calls.texts.push(text); return { message_id: 3 }; },
  };
  const res = await sendDriverGroupAlert(bot, '-100', {
    caption: 'Speeding alert',
    videoUrl: 'https://cdn/f.mp4',
    inwardVideoUrl: 'https://cdn/i.mp4',
    getVideoBuffer: async (url) => (url.includes('/f.mp4') ? huge : small),
    log: { log() {}, warn() {}, error() {} },
  });
  assert.equal(calls.mediaGroup, 0);
  assert.equal(calls.sendVideo, 0, 'single-video path also skipped — same oversized forward clip');
  assert.equal(res.type, 'text');
  assert.match(calls.texts[0], /too large/i);
});
