'use strict';

/**
 * The one line of wiring nothing executed.
 *
 * `src/safetyEventStore.js` opened with `const { pool } = require('./db')`, and
 * `db.js` has never exported a `pool` — only `getPgPool()`. So `pool` was
 * `undefined`, every `pool.query` threw, the catch swallowed it, and
 * `recordSafetyEvent` returned false before touching the database. For the
 * whole life of the feature. Alerts went out normally and
 * `driver_safety_events` stayed empty while the coaching engine downstream
 * waited for rows that could never arrive.
 *
 * IT SURVIVED BECAUSE EVERY TEST AVOIDED THE REAL MODULE. The delivery test
 * injects a fake recorder; the other test of this file imports only the pure
 * `unitFromVehicleName`. The single line that mattered was never run anywhere.
 *
 * So this file runs it: the REAL `recordSafetyEvent`, against a stand-in pool
 * handed over through the same `getPgPool()` the real one comes from.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DB_PATH = require.resolve('../src/db');
const STORE_PATH = require.resolve('../src/safetyEventStore');
const ROUTING_PATH = require.resolve('../src/routing');

/** A pool that records what it was asked, and answers like Postgres. */
function fakePool({ failOn = null, personId = 11 } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql).trim(), params });
      if (failOn && String(sql).includes(failOn)) throw new Error(`boom on ${failOn}`);
      if (/FROM driver_person_groups/.test(sql)) {
        return { rows: personId === null ? [] : [{ person_id: personId }] };
      }
      if (/INSERT INTO driver_safety_events/.test(sql)) {
        return { rowCount: 1, rows: [{ samsara_event_id: params[0] }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function loadStore(pool) {
  for (const p of [STORE_PATH, DB_PATH]) delete require.cache[p];
  require.cache[DB_PATH] = {
    id: DB_PATH, filename: DB_PATH, loaded: true,
    exports: { getPgPool: () => pool },
  };
  // routing.js pulls in its own dependencies; keep the real one, it is pure.
  delete require.cache[ROUTING_PATH];
  return require(STORE_PATH);
}

const EVENT = {
  eventId: 'evt-1',
  behavior: 'HarshBraking',
  severity: 'medium',
  gForce: 0.72,
  speedMph: 61,
  postedSpeedMph: 65,
  occurredAt: '2026-09-11T08:00:00.000Z',
  vehicleId: 'veh-9',
  vehicleName: '2021 Freightliner 305',
  driverName: 'JOHN DOE',
  groupId: 7,
  lat: 41.88,
  lng: -87.63,
};

test('THE REAL recordSafetyEvent WRITES A ROW — the wiring is executed here', async () => {
  const pool = fakePool();
  const store = loadStore(pool);

  const wrote = await store.recordSafetyEvent(EVENT);
  assert.equal(wrote, true, 'a new event is recorded');

  const insert = pool.queries.find((q) => /INSERT INTO driver_safety_events/.test(q.sql));
  assert.ok(insert, 'an INSERT actually reached the pool');
});

test('the table is ensured once, not on every event', async () => {
  const pool = fakePool();
  const store = loadStore(pool);
  await store.recordSafetyEvent(EVENT);
  await store.recordSafetyEvent({ ...EVENT, eventId: 'evt-2' });
  const creates = pool.queries.filter((q) => /CREATE TABLE IF NOT EXISTS driver_safety_events/.test(q.sql));
  assert.equal(creates.length, 1);
});

test('THE PERSON IS RESOLVED AND STORED, so a truck change does not reset the history', async () => {
  const pool = fakePool({ personId: 42 });
  const store = loadStore(pool);
  await store.recordSafetyEvent(EVENT);

  const lookup = pool.queries.find((q) => /FROM driver_person_groups/.test(q.sql));
  assert.ok(lookup, 'the identity spine is consulted');
  assert.deepEqual(lookup.params, [7], 'by the chat the alert routed to');

  const insert = pool.queries.find((q) => /INSERT INTO driver_safety_events/.test(q.sql));
  assert.equal(insert.params[1], 42, 'person_id is written');
  assert.equal(insert.params[2], 7, 'and the group beside it');
});

test('an unresolvable person still records the event against the chat', async () => {
  const pool = fakePool({ personId: null });
  const store = loadStore(pool);
  assert.equal(await store.recordSafetyEvent(EVENT), true);
  const insert = pool.queries.find((q) => /INSERT INTO driver_safety_events/.test(q.sql));
  assert.equal(insert.params[1], null, 'no person');
  assert.equal(insert.params[2], 7, 'but the chat is kept — the event is not thrown away');
});

test('the unit is parsed properly, not as the first number in the label', async () => {
  const pool = fakePool();
  const store = loadStore(pool);
  await store.recordSafetyEvent(EVENT);
  const insert = pool.queries.find((q) => /INSERT INTO driver_safety_events/.test(q.sql));
  assert.equal(insert.params[4], '305', '"2021 Freightliner 305" is unit 305, not 2021');
});

test('no media reference is ever stored — a Samsara URL is a credential', async () => {
  const pool = fakePool();
  const store = loadStore(pool);
  await store.recordSafetyEvent({ ...EVENT, videoUrl: 'https://signed.example/x?token=abc' });
  const whole = JSON.stringify(pool.queries);
  assert.ok(!whole.includes('signed.example'), 'no URL reaches the database');
  assert.ok(!whole.includes('token=abc'));
});

// ── the failure modes, told apart ────────────────────────────────────────────

test('NO DATABASE means not configured — reported, not mistaken for a fault', async () => {
  const store = loadStore(null);
  assert.equal(await store.recordSafetyEvent(EVENT), false);
  const status = store.recordingStatus();
  assert.equal(status.configured, false);
  assert.equal(status.lastFailure, 'no_database_url');
});

test('a failing database is reported AS A FAULT, with the reason kept', async () => {
  const store = loadStore(fakePool({ failOn: 'CREATE TABLE' }));
  assert.equal(await store.recordSafetyEvent(EVENT), false);
  const status = store.recordingStatus();
  assert.equal(status.configured, true, 'a database exists');
  assert.equal(status.ready, false);
  assert.match(status.lastFailure, /ensure_failed/, 'and it said why');
});

test('a healthy store reports ready, so an empty table can be told from a broken one', async () => {
  const store = loadStore(fakePool());
  await store.recordSafetyEvent(EVENT);
  assert.deepEqual(store.recordingStatus(), { ready: true, configured: true, lastFailure: null });
});

test('an incomplete event is refused before any query', async () => {
  const pool = fakePool();
  const store = loadStore(pool);
  for (const bad of [
    { ...EVENT, eventId: null },
    { ...EVENT, behavior: null },
    { ...EVENT, occurredAt: null },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await store.recordSafetyEvent(bad), false);
  }
  assert.deepEqual(pool.queries, [], 'nothing was asked of the database');
});

// ── the unit column, and the comment that was wrong about it ─────────────────

test('a vehicle label with a model year reads as the UNIT, not the year', () => {
  const { unitFromVehicleName: u } = loadStore(fakePool());
  assert.equal(u('2021 Freightliner 305'), '305');
  assert.equal(u('WENZE 2024 UNIT # 310'), '310', 'an explicit marker always wins');
  assert.equal(u('2019 Volvo 77'), '77');
});

test('routing.js still has the bug this file used to inherit — deliberately untouched', () => {
  // `extractUnitNumber` is `raw.match(/\d+/)`. It decides WHICH DRIVER GROUP
  // receives a safety alert, which is live behaviour with a fleet of group
  // titles behind it, and it now runs second to the stored vehicle link and
  // files a finding whenever the fallback fires. Correcting a convenience
  // column is free; changing alert routing is not, so it is reported instead.
  // eslint-disable-next-line global-require
  const { extractUnitNumber } = require('../src/routing');
  assert.equal(extractUnitNumber('2021 Freightliner 305'), '2021',
    'if this ever changes, revisit the note in safetyEventStore.js');
});

test('an explicit marker beats a trailing number', () => {
  const { unitFromVehicleName: u } = loadStore(fakePool());
  assert.equal(u('UNIT # 310 spare 999'), '310');
  assert.equal(u('#77 Peterbilt'), '77');
});

test('a label with nothing but a year keeps the year rather than inventing null', () => {
  const { unitFromVehicleName: u } = loadStore(fakePool());
  assert.equal(u('2021'), '2021', 'it is the only number there; guessing otherwise is worse');
  assert.equal(u('Freightliner'), null);
  assert.equal(u(''), null);
  assert.equal(u(null), null);
});
