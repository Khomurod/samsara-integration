/**
 * The heartbeat, exercised through the REAL `executePoll`.
 *
 * WHY THIS FILE EXISTS, and it is the more useful half of the lesson. The
 * heartbeat module had six tests and all of them passed while the wiring in
 * `poller.js` was broken in two ways, because they tested `hubHeartbeat` in
 * isolation and nothing ever ran the function that calls it:
 *
 *   `newEventsCount` was declared inside `if (events.length > 0)` and READ
 *   after that block closed. Every successful poll threw a ReferenceError, the
 *   surrounding catch recorded an `error` heartbeat and set `lastApiError` to
 *   FETCH_ERROR — so the change written to make a dead poller visible would
 *   have reported every healthy poll as a failure, and corrupted the existing
 *   /health endpoint on the way past.
 *
 *   A non-2xx response returns early and never reaches that catch, so a
 *   sustained 401 or 429 wrote nothing at all — the ledger going silent in
 *   exactly the way a dead process does, which is the one distinction this
 *   whole mechanism exists to draw.
 *
 * Both were found by review rather than by the tests. So these run the poll.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const POLLER = require.resolve('../src/poller');
const HEARTBEAT = require.resolve('../src/hubHeartbeat');
const SETTINGS = require.resolve('../src/samsaraSettings');
const DB = require.resolve('../src/db');

/**
 * Load the real poller with its collaborators replaced.
 *
 * `require.cache` rather than a DI seam because `poller.js` resolves these at
 * module load, which is precisely the wiring under test: a seam here would test
 * the seam instead of the file.
 */
function loadPoller({ fetchImpl, settings = { enabled: true, apiKey: 'k', apiBase: 'https://x' } }) {
  const beats = [];
  const saved = new Map();
  for (const id of [POLLER, HEARTBEAT, SETTINGS, DB]) {
    if (require.cache[id]) saved.set(id, require.cache[id]);
    delete require.cache[id];
  }

  require.cache[HEARTBEAT] = {
    id: HEARTBEAT, filename: HEARTBEAT, loaded: true,
    exports: {
      SERVICE_KEY: 'samsara_safety_pipeline',
      async beat(status, opts) { beats.push({ status, ...opts }); return true; },
      heartbeatStatus() { return { configured: true }; },
    },
  };
  require.cache[SETTINGS] = {
    id: SETTINGS, filename: SETTINGS, loaded: true,
    exports: { loadSamsaraConfig: async () => settings },
  };
  require.cache[DB] = {
    id: DB, filename: DB, loaded: true,
    exports: {
      getPgPool: () => null,
      getCursor: () => '', saveCursor: () => {}, clearCursor: () => {},
      getPollWatermark: async () => null, savePollWatermark: async () => {},
      initPgDb: async () => {},
      getEventDeliveries: async () => [], recordEventDelivery: async () => {},
      isEventProcessed: async () => false, markEventProcessed: async () => {},
    },
  };

  const realFetch = global.fetch;
  global.fetch = fetchImpl;

  // eslint-disable-next-line global-require
  const poller = require('../src/poller');
  const restore = () => {
    global.fetch = realFetch;
    for (const id of [POLLER, HEARTBEAT, SETTINGS, DB]) {
      if (saved.has(id)) require.cache[id] = saved.get(id); else delete require.cache[id];
    }
  };
  return { poller, beats, restore };
}

const ok = (data = []) => async () => ({
  ok: true, status: 200,
  async json() { return { data, pagination: {} }; },
  async text() { return ''; },
});

test('A SUCCESSFUL POLL WITH NO EVENTS REPORTS ok, NOT an error', async (t) => {
  const { poller, beats, restore } = loadPoller({ fetchImpl: ok([]) });
  t.after(restore);

  await poller.executePoll();

  assert.equal(beats.length, 1);
  assert.equal(beats[0].status, 'ok',
    'the counter was read outside the block that declared it, so every healthy '
    + 'poll threw and was recorded as a failure');
  assert.equal(beats[0].summary.newEvents, 0);
});

test('a successful poll WITH events still reports ok, and counts them', async (t) => {
  const events = [
    { id: 'e1', vehicle: { name: 'WENZE UNIT # 310', id: 'v1' }, driver: { name: 'SAM' } },
    { id: 'e2', vehicle: { name: 'WENZE UNIT # 311', id: 'v2' }, driver: { name: 'ALEX' } },
  ];
  const { poller, beats, restore } = loadPoller({ fetchImpl: ok(events) });
  t.after(restore);

  await poller.executePoll();
  assert.equal(beats[0].status, 'ok');
  assert.equal(beats[0].summary.newEvents, 2);
});

test('A NON-2xx RESPONSE IS REPORTED, rather than leaving the ledger silent', async (t) => {
  const { poller, beats, restore } = loadPoller({
    fetchImpl: async () => ({
      ok: false, status: 401,
      async text() { return '{"message":"invalid api key sk-live-REDACTED"}'; },
      async json() { return {}; },
    }),
  });
  t.after(restore);

  await poller.executePoll();

  assert.equal(beats.length, 1, 'a sustained 401 must not look like a dead process');
  assert.equal(beats[0].status, 'error');
  assert.match(beats[0].detail, /HTTP 401/);
});

test('and the provider’s BODY never travels, only the status code', async (t) => {
  const { poller, beats, restore } = loadPoller({
    fetchImpl: async () => ({
      ok: false, status: 429,
      async text() { return 'rate limited; your key sk-live-SECRET made 900 requests'; },
      async json() { return {}; },
    }),
  });
  t.after(restore);

  await poller.executePoll();
  assert.equal(beats[0].detail.includes('sk-live'), false,
    'the hub publishes a summary of this row on a public endpoint');
  assert.equal(beats[0].detail, 'the Samsara safety-events request returned HTTP 429');
});

test('a network failure is reported without the thrown message', async (t) => {
  const { poller, beats, restore } = loadPoller({
    fetchImpl: async () => { throw new Error('ECONNREFUSED 10.1.2.3:443'); },
  });
  t.after(restore);

  await poller.executePoll();
  assert.equal(beats[0].status, 'error');
  assert.equal(beats[0].detail.includes('10.1.2.3'), false);
});

test('switched off in the admin panel is blocked, and no request is made', async (t) => {
  let called = 0;
  const { poller, beats, restore } = loadPoller({
    fetchImpl: async () => { called += 1; return ok([])(); },
    settings: { enabled: false, apiKey: 'k' },
  });
  t.after(restore);

  await poller.executePoll();
  assert.equal(called, 0);
  assert.equal(beats[0].status, 'blocked');
  assert.match(beats[0].detail, /switched off/);
});
