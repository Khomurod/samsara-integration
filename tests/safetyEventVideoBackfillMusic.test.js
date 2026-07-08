'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runVideoBackfill } = require('../src/videoBackfill');

// Verifies the music overlay in the backfill path is applied ONLY to the driver
// group ref, never to the notifications group / subscriber refs.
test('runVideoBackfill applies music only to the driver-group ref', async () => {
  const overlaidChats = [];
  const sentVideos = [];

  const makeBot = (kind) => ({
    async sendVideo(chatId, buffer) { sentVideos.push({ kind, chatId, body: buffer.toString() }); return { message_id: 1 }; },
    async sendMediaGroup() { return [{ message_id: 1 }]; },
    async deleteMessage() { return true; },
  });
  const notifBot = makeBot('notif');
  const driverBot = makeBot('driver');

  const prepareDriverVideo = async (buffer, ctx) => {
    overlaidChats.push({ chatId: ctx.groupId, role: ctx.role, isSpeeding: ctx.isSpeeding, source: ctx.source });
    return Buffer.from('MUSIC+' + buffer.toString());
  };

  const sentMessages = [
    { botKind: 'notification', chatId: '-500', messageId: 10, caption: 'n' },
    { botKind: 'driver', chatId: '-100', messageId: 20, caption: 'd' },
  ];

  const res = await runVideoBackfill({
    sentMessages,
    videoUrls: { forwardUrl: 'https://cdn/f.mp4', inwardUrl: null },
    resolveBot: (kind) => (kind === 'driver' ? driverBot : notifBot),
    getVideoBuffer: async () => Buffer.from('ORIG'),
    caption: 'x',
    prepareDriverVideo,
    isSpeeding: true,
    eventId: 'evt-9',
    log: { log() {}, warn() {}, error() {} },
  });

  assert.equal(res.attempted, 2);
  assert.equal(res.posted, 2);
  // Only the driver ref went through the overlay.
  assert.deepEqual(overlaidChats, [{ chatId: '-100', role: 'single', isSpeeding: true, source: 'backfill' }]);
  // The notifications-group video is the original; the driver-group one is overlaid.
  const notif = sentVideos.find((v) => v.kind === 'notif');
  const driver = sentVideos.find((v) => v.kind === 'driver');
  assert.equal(notif.body, 'ORIG');
  assert.equal(driver.body, 'MUSIC+ORIG');
});

test('runVideoBackfill without a prepareDriverVideo sends original to all (unchanged legacy behaviour)', async () => {
  const sent = [];
  const bot = {
    async sendVideo(chatId, buffer) { sent.push(buffer.toString()); return { message_id: 1 }; },
    async sendMediaGroup() { return [{ message_id: 1 }]; },
    async deleteMessage() { return true; },
  };
  const res = await runVideoBackfill({
    sentMessages: [{ botKind: 'driver', chatId: '-100', messageId: 1, caption: 'd' }],
    videoUrls: { forwardUrl: 'https://cdn/f.mp4', inwardUrl: null },
    resolveBot: () => bot,
    getVideoBuffer: async () => Buffer.from('ORIG'),
    caption: 'x',
    log: { log() {}, warn() {}, error() {} },
  });
  assert.equal(res.posted, 1);
  assert.deepEqual(sent, ['ORIG']);
});
