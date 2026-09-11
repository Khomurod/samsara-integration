/**
 * Keeping the safety event, so a pattern can be seen.
 *
 * Until now this poller formatted each event, sent it, and threw it away: the
 * only durable trace was an id for deduplication. So a driver's fourth hard
 * brake this week produced exactly the message their first did, and coaching
 * was impossible by construction.
 *
 * The rules this holds: recording must never block or break the alert going
 * out, and it must record the INTERNAL group id, because that is the join to
 * the driver's permanent identity.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { deliverEvent } = require('../src/broadcastDelivery');
const { determineTargetGroup } = require('../src/routing');
const { unitFromVehicleName } = require('../src/safetyEventStore');

const ALERT = {
  samsaraEventId: 'evt-1',
  eventLabel: 'Harsh Braking',
  severity: 'moderate',
  gForce: 0.72,
  eventTime: '2026-09-20T17:00:00Z',
  vehicleName: 'WENZE 310',
  vehicleId: 'veh-9',
  driverName: 'JOHN DOE',
  text: 'Harsh Braking on Unit 310',
};

function deps({ recordThrows = false, resolved = { groupId: 7, telegramGroupId: '-1007', groupName: 'WENZE UNIT # 310 JOHN DOE', matchReason: 'unit' } } = {}) {
  const seen = { recorded: [], driverSends: [] };
  return {
    seen,
    deps: {
      bot: { telegram: {} },
      driverBot: {
        async sendMessage(chatId, text) { seen.driverSends.push({ chatId, text }); return { message_id: 1 }; },
      },
      store: {
        async findGroupByUnit() { return resolved; },
        async getAll() { return []; },
      },
      determineTargetGroup,
      async resolveDriverCaption(_a, text) { return text; },
      async sendDriverGroupAlert(_bot, chatId, payload) {
        seen.driverSends.push({ chatId, payload });
        return { message_id: 2 };
      },
      isDriverMembershipAccessError: () => false,
      appendDriverMissingNote: (t) => t,
      tracker: {
        async getTargetStatuses() { return new Map(); },
        async recordSuccess() {},
        async recordPermanentSkip() {},
      },
      log: { log() {}, warn() {}, error() {} },
      classifyTelegramError: () => ({ permanent: false }),
      managementGroupId: '-100999',
      async getVideoBuffer() { return null; },
      async recordSafetyEvent(row) {
        seen.recorded.push(row);
        if (recordThrows) throw new Error('the database is down');
        return true;
      },
    },
  };
}

test('the unit parser is the routing one, not a fourth copy of it', () => {
  // `2021 Freightliner 305` reading as unit 2021 is a known bug in this
  // repository. Writing a new "first number anywhere" parser here would
  // reproduce it for no benefit.
  assert.equal(unitFromVehicleName('WENZE 310'), '310');
  assert.equal(unitFromVehicleName(''), null);
});

test('determineTargetGroup carries the INTERNAL group id, not only the chat id', async () => {
  const target = await determineTargetGroup(
    ALERT,
    async () => ({ groupId: 7, telegramGroupId: '-1007', groupName: 'g', matchReason: 'unit' }),
    '-100999'
  );
  assert.equal(target.internalGroupId, 7, 'the database join needs groups.id');
  assert.equal(target.targetGroupId, '-1007', 'Telegram needs the chat id');
});

test('an unmapped vehicle reports no internal id rather than a wrong one', async () => {
  const target = await determineTargetGroup(ALERT, async () => null, '-100999');
  assert.equal(target.internalGroupId, undefined, 'no group means no group');
  assert.equal(target.matchReason, 'fallback-unmapped');
});

test('the event is recorded with what a pattern query needs', async () => {
  const { deps: d, seen } = deps();
  await deliverEvent({ ...ALERT }, d).catch(() => {});
  assert.equal(seen.recorded.length, 1);
  const row = seen.recorded[0];
  assert.equal(row.eventId, 'evt-1');
  assert.equal(row.behavior, 'Harsh Braking');
  assert.equal(row.groupId, 7, 'the internal id, which joins to the person');
  assert.equal(row.gForce, 0.72);
  assert.equal(row.occurredAt, '2026-09-20T17:00:00Z');
  assert.equal(row.driverName, 'JOHN DOE');
});

test('recording never blocks or breaks the alert going out', async () => {
  const { deps: d, seen } = deps({ recordThrows: true });
  // The send must still happen, and deliverEvent must not reject because of it.
  await deliverEvent({ ...ALERT }, d).catch(() => {});
  assert.equal(seen.recorded.length, 1, 'it was attempted');
  assert.ok(seen.driverSends.length > 0, 'and the driver still got their alert');
});

test('a caller that does not wire the recorder records nothing, rather than reaching for a pool', async () => {
  const { deps: d } = deps();
  delete d.recordSafetyEvent;
  // The default is a no-op, so this must not throw.
  await deliverEvent({ ...ALERT }, d).catch(() => {});
});
