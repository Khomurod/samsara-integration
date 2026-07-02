const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveEventVideoUrls,
  postVideoReply,
  runVideoBackfill,
  scheduleVideoBackfill,
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

test('postVideoReply sends a dual-camera media group as a reply', async () => {
  const calls = [];
  const bot = {
    async sendMediaGroup(chatId, media, opts) {
      calls.push({ method: 'sendMediaGroup', chatId, replyTo: opts?.reply_to_message_id });
      return [{ message_id: 9 }];
    },
    async sendVideo() { calls.push({ method: 'sendVideo' }); },
  };
  const ok = await postVideoReply(bot, '-100', 42, {
    videoUrl: 'https://f.mp4',
    inwardVideoUrl: 'https://i.mp4',
    getVideoBuffer: async () => Buffer.from('x'),
    caption: 'cap',
    log: silentLog,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMediaGroup');
  assert.equal(calls[0].replyTo, 42);
});

test('postVideoReply falls back to single sendVideo when media group fails', async () => {
  const calls = [];
  const bot = {
    async sendMediaGroup() { calls.push('sendMediaGroup'); throw new Error('group failed'); },
    async sendVideo(chatId, buf, opts) {
      calls.push('sendVideo');
      assert.equal(opts.reply_to_message_id, 7);
      return { message_id: 1 };
    },
  };
  const ok = await postVideoReply(bot, '-100', 7, {
    videoUrl: 'https://f.mp4',
    inwardVideoUrl: 'https://i.mp4',
    getVideoBuffer: async () => Buffer.from('x'),
    log: silentLog,
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['sendMediaGroup', 'sendVideo']);
});

test('postVideoReply returns false when no urls', async () => {
  const ok = await postVideoReply({}, '-100', 1, {
    videoUrl: null, inwardVideoUrl: null, getVideoBuffer: async () => null, log: silentLog,
  });
  assert.equal(ok, false);
});

test('runVideoBackfill posts to notification and driver targets using the right bot', async () => {
  const notifCalls = [];
  const driverCalls = [];
  const notifBot = { async sendVideo(chatId, b, o) { notifCalls.push({ chatId, replyTo: o.reply_to_message_id }); } };
  const driverBot = { async sendVideo(chatId, b, o) { driverCalls.push({ chatId, replyTo: o.reply_to_message_id }); } };

  const res = await runVideoBackfill({
    sentMessages: [
      { botKind: 'notification', chatId: '-500', messageId: 11 },
      { botKind: 'notification', chatId: '999', messageId: 12 },
      { botKind: 'driver', chatId: '-700', messageId: 13 },
    ],
    videoUrls: { forwardUrl: 'https://f.mp4', inwardUrl: null },
    resolveBot: (kind) => (kind === 'driver' ? driverBot : notifBot),
    getVideoBuffer: async () => Buffer.from('x'),
    caption: 'cap',
    log: silentLog,
  });

  assert.equal(res.posted, 3);
  assert.equal(res.attempted, 3);
  assert.equal(notifCalls.length, 2);
  assert.equal(driverCalls.length, 1);
  assert.equal(driverCalls[0].chatId, '-700');
  assert.equal(driverCalls[0].replyTo, 13);
});

test('runVideoBackfill does nothing when no video resolved', async () => {
  const res = await runVideoBackfill({
    sentMessages: [{ botKind: 'notification', chatId: '1', messageId: 1 }],
    videoUrls: { forwardUrl: null, inwardUrl: null },
    resolveBot: () => ({ async sendVideo() { throw new Error('should not be called'); } }),
    getVideoBuffer: async () => Buffer.from('x'),
    log: silentLog,
  });
  assert.equal(res.posted, 0);
  assert.equal(res.attempted, 0);
});

test('scheduleVideoBackfill resolves video and replies to each target', async () => {
  const posted = [];
  let timerFn = null;
  const bot = { async sendVideo(chatId, b, o) { posted.push({ chatId, replyTo: o.reply_to_message_id }); } };

  const scheduled = scheduleVideoBackfill({
    eventId: 'evt-sched',
    rawEvent: { id: 'evt-sched' },
    sentMessages: [
      { botKind: 'notification', chatId: '-500', messageId: 21 },
      { botKind: 'driver', chatId: '-700', messageId: 22 },
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
  assert.equal(posted.length, 2);
  assert.equal(posted[0].replyTo, 21);
  assert.equal(posted[1].replyTo, 22);
});

test('scheduleVideoBackfill leaves messages untouched when no video ever appears', async () => {
  let timerFn = null;
  let sends = 0;
  const bot = { async sendVideo() { sends += 1; }, async sendMediaGroup() { sends += 1; } };

  scheduleVideoBackfill({
    eventId: 'evt-none',
    rawEvent: { id: 'evt-none' },
    sentMessages: [{ botKind: 'notification', chatId: '-500', messageId: 1 }],
    resolveBot: () => bot,
    makeGetVideoBuffer: () => async () => Buffer.from('x'),
    delayMs: 0,
    setTimer: (fn) => { timerFn = fn; },
    refetchFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    retrievalFn: async () => ({ forwardUrl: null, inwardUrl: null }),
    log: silentLog,
  });

  await timerFn();
  assert.equal(sends, 0);
});

test('scheduleVideoBackfill de-dupes concurrent scheduling for the same event', () => {
  let scheduledCount = 0;
  const common = {
    eventId: 'evt-dup',
    rawEvent: { id: 'evt-dup' },
    sentMessages: [{ botKind: 'notification', chatId: '-500', messageId: 1 }],
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
