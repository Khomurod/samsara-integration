const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveEventVideoUrls,
  replaceMessageWithVideo,
  runVideoBackfill,
  scheduleVideoBackfill,
  fitCaption,
  TELEGRAM_CAPTION_LIMIT,
  _forTest,
} = require('../src/videoBackfill');

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

test.afterEach(() => {
  _forTest.inFlight.clear();
});

test('resolveEventVideoUrls returns refetch result without calling retrieval', async () => {
  let retrievalCalled = 0;
  const urls = await resolveEventVideoUrls({
    eventId: 'e1',
    refetchFn: async () => ({ forwardUrl: 'https://f.mp4', inwardUrl: null }),
    retrievalFn: async () => { retrievalCalled += 1; return { forwardUrl: null, inwardUrl: null }; },
    log: silentLog,
  });
  assert.equal(urls.forwardUrl, 'https://f.mp4');
  assert.equal(retrievalCalled, 0);
});

test('resolveEventVideoUrls falls back to retrieval/generation when refetch empty', async () => {
  const urls = await resolveEventVideoUrls({
    eventId: 'e2',
    refetchFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    retrievalFn: async () => ({ forwardUrl: 'https://generated.mp4', inwardUrl: 'https://in.mp4' }),
    log: silentLog,
  });
  assert.equal(urls.forwardUrl, 'https://generated.mp4');
  assert.equal(urls.inwardUrl, 'https://in.mp4');
});

test('resolveEventVideoUrls swallows errors and returns nulls', async () => {
  const urls = await resolveEventVideoUrls({
    eventId: 'e3',
    refetchFn: async () => { throw new Error('boom'); },
    retrievalFn: async () => ({ forwardUrl: 'x', inwardUrl: null }),
    log: silentLog,
  });
  assert.deepEqual(urls, { forwardUrl: null, inwardUrl: null });
});

test('fitCaption leaves short captions untouched and truncates over-long ones', () => {
  const short = '<b>Alert</b>\nDriver event';
  assert.equal(fitCaption(short, silentLog), short);

  const long = 'a'.repeat(TELEGRAM_CAPTION_LIMIT + 50);
  const fitted = fitCaption(long, silentLog);
  assert.equal(fitted.length, TELEGRAM_CAPTION_LIMIT);
  assert.ok(fitted.endsWith('…'));
});

test('replaceMessageWithVideo sends a dual-camera video with the original caption then deletes the text message', async () => {
  const calls = [];
  const bot = {
    async sendMediaGroup(chatId, media) {
      calls.push({ method: 'sendMediaGroup', chatId, caption: media[0].caption });
      return [{ message_id: 9 }];
    },
    async sendVideo() { calls.push({ method: 'sendVideo' }); },
    async deleteMessage(chatId, messageId) { calls.push({ method: 'deleteMessage', chatId, messageId }); },
  };
  const ok = await replaceMessageWithVideo(bot, '-100', 42, {
    videoUrl: 'https://f.mp4',
    inwardVideoUrl: 'https://i.mp4',
    getVideoBuffer: async () => Buffer.from('x'),
    caption: 'original event text',
    log: silentLog,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'sendMediaGroup');
  assert.equal(calls[0].caption, 'original event text');
  assert.equal(calls[1].method, 'deleteMessage');
  assert.equal(calls[1].messageId, 42);
});

test('replaceMessageWithVideo falls back to single sendVideo when media group fails', async () => {
  const calls = [];
  const bot = {
    async sendMediaGroup() { calls.push('sendMediaGroup'); throw new Error('group failed'); },
    async sendVideo(chatId, buf, opts) {
      calls.push('sendVideo');
      assert.equal(opts.caption, 'cap');
      return { message_id: 1 };
    },
    async deleteMessage() { calls.push('deleteMessage'); },
  };
  const ok = await replaceMessageWithVideo(bot, '-100', 7, {
    videoUrl: 'https://f.mp4',
    inwardVideoUrl: 'https://i.mp4',
    getVideoBuffer: async () => Buffer.from('x'),
    caption: 'cap',
    log: silentLog,
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['sendMediaGroup', 'sendVideo', 'deleteMessage']);
});

test('replaceMessageWithVideo keeps the original message when the video send fails (no delete, no data loss)', async () => {
  const calls = [];
  const bot = {
    async sendVideo() { calls.push('sendVideo'); throw new Error('video rejected'); },
    async deleteMessage() { calls.push('deleteMessage'); },
  };
  const ok = await replaceMessageWithVideo(bot, '-100', 5, {
    videoUrl: 'https://f.mp4',
    inwardVideoUrl: null,
    getVideoBuffer: async () => Buffer.from('x'),
    caption: 'cap',
    log: silentLog,
  });
  assert.equal(ok, false);
  // The original text alert must survive a failed video send.
  assert.deepEqual(calls, ['sendVideo']);
});

test('replaceMessageWithVideo still reports success when deleting the original fails', async () => {
  const calls = [];
  const bot = {
    async sendVideo() { calls.push('sendVideo'); return { message_id: 1 }; },
    async deleteMessage() { calls.push('deleteMessage'); throw new Error('message to delete not found'); },
  };
  const ok = await replaceMessageWithVideo(bot, '-100', 5, {
    videoUrl: 'https://f.mp4',
    inwardVideoUrl: null,
    getVideoBuffer: async () => Buffer.from('x'),
    caption: 'cap',
    log: silentLog,
  });
  // Video was delivered; a failed delete is logged but does not fail the op.
  assert.equal(ok, true);
  assert.deepEqual(calls, ['sendVideo', 'deleteMessage']);
});

test('replaceMessageWithVideo returns false when no urls', async () => {
  const ok = await replaceMessageWithVideo({}, '-100', 1, {
    videoUrl: null, inwardVideoUrl: null, getVideoBuffer: async () => null, log: silentLog,
  });
  assert.equal(ok, false);
});

test('runVideoBackfill folds video into notification and driver targets using the right bot and per-target caption', async () => {
  const notifCalls = [];
  const driverCalls = [];
  const notifBot = {
    async sendVideo(chatId, b, o) { notifCalls.push({ chatId, caption: o.caption }); return { message_id: 1 }; },
    async deleteMessage(chatId, messageId) { notifCalls.push({ deleted: messageId, chatId }); },
  };
  const driverBot = {
    async sendVideo(chatId, b, o) { driverCalls.push({ chatId, caption: o.caption }); return { message_id: 1 }; },
    async deleteMessage(chatId, messageId) { driverCalls.push({ deleted: messageId, chatId }); },
  };

  const res = await runVideoBackfill({
    sentMessages: [
      { botKind: 'notification', chatId: '-500', messageId: 11, caption: 'notif text' },
      { botKind: 'notification', chatId: '999', messageId: 12, caption: 'notif text' },
      { botKind: 'driver', chatId: '-700', messageId: 13, caption: 'driver text' },
    ],
    videoUrls: { forwardUrl: 'https://f.mp4', inwardUrl: null },
    resolveBot: (kind) => (kind === 'driver' ? driverBot : notifBot),
    getVideoBuffer: async () => Buffer.from('x'),
    caption: 'fallback',
    log: silentLog,
  });

  assert.equal(res.posted, 3);
  assert.equal(res.attempted, 3);
  // 2 notification targets → 2 sends + 2 deletes.
  assert.equal(notifCalls.filter((c) => c.caption).length, 2);
  assert.equal(notifCalls.filter((c) => c.deleted).length, 2);
  assert.equal(notifCalls[0].caption, 'notif text');
  const driverSend = driverCalls.find((c) => c.caption);
  const driverDelete = driverCalls.find((c) => c.deleted);
  assert.equal(driverSend.chatId, '-700');
  assert.equal(driverSend.caption, 'driver text');
  assert.equal(driverDelete.deleted, 13);
});

test('runVideoBackfill does nothing when no video resolved', async () => {
  const res = await runVideoBackfill({
    sentMessages: [{ botKind: 'notification', chatId: '1', messageId: 1, caption: 't' }],
    videoUrls: { forwardUrl: null, inwardUrl: null },
    resolveBot: () => ({ async sendVideo() { throw new Error('should not be called'); } }),
    getVideoBuffer: async () => Buffer.from('x'),
    log: silentLog,
  });
  assert.equal(res.posted, 0);
  assert.equal(res.attempted, 0);
});

test('scheduleVideoBackfill resolves video and replaces each target message', async () => {
  const posted = [];
  let timerFn = null;
  const bot = {
    async sendVideo(chatId, b, o) { posted.push({ chatId, caption: o.caption }); return { message_id: 1 }; },
    async deleteMessage(chatId, messageId) { posted.push({ deleted: messageId }); },
  };

  const scheduled = scheduleVideoBackfill({
    eventId: 'evt-sched',
    rawEvent: { id: 'evt-sched' },
    sentMessages: [
      { botKind: 'notification', chatId: '-500', messageId: 21, caption: 'text a' },
      { botKind: 'driver', chatId: '-700', messageId: 22, caption: 'text b' },
    ],
    resolveBot: () => bot,
    makeGetVideoBuffer: () => async () => Buffer.from('x'),
    delayMs: 0,
    setTimer: (fn) => { timerFn = fn; },
    refetchFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    retrievalFn: async () => ({ forwardUrl: 'https://generated.mp4', inwardUrl: null }),
    log: silentLog,
  });

  assert.equal(scheduled, true);
  assert.ok(timerFn);
  await timerFn();
  const sends = posted.filter((p) => p.caption);
  const deletes = posted.filter((p) => p.deleted);
  assert.equal(sends.length, 2);
  assert.equal(deletes.length, 2);
  assert.deepEqual(sends.map((s) => s.caption), ['text a', 'text b']);
  assert.deepEqual(deletes.map((d) => d.deleted), [21, 22]);
});

test('scheduleVideoBackfill leaves messages untouched when no video ever appears', async () => {
  let timerFn = null;
  let sends = 0;
  let deletes = 0;
  const bot = {
    async sendVideo() { sends += 1; },
    async sendMediaGroup() { sends += 1; },
    async deleteMessage() { deletes += 1; },
  };

  scheduleVideoBackfill({
    eventId: 'evt-none',
    rawEvent: { id: 'evt-none' },
    sentMessages: [{ botKind: 'notification', chatId: '-500', messageId: 1, caption: 't' }],
    resolveBot: () => bot,
    makeGetVideoBuffer: () => async () => Buffer.from('x'),
    delayMs: 0,
    setTimer: (fn) => { timerFn = fn; },
    refetchFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    retrievalFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    log: silentLog,
  });

  await timerFn();
  // No video → original text alert stays exactly as sent; nothing sent or deleted.
  assert.equal(sends, 0);
  assert.equal(deletes, 0);
});

test('scheduleVideoBackfill de-dupes concurrent scheduling for the same event (idempotent)', () => {
  let scheduledCount = 0;
  const common = {
    eventId: 'evt-dup',
    rawEvent: { id: 'evt-dup' },
    sentMessages: [{ botKind: 'notification', chatId: '-500', messageId: 1, caption: 't' }],
    resolveBot: () => ({}),
    makeGetVideoBuffer: () => async () => null,
    delayMs: 0,
    setTimer: () => { scheduledCount += 1; },
    refetchFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    retrievalFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    log: silentLog,
  };

  const first = scheduleVideoBackfill(common);
  const second = scheduleVideoBackfill(common);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(scheduledCount, 1);
});

test('scheduleVideoBackfill returns false with no sent messages', () => {
  const scheduled = scheduleVideoBackfill({
    eventId: 'evt-empty',
    sentMessages: [],
    setTimer: () => { throw new Error('should not schedule'); },
    log: silentLog,
  });
  assert.equal(scheduled, false);
});
