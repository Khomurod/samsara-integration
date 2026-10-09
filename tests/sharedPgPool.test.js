/**
 * ONE Postgres pool for the whole process, configured to KEEP its connection.
 *
 * Measured in production on 2026-10-09, with this service alone on the
 * database: Supavisor authenticated ~3.3 NEW connections a minute. Each is a
 * TLS handshake, SCRAM auth and parameter status — several KB of Supabase
 * egress before a single query — and together they cost more than the Free
 * plan's whole daily budget. Three modules built their own pool, and node-pg
 * closes an idle client after 10 s while the poll runs every 15 s, so nearly
 * every poll reconnected.
 *
 * So: one `new Pool` in the code base; the modules that built their own go
 * through it; it keeps its connection between polls; and a dropped idle
 * connection is logged instead of becoming an uncaught 'error' event.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadDbWithFakePg, FAKE_DATABASE_URL } = require('./helpers/fakePg');

const ROOT = path.resolve(__dirname, '..');

/** Every hand-written JavaScript file that runs in, or beside, the service. */
function sourceFiles() {
  const inSrc = fs.readdirSync(path.join(ROOT, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/${f}`);
  const atRoot = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
  return [...inSrc, ...atRoot];
}

function filesMatching(pattern) {
  return sourceFiles().filter((f) => pattern.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
}

test('`new Pool(` appears in src/db.js and nowhere else', () => {
  assert.deepEqual(filesMatching(/new\s+Pool\s*\(/), ['src/db.js'],
    'every extra pool is extra connections, and each new connection is paid for in egress');
});

test("only src/db.js requires 'pg' at all", () => {
  assert.deepEqual(filesMatching(/require\(\s*['"]pg['"]\s*\)/), ['src/db.js']);
});

test('the shared pool keeps its connection between polls', (t) => {
  const { db, pools, restore } = loadDbWithFakePg();
  t.after(restore);

  assert.equal(pools.length, 1);
  assert.equal(db.getPgPool(), pools[0], 'getPgPool() hands out THE pool');
  const options = pools[0].options;
  assert.equal(options.idleTimeoutMillis, 600_000,
    "node-pg's 10 s default closed the connection before every 15 s poll");
  assert.equal(options.max, 3);
  assert.equal(options.keepAlive, true);
  assert.equal(options.keepAliveInitialDelayMillis, 60_000);
  assert.equal(options.connectionString, FAKE_DATABASE_URL);
  assert.deepEqual(options.ssl, { rejectUnauthorized: false }, 'TLS exactly as before');
});

test('PG_POOL_MAX and PG_IDLE_TIMEOUT_MS override the two numbers; nonsense falls back', () => {
  const overridden = loadDbWithFakePg({ env: { PG_POOL_MAX: '5', PG_IDLE_TIMEOUT_MS: '0' } });
  overridden.restore();
  assert.equal(overridden.pools[0].options.max, 5);
  assert.equal(overridden.pools[0].options.idleTimeoutMillis, 0, "node-pg's 'never close an idle client'");

  const nonsense = loadDbWithFakePg({ env: { PG_POOL_MAX: '0', PG_IDLE_TIMEOUT_MS: 'soon' } });
  nonsense.restore();
  assert.equal(nonsense.pools[0].options.max, 3, 'a pool of zero is not a pool');
  assert.equal(nonsense.pools[0].options.idleTimeoutMillis, 600_000);

  const none = loadDbWithFakePg({ env: { DATABASE_URL: undefined } });
  none.restore();
  assert.equal(none.pools.length, 0, 'no DATABASE_URL is still no pool, as before');
  assert.equal(none.db.getPgPool(), null);
});

test('a dropped idle connection is logged by its message and cannot crash the process', (t) => {
  const { pools, restore } = loadDbWithFakePg();
  t.after(restore);
  const pool = pools[0];
  assert.equal(pool.listenerCount('error'), 1,
    "an 'error' event with no listener is thrown as an uncaught exception");

  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const dropped = Object.assign(new Error('Connection terminated unexpectedly'), { address: '10.0.0.9' });
    assert.doesNotThrow(() => pool.emit('error', dropped, {}));
  } finally {
    console.error = realError;
  }

  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes('Connection terminated unexpectedly'));
  assert.ok(!logged[0].some((arg) => arg instanceof Error), 'the message, never the error object');
});

test('store.js resolves driver groups through the ONE pool instead of building its own', async (t) => {
  const GROUP = { id: 7, telegram_group_id: '-700', group_name: 'WENZE UNIT # 305 JOHN DOE' };
  const { pools, queries, restore } = loadDbWithFakePg({
    answer: (sql) => (/FROM groups/.test(sql) ? { rows: [GROUP] } : { rows: [] }),
  });
  const STORE = require.resolve('../src/store');
  delete require.cache[STORE];
  t.after(() => {
    delete require.cache[STORE];
    restore();
  });

  // eslint-disable-next-line global-require
  const store = require(STORE);
  const routed = await store.findGroupByUnit('305', 'JOHN DOE', 'WENZE UNIT # 305 JOHN DOE', 'veh-1');

  assert.equal(pools.length, 1, 'store.js used to open a second pool of its own');
  assert.equal(routed?.groupId, 7);
  assert.equal(queries.filter((q) => /FROM groups/.test(q.sql)).length, 2,
    'the stored-link lookup and the name parse, both on the shared pool');
});
