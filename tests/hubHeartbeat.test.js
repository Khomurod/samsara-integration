/**
 * The one row this service writes into the hub's ledger.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. This poller is a separate Render service
 * sharing only a database. From the hub's side "the poller has been dead since
 * Tuesday" and "the fleet had a quiet week" produce the same evidence — an
 * empty safety table — and a fleet genuinely can have a quiet week. This row is
 * the only thing that separates them.
 *
 * Two promises are asserted here, and both are about what must NOT happen: the
 * heartbeat never throws into the poll it reports on, and nothing a provider
 * wrote ever reaches a row the hub publishes a summary of.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DB_PATH = require.resolve('../src/db');
const HEARTBEAT_PATH = require.resolve('../src/hubHeartbeat');

function load({ pool }) {
  delete require.cache[HEARTBEAT_PATH];
  const realDb = require.cache[DB_PATH];
  require.cache[DB_PATH] = {
    id: DB_PATH, filename: DB_PATH, loaded: true, exports: { getPgPool: () => pool },
  };
  const mod = require('../src/hubHeartbeat');
  if (realDb) require.cache[DB_PATH] = realDb; else delete require.cache[DB_PATH];
  return mod;
}

function recordingPool() {
  const calls = [];
  return {
    calls,
    async query(text, values) { calls.push({ text, values }); return { rowCount: 1 }; },
  };
}

test('a successful poll writes one row under the key the hub watches', async () => {
  const pool = recordingPool();
  const hb = load({ pool });
  const ok = await hb.beat('ok', { summary: { newEvents: 3 } });

  assert.equal(ok, true);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /INSERT INTO background_service_runs/);
  assert.match(pool.calls[0].text, /ON CONFLICT \(service_key\) DO UPDATE/,
    'one row updated in place — this is a heartbeat, not a run history');
  assert.equal(pool.calls[0].values[0], 'samsara_safety_pipeline');
  assert.equal(pool.calls[0].values[1], 'ok');
  assert.equal(JSON.parse(pool.calls[0].values[3]).newEvents, 3);
});

test('a failed poll is recorded as an error WITHOUT the provider’s message', async () => {
  const pool = recordingPool();
  const hb = load({ pool });
  await hb.beat('error', { detail: 'the Samsara safety-events request failed' });

  const [, status, detail] = pool.calls[0].values;
  assert.equal(status, 'error');
  assert.equal(detail, 'the Samsara safety-events request failed');
  assert.equal(pool.calls[0].values[4], true, 'and it counts as a failure');
});

test('"switched off" is blocked, not failed', async () => {
  const pool = recordingPool();
  const hb = load({ pool });
  await hb.beat('blocked', { detail: 'Samsara is switched off in the admin panel' });

  assert.equal(pool.calls[0].values[1], 'blocked');
  assert.equal(pool.calls[0].values[4], false,
    'a feature nobody switched on must never enter a failure count — otherwise '
    + 'the "needs a person" list fills with things that were never wanted');
});

test('with no DATABASE_URL it does nothing and says so, rather than throwing', async () => {
  const hb = load({ pool: null });
  assert.equal(await hb.beat('ok'), false);
  assert.equal(hb.heartbeatStatus().configured, false);
});

test('a database error never escapes into the poll it is reporting on', async () => {
  const hb = load({ pool: { async query() { throw new Error('relation does not exist'); } } });
  assert.equal(await hb.beat('ok'), false, 'a hub that has not applied the migration writes nothing');
  assert.match(hb.heartbeatStatus().lastFailure, /relation does not exist/);
});

test('the detail is capped, because it ends up on a public endpoint', async () => {
  const pool = recordingPool();
  const hb = load({ pool });
  await hb.beat('error', { detail: 'x'.repeat(5000) });
  assert.equal(pool.calls[0].values[2].length, 300);
});
