/**
 * `samsara_poll_state`, read once per key and written only when it changes.
 *
 * Measured in production on 2026-10-09: ~3.3 `SELECT value FROM
 * samsara_poll_state` a minute. Only this service writes those keys, so after
 * the first read the table could never answer anything this process did not
 * already know. Writes stay write-through and are skipped ONLY for an
 * unchanged value — never on a timer, because a watermark that lags the
 * alerts already sent widens what is re-scanned after a crash.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { loadDbWithFakePg } = require('./helpers/fakePg');

const isRead = (q) => /SELECT value FROM samsara_poll_state/.test(q.sql);
const isWrite = (q) => /INSERT INTO samsara_poll_state/.test(q.sql);

/** Run `fn` with console.error captured: a failed read or write is expected to log. */
async function quietly(fn) {
  const realError = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = realError; }
}

test('a key is read from the table once, then served from memory', async (t) => {
  const { db, queries, restore } = loadDbWithFakePg({
    answer: (sql, params) => (/SELECT value/.test(sql) && params[0] === 'a'
      ? { rows: [{ value: 'stored-a' }] }
      : { rows: [] }),
  });
  t.after(restore);

  assert.equal(await db.getPollState('a'), 'stored-a');
  assert.equal(await db.getPollState('a'), 'stored-a');
  assert.equal(await db.getPollState('b'), null, 'no row yet');
  assert.equal(await db.getPollState('b'), null);
  assert.equal(queries.filter(isRead).length, 2, 'one SELECT per key — not one per poll');
});

test('a FAILED read is not remembered: the next call asks the table again', async (t) => {
  let failing = true;
  const { db, queries, restore } = loadDbWithFakePg({
    answer: (sql) => {
      if (failing && /SELECT value/.test(sql)) throw new Error('connection terminated');
      return { rows: [{ value: 'v1' }] };
    },
  });
  t.after(restore);

  assert.equal(await quietly(() => db.getPollState('k')), null);
  failing = false;
  assert.equal(await db.getPollState('k'), 'v1', 'the next read goes to the table, as every read used to');
  assert.equal(await db.getPollState('k'), 'v1');
  assert.equal(queries.filter(isRead).length, 2);
});

test('a value is written only when it changes, and what was written is not read back', async (t) => {
  const { db, queries, restore } = loadDbWithFakePg();
  t.after(restore);

  await db.savePollState('cursor', 'c1');
  await db.savePollState('cursor', 'c1');
  await db.savePollState('cursor', 'c2');

  assert.deepEqual(queries.filter(isWrite).map((q) => q.params), [['cursor', 'c1'], ['cursor', 'c2']]);
  assert.equal(await db.getPollState('cursor'), 'c2');
  assert.equal(queries.filter(isRead).length, 0, 'memory already holds what the table holds');
});

test('a value read from the table is not written straight back', async (t) => {
  const { db, queries, restore } = loadDbWithFakePg({
    answer: (sql) => (/SELECT value/.test(sql) ? { rows: [{ value: 'c1' }] } : { rows: [] }),
  });
  t.after(restore);

  await db.getPollState('cursor');
  await db.savePollState('cursor', 'c1');
  assert.equal(queries.filter(isWrite).length, 0);
});

test('a FAILED write is retried with the same value — memory never claims a write that did not land', async (t) => {
  let failing = true;
  const { db, queries, restore } = loadDbWithFakePg({
    answer: (sql) => {
      if (failing && /INSERT INTO samsara_poll_state/.test(sql)) throw new Error('connection terminated');
      return { rows: [] };
    },
  });
  t.after(restore);

  await quietly(() => db.savePollState('cursor', 'c1'));
  failing = false;
  await db.savePollState('cursor', 'c1');

  assert.equal(queries.filter(isWrite).length, 2, 'skipping it would leave the table on the old value');
  assert.equal(await db.getPollState('cursor'), 'c1');
});

test('the safety watermark is read once at boot, even before the table has a row', async (t) => {
  const { db, queries, restore } = loadDbWithFakePg();
  t.after(restore);

  assert.equal(await db.getPollWatermark(), null);
  assert.equal(await db.getPollWatermark(), null, 'an absent row was asked about on every poll');
  assert.equal(queries.filter(isRead).length, 1);

  await db.savePollWatermark('2026-10-09T12:00:00.000Z');
  assert.equal(await db.getPollWatermark(), '2026-10-09T12:00:00.000Z');
  assert.equal(queries.filter(isRead).length, 1);
});

test('a failed watermark write still moves the poller on, and the table catches up', async (t) => {
  let failing = true;
  const { db, queries, restore } = loadDbWithFakePg({
    answer: (sql) => {
      if (failing && /INSERT INTO samsara_poll_state/.test(sql)) throw new Error('connection terminated');
      return { rows: [] };
    },
  });
  t.after(restore);

  await quietly(() => db.savePollWatermark('2026-10-09T12:00:00.000Z'));
  assert.equal(await db.getPollWatermark(), '2026-10-09T12:00:00.000Z',
    "the poller's own window advances whether or not the write landed, exactly as before");
  assert.equal(await db.getPollState('last_successful_poll_end_time'), null,
    'while the table-side view still says the table never got it');

  failing = false;
  await db.savePollWatermark('2026-10-09T12:00:30.000Z');
  assert.deepEqual(queries.filter(isWrite).map((q) => q.params[1]),
    ['2026-10-09T12:00:00.000Z', '2026-10-09T12:00:30.000Z']);
});

test('a speeding poll reads its state once, then writes only what moved', async (t) => {
  const { pools, queries, restore } = loadDbWithFakePg();
  const SETTINGS = require.resolve('../src/samsaraSettings');
  const POLLER = require.resolve('../src/speedingPoller');
  // eslint-disable-next-line global-require
  const realSettings = require(SETTINGS);
  const savedSettings = require.cache[SETTINGS];
  require.cache[SETTINGS] = {
    id: SETTINGS,
    filename: SETTINGS,
    loaded: true,
    exports: {
      ...realSettings,
      loadSamsaraConfig: async () => ({
        enabled: true, speedingEventsEnabled: true, apiKey: 'test-key', apiBase: 'https://samsara.test',
      }),
    },
  };
  // Fresh, so it is built against the db.js loaded above (its poll-state
  // module reaches db.js when a query runs, so it needs no reset of its own).
  delete require.cache[POLLER];
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() { return { data: [], pagination: { endCursor: 'cursor-1', hasNextPage: false } }; },
    async text() { return ''; },
  });
  t.after(() => {
    global.fetch = realFetch;
    require.cache[SETTINGS] = savedSettings;
    delete require.cache[POLLER];
    restore();
  });

  // eslint-disable-next-line global-require
  const speedingPoller = require(POLLER);
  await speedingPoller.executePoll();
  // A later endTime, as the real next poll (30 s on) would have.
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  await speedingPoller.executePoll();

  assert.equal(pools.length, 1, 'speedingPoller.js used to open a pool of its own');
  assert.equal(queries.filter(isRead).length, 2, 'cursor and watermark, once each, on the first poll only');
  assert.deepEqual(
    queries.filter(isWrite).map((q) => q.params[0]),
    ['speeding_stream_cursor', 'speeding_stream_last_end_time', 'speeding_stream_last_end_time'],
    'the unchanged cursor is not written again; the watermark moves every poll, so it is',
  );
  assert.ok(speedingPoller.getStatus().lastSuccessAt, 'and the polls themselves completed');
});

test('without a database the speeding state still lives in its JSON file, untouched by the cache', async (t) => {
  const DB = require.resolve('../src/db');
  const STATE = require.resolve('../src/speedingPollState');
  const savedDb = require.cache[DB];
  const notThisPath = async () => { throw new Error('the cache serves the database path only'); };
  require.cache[DB] = {
    id: DB,
    filename: DB,
    loaded: true,
    exports: { getPgPool: () => null, getPollState: notThisPath, savePollState: notThisPath },
  };
  delete require.cache[STATE];
  // eslint-disable-next-line global-require
  const state = require(STATE);

  // An in-memory stand-in for data/speeding-stream-state.json, so the test
  // never touches a developer's real state file.
  let disk = JSON.stringify({ speeding_stream_cursor: 'from-file' });
  const isStateFile = (p) => String(p).endsWith('speeding-stream-state.json');
  const real = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
  fs.existsSync = (p) => (isStateFile(p) ? true : real.existsSync(p));
  fs.readFileSync = (p, ...rest) => (isStateFile(p) ? disk : real.readFileSync(p, ...rest));
  fs.writeFileSync = (p, data, ...rest) => {
    if (isStateFile(p)) disk = String(data);
    else real.writeFileSync(p, data, ...rest);
  };
  t.after(() => {
    Object.assign(fs, real);
    if (savedDb) require.cache[DB] = savedDb; else delete require.cache[DB];
    delete require.cache[STATE];
  });

  assert.equal(await state.getPollState('speeding_stream_cursor'), 'from-file');
  await state.savePollState('speeding_stream_cursor', 'c2');
  await state.markSpeedingEventProcessed('evt-1');

  assert.equal(JSON.parse(disk).speeding_stream_cursor, 'c2');
  assert.deepEqual(JSON.parse(disk).speeding_processed_ids, ['speed:evt-1']);
  assert.equal(await state.isSpeedingEventProcessed('evt-1'), true);
});
