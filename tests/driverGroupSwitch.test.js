/**
 * The per-driver switch set in Wenze (Driver Groups → driver details →
 * "Samsara alerts in this group"): `groups.samsara_driver_alerts_enabled`.
 *
 * What is proven here, with every collaborator faked (no network, no DB):
 *
 *   OFF blocks the driver group and NOTHING ELSE
 *     · the driver bot is never called, and no caption AI is spent on it;
 *     · the "Samsara Notifications" group and every subscriber receive the
 *       very same messages they receive with the switch on;
 *     · the event is still recorded, with its group;
 *     · the ledger records the notification targets only — the driver group
 *       is neither delivered nor failed, so nothing is retried for it;
 *     · no driver message exists, so no video recovery can reach the group.
 *
 *   ON is today's behaviour, call for call: a run with the switch reading ON
 *   produces exactly the calls a run without the switch produces.
 *
 *   Switching back on applies from the next alert.
 *
 *   A switch that cannot be read neither posts nor drops: the driver group is
 *   retried with the event, and what was already delivered is not re-sent.
 *
 *   Routing outcomes that never post to a driver group (unmapped vehicle,
 *   already delivered) never consult the switch.
 *
 *   The video recovery leaves out a driver group switched off after its alert
 *   went out, and keeps one whose switch could not be read for later.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deliverEvent } = require('../src/broadcastDelivery');
const { sendDriverGroupAlert } = require('../src/driverGroupDelivery');
const { classifyTelegramError } = require('../src/deliveryTracker');
const { isDriverGroupAlertsEnabled, sortTargetsBySwitch, _forTest } = require('../src/driverGroupSwitch');
const { CONFIG, fakeStore, jobRow, stubFetch } = require('./helpers/recoveryFakes');

const DRIVER_CHAT = '-100700';
const NOTIF_CHAT = '-500';
const SUBSCRIBER = '42';
const silentLog = { log() {}, warn() {}, error() {} };

/** A world that records every call any collaborator receives, in order. */
function world({ ledger = new Map(), switchValue, switchThrows = null, target = null } = {}) {
  const calls = [];
  const switchAsks = [];
  const recorded = [];
  const ledgerWrites = [];
  const captionAsks = [];
  let messageId = 100;

  const botFor = (kind) => ({
    async sendMessage(chatId, text) { calls.push([kind, 'sendMessage', String(chatId), text]); messageId += 1; return { message_id: messageId }; },
    async sendVideo(chatId, buffer, opts) { calls.push([kind, 'sendVideo', String(chatId), opts.caption, buffer.toString()]); messageId += 1; return { message_id: messageId }; },
    async sendMediaGroup(chatId) { calls.push([kind, 'sendMediaGroup', String(chatId)]); messageId += 1; return [{ message_id: messageId }]; },
    async editMessageText(text, opts) { calls.push([kind, 'editMessageText', String(opts.chat_id), text]); },
    async editMessageCaption(text, opts) { calls.push([kind, 'editMessageCaption', String(opts.chat_id), text]); },
  });

  const deps = {
    bot: botFor('notification'),
    driverBot: botFor('driver'),
    store: { async getAll() { return [SUBSCRIBER]; }, findGroupByUnit: async () => null, async remove() {} },
    determineTargetGroup: async () => target || ({
      targetGroupId: DRIVER_CHAT, internalGroupId: 77, unitNumber: '101', matchReason: 'vehicle_id', vehicleId: 'veh-9',
    }),
    resolveDriverCaption: async (_alert, text) => { captionAsks.push(text); return `${text} (driver)`; },
    sendDriverGroupAlert,
    isDriverMembershipAccessError: () => false,
    appendDriverMissingNote: (t) => `${t} [note]`,
    tracker: {
      async getTargetStatuses() { return new Map(ledger); },
      async recordSuccess(eventId, chatId) { ledgerWrites.push(['delivered', String(chatId)]); ledger.set(String(chatId), 'delivered'); },
      async recordPermanentSkip(eventId, chatId) { ledgerWrites.push(['permanent', String(chatId)]); ledger.set(String(chatId), 'permanent'); },
    },
    classifyTelegramError,
    forcedId: NOTIF_CHAT,
    managementGroupId: null,
    getVideoBuffer: async () => Buffer.from('ORIG'),
    recordSafetyEvent: async (row) => { recorded.push(row); return true; },
    log: silentLog,
  };
  if (switchValue !== undefined || switchThrows) {
    deps.isDriverGroupAlertsEnabled = async (q) => {
      switchAsks.push(q);
      if (switchThrows) throw switchThrows;
      return switchValue;
    };
  }
  return { deps, calls, switchAsks, recorded, ledgerWrites, captionAsks, ledger };
}

const ALERT = (over = {}) => ({
  text: 'Harsh braking - Unit 101',
  videoUrl: 'https://cdn.example.com/forward.mp4',
  samsaraEventId: 'evt-1',
  vehicleName: 'Truck #101',
  eventLabel: 'harsh_brake',
  ...over,
});

const notificationCalls = (calls) => calls.filter((c) => c[0] === 'notification');
const driverCalls = (calls) => calls.filter((c) => c[0] === 'driver');

// ─── OFF ─────────────────────────────────────────────────────────────────────

test('OFF: the driver group gets nothing, and is asked about by its group id and chat id', async () => {
  const w = world({ switchValue: false });
  const result = await deliverEvent(ALERT(), w.deps);

  assert.deepEqual(driverCalls(w.calls), [], 'the driver bot is never called');
  assert.deepEqual(w.captionAsks, [], 'no driver caption is composed for a post that will not happen');
  assert.deepEqual(w.switchAsks, [{ groupId: 77, telegramGroupId: DRIVER_CHAT }]);
  assert.equal(result.driverStatus, 'skip-disabled');
  assert.equal(result.transientPending, false);
  assert.ok(result.sentMessages.every((m) => m.botKind === 'notification'),
    'no driver message, so no video recovery can ever reach the group');
});

test('OFF: the notifications group and subscribers get exactly what they get with the switch on', async () => {
  const off = world({ switchValue: false });
  const on = world({ switchValue: true });
  await deliverEvent(ALERT(), off.deps);
  await deliverEvent(ALERT(), on.deps);

  assert.deepEqual(notificationCalls(off.calls), notificationCalls(on.calls));
  assert.deepEqual(
    notificationCalls(off.calls).map((c) => c[2]).sort(),
    [NOTIF_CHAT, SUBSCRIBER].sort(),
  );
});

test('OFF: the event is still recorded, with the driver group it belongs to', async () => {
  const off = world({ switchValue: false });
  const on = world({ switchValue: true });
  await deliverEvent(ALERT(), off.deps);
  await deliverEvent(ALERT(), on.deps);
  assert.equal(off.recorded.length, 1);
  assert.equal(off.recorded[0].groupId, 77);
  assert.deepEqual(off.recorded, on.recorded);
});

test('OFF: the ledger records the notification targets only — the driver group is neither delivered nor failed', async () => {
  const w = world({ switchValue: false });
  await deliverEvent(ALERT(), w.deps);
  assert.deepEqual(w.ledgerWrites.map((x) => x[1]).sort(), [NOTIF_CHAT, SUBSCRIBER].sort());
  assert.ok(w.ledgerWrites.every(([status]) => status === 'delivered'));
  assert.equal(w.ledger.has(DRIVER_CHAT), false);
});

// ─── ON ──────────────────────────────────────────────────────────────────────

test('ON: every call is identical to a run without the switch at all', async () => {
  const without = world();
  const on = world({ switchValue: true });
  const a = await deliverEvent(ALERT(), without.deps);
  const b = await deliverEvent(ALERT(), on.deps);

  assert.deepEqual(on.calls, without.calls);
  assert.deepEqual(on.ledgerWrites, without.ledgerWrites);
  assert.deepEqual(on.recorded, without.recorded);
  assert.deepEqual(b, a);
  assert.equal(b.driverStatus, 'ok');
  assert.deepEqual(driverCalls(on.calls).map((c) => c[2]), [DRIVER_CHAT]);
  assert.ok(b.sentMessages.some((m) => m.botKind === 'driver' && m.chatId === DRIVER_CHAT));
});

test('a text-only alert with the switch ON still carries the driver message the video recovery needs', async () => {
  const w = world({ switchValue: true });
  const result = await deliverEvent(ALERT({ videoUrl: null }), w.deps);
  assert.equal(result.hadVideoAtSend, false);
  assert.deepEqual(result.sentMessages.map((m) => m.botKind).sort(), ['driver', 'notification', 'notification']);
});

test('switching back ON applies from the next alert', async () => {
  const first = world({ switchValue: false });
  await deliverEvent(ALERT({ samsaraEventId: 'evt-1' }), first.deps);
  assert.deepEqual(driverCalls(first.calls), []);

  const next = world({ switchValue: true });
  await deliverEvent(ALERT({ samsaraEventId: 'evt-2' }), next.deps);
  assert.deepEqual(driverCalls(next.calls).map((c) => c[2]), [DRIVER_CHAT]);
});

// ─── cannot read the switch ──────────────────────────────────────────────────

test('a switch that cannot be read neither posts nor drops: the event is retried for the driver group only', async () => {
  const ledger = new Map();
  const broken = world({ ledger, switchThrows: new Error('connection terminated') });
  await assert.rejects(() => deliverEvent(ALERT(), broken.deps), /Transient delivery failure/);
  assert.deepEqual(driverCalls(broken.calls), [], 'nothing posted while the answer is unknown');
  assert.deepEqual(notificationCalls(broken.calls).map((c) => c[2]).sort(), [NOTIF_CHAT, SUBSCRIBER].sort());
  assert.equal(ledger.has(DRIVER_CHAT), false, 'not marked delivered and not marked failed');

  // The retry: the database answers now. Only the driver group is sent to.
  const retry = world({ ledger, switchValue: true });
  await deliverEvent(ALERT(), retry.deps);
  assert.deepEqual(notificationCalls(retry.calls), [], 'what was delivered is not sent twice');
  assert.deepEqual(driverCalls(retry.calls).map((c) => c[2]), [DRIVER_CHAT]);
});

// ─── routing outcomes that never post to a driver group ──────────────────────

test('an unmapped vehicle never consults the switch, and the notifications still go out', async () => {
  const w = world({
    switchValue: false,
    target: { targetGroupId: null, unitNumber: '101', vehicleId: 'veh-9', matchReason: 'fallback-unmapped' },
  });
  const result = await deliverEvent(ALERT(), w.deps);
  assert.deepEqual(w.switchAsks, []);
  assert.equal(result.driverStatus, 'skip');
  assert.equal(notificationCalls(w.calls).length, 2);
});

test('a driver group already delivered for this event is not asked about and not re-sent', async () => {
  const ledger = new Map([[DRIVER_CHAT, 'delivered']]);
  const w = world({ ledger, switchValue: false });
  const result = await deliverEvent(ALERT(), w.deps);
  assert.deepEqual(w.switchAsks, []);
  assert.equal(result.driverStatus, 'skip-delivered');
});

// ─── reading the switch ──────────────────────────────────────────────────────

function fakePool(handler) {
  const queries = [];
  return { queries, async query(sql, params) { queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return handler(sql, params); } };
}

test('the switch is read by group id when there is one, and by chat id otherwise', async () => {
  const pool = fakePool(() => ({ rows: [{ samsara_driver_alerts_enabled: false }] }));
  assert.equal(await isDriverGroupAlertsEnabled({ groupId: 77, telegramGroupId: DRIVER_CHAT }, pool), false);
  assert.equal(await isDriverGroupAlertsEnabled({ telegramGroupId: DRIVER_CHAT }, pool), false);
  assert.deepEqual(pool.queries.map((q) => q.params), [['77'], [DRIVER_CHAT]]);
  assert.match(pool.queries[0].sql, /FROM groups WHERE id = \$1/);
  assert.match(pool.queries[1].sql, /FROM groups WHERE telegram_group_id::text = \$1/);
});

test('ON, a missing row, no database and no target all read as ON', async () => {
  const on = fakePool(() => ({ rows: [{ samsara_driver_alerts_enabled: true }] }));
  const gone = fakePool(() => ({ rows: [] }));
  assert.equal(await isDriverGroupAlertsEnabled({ groupId: 77 }, on), true);
  assert.equal(await isDriverGroupAlertsEnabled({ groupId: 77 }, gone), true);
  assert.equal(await isDriverGroupAlertsEnabled({ groupId: 77 }, null), true);
  assert.equal(await isDriverGroupAlertsEnabled({}, on), true);
  assert.equal(on.queries.length, 1, 'no query without a target');
});

test('a database without the column yet reads as ON, and says so once', async () => {
  _forTest.resetWarning();
  const pool = fakePool(() => { const e = new Error('column "samsara_driver_alerts_enabled" does not exist'); e.code = '42703'; throw e; });
  const warned = [];
  const original = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    assert.equal(await isDriverGroupAlertsEnabled({ groupId: 77 }, pool), true);
    assert.equal(await isDriverGroupAlertsEnabled({ groupId: 78 }, pool), true);
  } finally { console.warn = original; }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /migration 0090/);
});

test('any other database failure is thrown, never guessed', async () => {
  const pool = fakePool(() => { const e = new Error('connection terminated'); e.code = '57P01'; throw e; });
  await assert.rejects(() => isDriverGroupAlertsEnabled({ groupId: 77 }, pool), /connection terminated/);
});

// ─── video recovery ──────────────────────────────────────────────────────────

const NOTIF_REF = { botKind: 'notification', chatId: NOTIF_CHAT, messageId: 55, caption: 'A' };
const DRIVER_REF = { botKind: 'driver', chatId: DRIVER_CHAT, messageId: 77, caption: 'B' };

test('sorting recovery targets: only driver messages are asked about', async () => {
  const asked = [];
  const out = await sortTargetsBySwitch([NOTIF_REF, DRIVER_REF], async (q) => { asked.push(q); return false; }, silentLog);
  assert.deepEqual(asked, [{ telegramGroupId: DRIVER_CHAT }]);
  assert.deepEqual(out, { send: [NOTIF_REF], dropped: [DRIVER_REF], held: [] });

  const on = await sortTargetsBySwitch([NOTIF_REF, DRIVER_REF], async () => true, silentLog);
  assert.deepEqual(on, { send: [NOTIF_REF, DRIVER_REF], dropped: [], held: [] });

  const unknown = await sortTargetsBySwitch([NOTIF_REF, DRIVER_REF], async () => { throw new Error('db down'); }, silentLog);
  assert.deepEqual(unknown, { send: [NOTIF_REF], dropped: [], held: [DRIVER_REF] });
});

function recoveryWorker(store, isDriverGroupAlertsEnabledFn) {
  const sent = [];
  const bot = {
    sendVideo: async (chatId, buffer, opts) => { sent.push({ chatId: String(chatId), caption: opts.caption }); return { message_id: 900 }; },
    sendMediaGroup: async () => { throw new Error('single camera'); },
    deleteMessage: async () => {},
  };
  const { createVideoRecoveryWorker } = require('../src/videoRecoveryWorker');
  const worker = createVideoRecoveryWorker({
    store,
    settings: { load: async () => CONFIG },
    resolveBot: () => bot,
    makeGetVideoBuffer: () => async () => Buffer.from('bytes'),
    refetchEventUrls: async () => ({ forwardUrl: 'https://cdn/f.mp4', inwardUrl: null }),
    ...(isDriverGroupAlertsEnabledFn ? { isDriverGroupAlertsEnabled: isDriverGroupAlertsEnabledFn } : {}),
    log: silentLog,
  });
  return { worker, sent };
}

test('recovery: a driver group switched off after its alert gets no video; the notifications group does', async () => {
  const store = fakeStore([jobRow({ targets: [NOTIF_REF, DRIVER_REF] })]);
  const fetchStub = stubFetch(() => ({ body: {} }));
  try {
    const { worker, sent } = recoveryWorker(store, async () => false);
    await worker.tick();
    assert.deepEqual(sent.map((s) => s.chatId), [NOTIF_CHAT]);
    assert.equal(store.calls.finish[0].status, 'completed', 'the switched-off group is done with, not retried');
    assert.deepEqual(store.calls.finish[0].targets, []);
  } finally { fetchStub.restore(); }
});

test('recovery: with the switch ON, or not wired at all, both destinations get the video as before', async () => {
  for (const fn of [async () => true, null]) {
    const store = fakeStore([jobRow({ targets: [NOTIF_REF, DRIVER_REF] })]);
    const fetchStub = stubFetch(() => ({ body: {} }));
    try {
      const { worker, sent } = recoveryWorker(store, fn);
      // eslint-disable-next-line no-await-in-loop
      await worker.tick();
      assert.deepEqual(sent.map((s) => s.chatId), [NOTIF_CHAT, DRIVER_CHAT]);
      assert.equal(store.calls.finish[0].status, 'completed');
    } finally { fetchStub.restore(); }
  }
});

test('recovery: a switch that cannot be read keeps the driver group waiting; the rest is delivered once', async () => {
  const store = fakeStore([jobRow({ targets: [NOTIF_REF, DRIVER_REF] })]);
  const fetchStub = stubFetch(() => ({ body: {} }));
  try {
    const { worker, sent } = recoveryWorker(store, async () => { throw new Error('db down'); });
    await worker.tick();
    assert.deepEqual(sent.map((s) => s.chatId), [NOTIF_CHAT]);
    assert.equal(store.calls.reschedule[0].status, 'video_available');
    assert.deepEqual(store.calls.reschedule[0].targets, [DRIVER_REF]);
  } finally { fetchStub.restore(); }
});
