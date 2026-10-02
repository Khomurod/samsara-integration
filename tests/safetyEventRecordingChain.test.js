/**
 * The REAL path from a Samsara event to the recorder.
 *
 * tests/safetyEventRecording.test.js hands deliverEvent an alert it built by
 * hand, WITH an `eventTime` — a field the formatter never produced. So it
 * proved the recorder works on a shape production never sends, and every
 * safety event since recording shipped (2026-09-11) was refused for a missing
 * time while that test stayed green. The hub's reconciliation said it outright:
 * "8 event(s) picked up and only 0 row(s) were recorded".
 *
 * This file builds nothing by hand. It runs the same functions the pollers
 * run — formatAlert, enqueueFormattedAlert, deliverEvent — and checks what
 * reaches the recorder, and then that the real recorder would accept it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { formatAlert } = require('../src/formatter');
const { enqueueFormattedAlert } = require('../src/videoRetryDelivery');
const { deliverEvent } = require('../src/broadcastDelivery');
const { determineTargetGroup } = require('../src/routing');

// The webhook-shaped payload poller.js transformApiEventToWebhookShape builds.
function harshBrakePayload() {
  return {
    eventType: 'AlertIncident',
    eventTime: '2026-10-02T12:30:00Z',
    data: {
      happenedAtTime: '2026-10-02T12:30:00Z',
      conditions: [{
        description: 'A safety event occurred',
        details: {
          harshEvent: {
            vehicle: { id: 'veh-9', name: 'WENZE 310' },
            gForce: 0.71,
            location: { latitude: 41.88, longitude: -87.63, formattedLocation: 'Chicago, IL' },
          },
        },
      }],
    },
    _enrichedEventType: 'Harsh Brake',
  };
}

// The shape speedingPoller.js transformV2SpeedEvent hands the formatter.
function speedingPayload() {
  return {
    eventType: 'AlertIncident',
    eventTime: '2026-10-02T13:00:00Z',
    data: {
      happenedAtTime: '2026-10-02T13:00:00Z',
      conditions: [{
        description: 'Speeding',
        details: {
          vehicle: { id: 'veh-9', name: 'WENZE 310' },
          speed: { currentSpeedKilometersPerHour: 120, thresholdSpeedKilometersPerHour: 104.6 },
        },
      }],
    },
  };
}

function deliveryDeps(recorded) {
  return {
    bot: { telegram: {} },
    driverBot: { async sendMessage() { return { message_id: 1 }; } },
    store: { async findGroupByUnit() { return { groupId: 7, telegramGroupId: '-1007', groupName: 'g', matchReason: 'unit' }; }, async getAll() { return []; } },
    determineTargetGroup,
    async resolveDriverCaption(_a, text) { return text; },
    async sendDriverGroupAlert() { return { message_id: 2 }; },
    isDriverMembershipAccessError: () => false,
    appendDriverMissingNote: (t) => t,
    tracker: { async getTargetStatuses() { return new Map(); }, async recordSuccess() {}, async recordPermanentSkip() {} },
    log: { log() {}, warn() {}, error() {} },
    classifyTelegramError: () => ({ permanent: false }),
    managementGroupId: '-100999',
    async getVideoBuffer() { return null; },
    async recordSafetyEvent(row) { recorded.push(row); return true; },
  };
}

// The pollers set these three on the formatted alert (poller.js / speedingPoller.js).
function asThePollerDoes(formatted) {
  formatted.vehicleName = 'WENZE 310';
  formatted.vehicleId = 'veh-9';
  formatted.driverName = null;
  return formatted;
}

async function throughTheRealChain(payload, rawId) {
  const formatted = asThePollerDoes(await formatAlert(payload));
  let queued = null;
  enqueueFormattedAlert(formatted, { id: rawId }, (a) => { queued = a; });
  const recorded = [];
  await deliverEvent(queued, deliveryDeps(recorded)).catch(() => {});
  return recorded;
}

test('a harsh brake reaches the recorder with its time, its kind and its id', async () => {
  const recorded = await throughTheRealChain(harshBrakePayload(), 'evt-brake');
  assert.equal(recorded.length, 1);
  const row = recorded[0];
  assert.equal(row.eventId, 'evt-brake');
  assert.equal(row.behavior, 'Harsh Brake');
  assert.equal(row.occurredAt, '2026-10-02T12:30:00Z', 'the field the recorder refused without');
  assert.equal(row.gForce, 0.71);
  assert.equal(row.lat, 41.88);
  assert.equal(row.lng, -87.63);
  assert.equal(row.groupId, 7);
});

test('a speeding event carries numbers, never display strings', async () => {
  const [row] = await throughTheRealChain(speedingPayload(), 'evt-speed');
  assert.equal(row.occurredAt, '2026-10-02T13:00:00Z');
  assert.equal(row.speedMph, 74.56);
  assert.equal(row.postedSpeedMph, 65);
  assert.equal(row.severity, null, '"N/A" is a display string, not a severity');
});

test('the real recorder would accept what the chain hands it', async () => {
  // Load the store with no database: the field check runs BEFORE any I/O,
  // so a refusal for a missing field is visible without one.
  delete process.env.DATABASE_URL;
  const store = require('../src/safetyEventStore');
  const before = store.recordingStatus().refusedSinceBoot;
  const [row] = await throughTheRealChain(harshBrakePayload(), 'evt-accept');
  await store.recordSafetyEvent(row);
  assert.equal(store.recordingStatus().refusedSinceBoot, before,
    'a refusal here means the chain still drops a field the row needs');
});

test('a row with no time is refused OUT LOUD — counted and named', async () => {
  delete process.env.DATABASE_URL;
  const store = require('../src/safetyEventStore');
  const before = store.recordingStatus().refusedSinceBoot;
  const ok = await store.recordSafetyEvent({ eventId: 'evt-x', behavior: 'Harsh Brake', occurredAt: null });
  assert.equal(ok, false);
  const status = store.recordingStatus();
  assert.equal(status.refusedSinceBoot, before + 1);
  assert.equal(status.lastRefusal, 'missing occurredAt');
});
