'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deliverEvent } = require('../src/broadcastDelivery');
const { createDeliveryTracker, classifyTelegramError } = require('../src/deliveryTracker');
const { sendDriverGroupAlert } = require('../src/driverGroupDelivery');
const {
  isDriverMembershipAccessError,
  appendDriverMissingNote,
} = require('../src/deliveryWarnings');
const { reverseGeocode } = require('../src/geocoder');

const FORCED_ID = '-5192934125';
const DRIVER_ID = '-100777';

const silentLog = { log() {}, warn() {}, error() {} };

// ── Fakes ────────────────────────────────────────────────────────────────────

function tgError(code, description) {
  const err = new Error(description);
  err.response = { body: { error_code: code, description } };
  return err;
}
const chatNotFound = () => tgError(400, 'Bad Request: chat not found');
const blocked = () => tgError(403, 'Forbidden: bot was blocked by the user');
const rateLimited = () => tgError(429, 'Too Many Requests: retry after 5');

// In-memory stand-in for the Postgres delivery ledger. Enforces the same
// "never downgrade a delivered row to permanent" rule as the real SQL.
function makeDb() {
  const rows = new Map(); // `${eventId}::${target}` -> status
  return {
    rows,
    async getEventDeliveries(eventId) {
      const out = [];
      for (const [key, status] of rows) {
        const sep = key.indexOf('::');
        const eid = key.slice(0, sep);
        const target = key.slice(sep + 2);
        if (eid === String(eventId)) out.push({ target_chat_id: target, status });
      }
      return out;
    },
    async recordEventDelivery(eventId, target, status) {
      const key = `${eventId}::${target}`;
      if (rows.get(key) === 'delivered') return; // never downgrade
      rows.set(key, status);
    },
  };
}

// Telegram bot fake. Records every send attempt and every SUCCESSFUL send
// per target so tests can prove no target is ever delivered to twice.
function makeBot() {
  const bot = {
    attempts: [], // { method, chatId }
    successByTarget: new Map(),
    failures: new Map(), // chatId -> () => Error
    _record(method, chatId) {
      const id = String(chatId);
      bot.attempts.push({ method, chatId: id });
      const fail = bot.failures.get(id);
      if (fail) throw fail();
      bot.successByTarget.set(id, (bot.successByTarget.get(id) || 0) + 1);
      return { message_id: bot.attempts.length };
    },
    async sendMessage(chatId) { return bot._record('sendMessage', chatId); },
    async sendVideo(chatId) { return bot._record('sendVideo', chatId); },
    async sendMediaGroup(chatId) { return [bot._record('sendMediaGroup', chatId)]; },
    async editMessageText() { return true; },
    async editMessageCaption() { return true; },
    totalSuccesses() {
      let n = 0;
      for (const v of bot.successByTarget.values()) n += v;
      return n;
    },
  };
  return bot;
}

function makeDeps({
  subscribers = [],
  notifFailures = new Map(),
  driverFailures = new Map(),
  driverTarget = DRIVER_ID,
  db,
  resolveDriverCaption = async (_alert, text) => text,
} = {}) {
  const bot = makeBot();
  bot.failures = notifFailures;
  const driverBot = makeBot();
  driverBot.failures = driverFailures;

  const store = {
    removed: [],
    async getAll() { return [...subscribers]; },
    async findGroupByUnit() {
      return driverTarget ? { telegramGroupId: driverTarget, matchReason: 'unit' } : null;
    },
    async remove(id) { store.removed.push(String(id)); return true; },
  };

  const deps = {
    bot,
    driverBot,
    store,
    determineTargetGroup: async () => ({
      targetGroupId: driverTarget,
      unitNumber: '42',
      vehicleId: 'v1',
      matchReason: driverTarget ? 'unit' : 'fallback-unmapped',
    }),
    resolveDriverCaption,
    sendDriverGroupAlert,
    isDriverMembershipAccessError,
    appendDriverMissingNote,
    tracker: createDeliveryTracker(db),
    classifyTelegramError,
    forcedId: FORCED_ID,
    managementGroupId: null,
    getVideoBuffer: async () => Buffer.from('x'),
    log: silentLog,
  };

  return { deps, bot, driverBot, store };
}

function textAlert(eventId) {
  return { text: '<b>Harsh braking</b> — Unit #42', samsaraEventId: eventId };
}

// ── Error classification ──────────────────────────────────────────────────────

test('classifyTelegramError: permanent vs transient', () => {
  assert.equal(classifyTelegramError(chatNotFound()), 'permanent');
  assert.equal(classifyTelegramError(blocked()), 'permanent');
  assert.equal(classifyTelegramError(tgError(400, 'Bad Request: message is too long')), 'permanent');
  assert.equal(classifyTelegramError(tgError(403, 'bot was kicked from the group chat')), 'permanent');
  assert.equal(classifyTelegramError(rateLimited()), 'transient');
  assert.equal(classifyTelegramError(tgError(500, 'Internal Server Error')), 'transient');
  assert.equal(classifyTelegramError(tgError(502, 'Bad Gateway')), 'transient');
  assert.equal(classifyTelegramError(new Error('socket hang up')), 'transient');
  assert.equal(classifyTelegramError(new Error('ETIMEDOUT')), 'transient');
});

// ── Scenario 1: happy path ────────────────────────────────────────────────────

test('happy path: delivered once to notifications group + driver group; each recorded', async () => {
  const db = makeDb();
  const { deps, bot, driverBot } = makeDeps({ db });

  await deliverEvent(textAlert('e1'), deps);

  assert.equal(bot.successByTarget.get(FORCED_ID), 1);
  assert.equal(driverBot.successByTarget.get(DRIVER_ID), 1);
  assert.equal(db.rows.get(`e1::${FORCED_ID}`), 'delivered');
  assert.equal(db.rows.get(`e1::${DRIVER_ID}`), 'delivered');
});

// ── Scenario 2: notifications 400 chat-not-found, driver OK, no re-send ────────

test('notifications 400 chat-not-found does NOT retry and does NOT re-send driver group', async () => {
  const db = makeDb();
  const notifFailures = new Map([[FORCED_ID, chatNotFound]]);
  const { deps, bot, driverBot } = makeDeps({ db, notifFailures });

  // First run: notifications permanently fails, driver succeeds. No throw.
  await assert.doesNotReject(() => deliverEvent(textAlert('e2'), deps));
  // Second run (simulates queue re-run / next poll).
  await assert.doesNotReject(() => deliverEvent(textAlert('e2'), deps));

  // Driver group must have been sent exactly once across BOTH runs.
  const driverSends = driverBot.attempts.filter((a) => a.chatId === DRIVER_ID);
  assert.equal(driverSends.length, 1);
  assert.equal(driverBot.successByTarget.get(DRIVER_ID), 1);

  // Notifications group was attempted once (permanent), then skipped.
  const notifSends = bot.attempts.filter((a) => a.chatId === FORCED_ID);
  assert.equal(notifSends.length, 1);
  assert.equal(db.rows.get(`e2::${FORCED_ID}`), 'permanent');
  assert.equal(db.rows.get(`e2::${DRIVER_ID}`), 'delivered');
});

// ── Scenario 3: transient 429 on driver → retried, no double-send of notifs ────

test('transient 429 on driver is retried; already-succeeded notifications not re-sent', async () => {
  const db = makeDb();
  const driverFailures = new Map([[DRIVER_ID, rateLimited]]);
  const { deps, bot, driverBot } = makeDeps({ db, driverFailures });

  // First run: driver send hits 429 → deliverEvent throws to request a retry.
  await assert.rejects(() => deliverEvent(textAlert('e3'), deps));
  assert.equal(bot.successByTarget.get(FORCED_ID), 1);
  assert.equal(db.rows.get(`e3::${FORCED_ID}`), 'delivered');
  assert.equal(db.rows.has(`e3::${DRIVER_ID}`), false); // transient → not recorded

  // Retry: driver now healthy.
  driverBot.failures = new Map();
  await assert.doesNotReject(() => deliverEvent(textAlert('e3'), deps));

  // Notifications group must NOT be sent a second time.
  const notifSends = bot.attempts.filter((a) => a.chatId === FORCED_ID);
  assert.equal(notifSends.length, 1);
  assert.equal(bot.successByTarget.get(FORCED_ID), 1);

  // Exactly one successful delivery per target.
  assert.equal(driverBot.successByTarget.get(DRIVER_ID), 1);
  assert.equal(db.rows.get(`e3::${DRIVER_ID}`), 'delivered');
});

// ── Scenario 4: full re-run of a fully delivered event → sends to nobody ───────

test('re-run of an already fully delivered event sends to nobody (idempotent)', async () => {
  const db = makeDb();
  db.rows.set(`e4::${FORCED_ID}`, 'delivered');
  db.rows.set(`e4::${DRIVER_ID}`, 'delivered');
  const { deps, bot, driverBot } = makeDeps({ db });

  await assert.doesNotReject(() => deliverEvent(textAlert('e4'), deps));

  assert.equal(bot.attempts.length, 0);
  assert.equal(driverBot.attempts.length, 0);
});

// ── Scenario 5: blocked subscriber (403) skipped permanently, others unaffected ─

test('blocked subscriber (403) is skipped permanently and does not block others', async () => {
  const db = makeDb();
  const notifFailures = new Map([['111', blocked]]);
  const { deps, bot, driverBot, store } = makeDeps({
    db,
    subscribers: ['111'],
    notifFailures,
  });

  await assert.doesNotReject(() => deliverEvent(textAlert('e5'), deps));

  // Blocked user recorded permanent + removed; forced group + driver delivered.
  assert.equal(db.rows.get(`e5::111`), 'permanent');
  assert.ok(store.removed.includes('111'));
  assert.equal(db.rows.get(`e5::${FORCED_ID}`), 'delivered');
  assert.equal(db.rows.get(`e5::${DRIVER_ID}`), 'delivered');

  // Re-run: blocked user is skipped (no new attempt), nothing re-sent.
  bot.attempts.length = 0;
  driverBot.attempts.length = 0;
  await assert.doesNotReject(() => deliverEvent(textAlert('e5'), deps));
  assert.equal(bot.attempts.filter((a) => a.chatId === '111').length, 0);
  assert.equal(bot.attempts.length, 0);
  assert.equal(driverBot.attempts.length, 0);
});

// ── Scenario 6: AI caption failure → plain-text fallback, still delivered once ─

test('AI caption failure falls back to plain text and still delivers once', async () => {
  const db = makeDb();
  const { deps, driverBot } = makeDeps({
    db,
    resolveDriverCaption: async () => { throw new Error('Groq 429 / Gemini 429'); },
  });

  await assert.doesNotReject(() => deliverEvent(textAlert('e6'), deps));

  assert.equal(driverBot.successByTarget.get(DRIVER_ID), 1);
  assert.equal(db.rows.get(`e6::${DRIVER_ID}`), 'delivered');
});

// ── Scenario 7: geocoder 400 → graceful null, delivery still happens ──────────

test('geocoder 400 returns null gracefully and does not block delivery', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, async json() { return {}; } });
  try {
    const location = await reverseGeocode(37.7, -122.4);
    assert.equal(location, null); // graceful, no throw
  } finally {
    global.fetch = originalFetch;
  }

  // An alert formatted without a resolvable location still delivers fine.
  const db = makeDb();
  const { deps, bot, driverBot } = makeDeps({ db });
  await deliverEvent({ text: 'Event with no location', samsaraEventId: 'e7' }, deps);
  assert.equal(bot.successByTarget.get(FORCED_ID), 1);
  assert.equal(driverBot.successByTarget.get(DRIVER_ID), 1);
});

// ── Math check: total successful sends === distinct successful targets ─────────

test('lifecycle send count equals distinct successful targets (no duplicates)', async () => {
  const db = makeDb();
  // Include a transient failure + retry to prove retries never create dupes.
  const driverFailures = new Map([[DRIVER_ID, rateLimited]]);
  const { deps, bot, driverBot } = makeDeps({
    db,
    subscribers: ['222'], // extra real subscriber alongside the forced group
    driverFailures,
  });

  await assert.rejects(() => deliverEvent(textAlert('e8'), deps)); // driver 429
  driverBot.failures = new Map();
  await assert.doesNotReject(() => deliverEvent(textAlert('e8'), deps)); // retry OK

  // Distinct targets that ended in a successful delivery.
  const distinctSuccessfulTargets = new Set([
    ...bot.successByTarget.keys(),
    ...driverBot.successByTarget.keys(),
  ]);
  const totalSuccessfulSends = bot.totalSuccesses() + driverBot.totalSuccesses();

  assert.equal(distinctSuccessfulTargets.size, 3); // '222', FORCED_ID, DRIVER_ID
  assert.equal(totalSuccessfulSends, distinctSuccessfulTargets.size);

  // And no single target was ever delivered to more than once.
  for (const count of [...bot.successByTarget.values(), ...driverBot.successByTarget.values()]) {
    assert.equal(count, 1);
  }
});
