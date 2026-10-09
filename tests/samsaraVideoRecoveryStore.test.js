/**
 * The durable recovery store's SQL contract.
 *
 * Three properties of the SQL are what make the whole feature safe, and each is
 * asserted here against a recording pool rather than left to a code review:
 *
 *   · ENQUEUE IS IDEMPOTENT — `ON CONFLICT (samsara_event_id) DO NOTHING` on a
 *     UNIQUE column. That is what stops a re-delivered event producing a second
 *     recovery and therefore a duplicate Samsara retrieval request.
 *   · CLAIMING IS EXCLUSIVE — `FOR UPDATE SKIP LOCKED` plus a `locked_at`
 *     marker, with a stale claim reclaimable, so a process killed mid-job
 *     strands nothing and two ticks never work one row.
 *   · ATTEMPTS ARE COUNTED IN ONE PLACE — `attempts = attempts + 1` in
 *     `reschedule`, never by a caller.
 *
 * The table's DDL is owned by bot-backend migration 0013; the CREATE TABLE IF
 * NOT EXISTS mirrored here only lets this service boot first.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createVideoRecoveryStore, _sql } = require('../src/videoRecoveryStore');

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

/** A pool that records every statement and answers with whatever is queued. */
function recordingPool(responses = []) {
  const queries = [];
  let i = 0;
  return {
    queries,
    query: async (text, values) => {
      queries.push({ text, values });
      const next = responses[i++];
      if (next instanceof Error) throw next;
      return next || { rows: [] };
    },
  };
}

test('enqueue is idempotent by construction', async () => {
  const pool = recordingPool([{ rows: [{ id: 1 }] }]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });

  const out = await store.enqueue({
    eventId: 'evt-1',
    vehicleId: 'veh-9',
    eventTime: new Date('2026-05-29T14:56:32.338Z'),
    isSpeeding: true,
    rawEvent: { id: 'evt-1' },
    targets: [{ botKind: 'notification', chatId: '-1', messageId: 5 }],
    nextCheckAt: new Date('2026-05-29T15:01:32.338Z'),
  });

  assert.equal(out.created, true);
  const sql = pool.queries[0].text;
  assert.match(sql, /ON CONFLICT \(samsara_event_id\) DO NOTHING/);
  assert.match(sql, /status\s*,\s*next_check_at/s);
  assert.equal(pool.queries[0].values[0], 'evt-1');
});

test('a conflicting enqueue reports the existing job rather than creating one', async () => {
  const pool = recordingPool([
    { rows: [] },                                   // the INSERT conflicted
    { rows: [{ id: 7, samsara_event_id: 'evt-1' }] }, // …so the existing row is read
  ]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  const out = await store.enqueue({ eventId: 'evt-1', targets: [] });
  assert.equal(out.created, false);
  assert.equal(out.job.id, 7);
});

test('claiming is exclusive and reclaims a stale lock', async () => {
  const pool = recordingPool([{ rows: [] }]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  const now = new Date('2026-05-29T15:00:00.000Z');
  await store.claimDueJobs({ limit: 3, now });

  const { text, values } = pool.queries[0];
  assert.match(text, /FOR UPDATE SKIP LOCKED/);
  assert.match(text, /SET locked_at = \$2/);
  assert.match(text, /locked_at IS NULL OR locked_at < \$3/);
  assert.equal(values[0], 3);
  assert.deepEqual(values[1], now);
  assert.ok(values[2] < now, 'the stale-lock horizon is in the past');
});

test('rescheduling counts the attempt and never clears a retrieval id it was not given', async () => {
  const pool = recordingPool([{ rows: [{ id: 1 }] }]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  await store.reschedule(1, { status: 'pending_retrieval', nextCheckAt: new Date(), lastError: 'boom' });

  const { text } = pool.queries[0];
  assert.match(text, /attempts = attempts \+ 1/);
  assert.match(text, /retrieval_id = COALESCE\(\$5, retrieval_id\)/);
  assert.match(text, /targets = COALESCE\(\$9::jsonb, targets\)/, 'targets are untouched unless given');
  assert.match(text, /locked_at = NULL/, 'the claim is released');
});

test('"we asked" is recorded even when Samsara named no retrieval', async () => {
  // The guard against a second request for the same footage is
  // `retrieval_requested_at`, NOT the id: a request accepted without one, or
  // one whose outcome is unknown, must stop the worker asking again just as
  // firmly.
  const pool = recordingPool([{ rows: [{ id: 1 }] }]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  await store.reschedule(1, {
    status: 'pending_retrieval', nextCheckAt: new Date(), retrievalRequested: true,
  });

  const { text, values } = pool.queries[0];
  assert.match(text, /WHEN \$5 IS NOT NULL OR \$8 THEN COALESCE\(retrieval_requested_at, NOW\(\)\)/);
  assert.equal(values[4], null, 'no retrieval id…');
  assert.equal(values[7], true, '…but the ask is still on the record');
});

test('a terminal state and the delivered targets land in ONE statement', async () => {
  // They must not be able to land separately: a status written without the
  // cleared targets is a job that re-sends every video when its claim goes
  // stale, and cleared targets without the status is a job that finishes twice.
  const pool = recordingPool([{ rows: [{ id: 1 }] }]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  await store.finish(1, { status: 'completed', targets: [] });

  assert.equal(pool.queries.length, 1, 'one UPDATE, not two');
  const { text, values } = pool.queries[0];
  assert.match(text, /SET status = \$2/);
  assert.match(text, /targets = COALESCE\(\$4::jsonb, targets\)/);
  assert.equal(values[3], '[]');
});

test('a failed terminal write returns null, so the caller cannot mistake it for success', async () => {
  const pool = recordingPool([new Error('connection terminated')]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  assert.equal(await store.finish(1, { status: 'completed', targets: [] }), null);
});

test('a long error is trimmed to something the column and a human can hold', async () => {
  const pool = recordingPool([{ rows: [{ id: 1 }] }]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  await store.finish(1, { status: 'failed', lastError: new Error('x'.repeat(2000)) });
  assert.equal(pool.queries[0].values[2].length, 500);
});

test('a database failure is swallowed — recovery bookkeeping never breaks delivery', async () => {
  const pool = recordingPool([new Error('connection terminated')]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  assert.deepEqual(await store.enqueue({ eventId: 'evt-1', targets: [] }), { created: false, job: null });
});

test('with no pool at all the store is inert rather than throwing', async () => {
  const store = createVideoRecoveryStore({ pool: null, log: silentLog });
  assert.equal(await store.ensureSchema(), false);
  assert.deepEqual(await store.claimDueJobs(), []);
  assert.deepEqual(await store.enqueue({ eventId: 'e', targets: [] }), { created: false, job: null });
});

test('the mirrored DDL matches what the worker relies on', () => {
  assert.match(_sql.CREATE_TABLE_SQL, /samsara_event_id TEXT NOT NULL UNIQUE/);
  assert.match(_sql.CREATE_TABLE_SQL, /CHECK \(status IN \('pending_recheck','pending_retrieval','video_available','completed','no_video','failed'\)\)/);
  assert.ok(
    _sql.CREATE_INDEXES_SQL.some((sql) => /next_check_at/.test(sql)),
    'the worker only ever asks "what is due now?" — that must be indexed',
  );
});

// ── what comes back over the wire (Supabase egress) ──────────────────────────

const SRC = path.join(__dirname, '..', 'src');

/** Every `job.<field>` src/videoRecoveryWorker.js reads, from its own source. */
function fieldsTheWorkerReads() {
  const source = fs.readFileSync(path.join(SRC, 'videoRecoveryWorker.js'), 'utf8');
  return [...new Set([...source.matchAll(/\bjob\.([a-z_]+)/g)].map((m) => m[1]))].sort();
}

function returnedColumns(sql) {
  return sql.match(/RETURNING\s+([\s\S]+?)\s*$/)[1].split(',').map((c) => c.trim()).sort();
}

test('the claim returns exactly the fields the worker reads — never RETURNING *', async () => {
  // It runs every 30 s and is almost always empty, yet `RETURNING *` still sent
  // a description of all nineteen columns every time.
  const pool = recordingPool([{ rows: [] }]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });
  await store.claimDueJobs({ limit: 3, now: new Date('2026-10-09T12:00:00.000Z') });
  const { text } = pool.queries[0];

  assert.doesNotMatch(text, /RETURNING\s+\*/);
  const returned = returnedColumns(text);
  const read = fieldsTheWorkerReads();
  assert.deepEqual(read.filter((f) => !returned.includes(f)), [],
    'a field the worker reads but the claim omits is undefined there — a lost retrieval id '
    + 'or retrieval_requested_at is a second Samsara retrieval request for the same footage');
  assert.deepEqual(returned, read, 'and nothing the worker never reads');
});

test('every other statement sends back only the id its caller checks', async () => {
  const pool = recordingPool([
    { rows: [{ id: '1' }] }, // reschedule
    { rows: [{ id: '1' }] }, // finish
    { rows: [{ id: '2' }] }, // enqueue, new
    { rows: [] }, //            enqueue, conflicting…
    { rows: [{ id: '2' }] }, // …so the existing job is looked up
  ]);
  const store = createVideoRecoveryStore({ pool, log: silentLog });

  assert.ok(await store.reschedule(1, { status: 'pending_recheck', nextCheckAt: new Date() }));
  assert.ok(await store.finish(1, { status: 'completed', targets: [] }),
    'a recorded terminal state is still told apart from a missing row');
  assert.equal((await store.enqueue({ eventId: 'evt-2', targets: [] })).created, true);
  assert.deepEqual(await store.enqueue({ eventId: 'evt-2', targets: [] }), { created: false, job: { id: '2' } });

  const returning = pool.queries.filter((q) => /RETURNING/.test(q.text));
  assert.deepEqual(returning.map((q) => returnedColumns(q.text)), [['id'], ['id'], ['id'], ['id']],
    'echoing raw_event and targets back after every step was pure egress');
  assert.match(pool.queries[4].text, /^SELECT id FROM samsara_video_recovery_jobs/);
});

test('no statement in the recovery store asks for every column', () => {
  // Comments may say why `RETURNING *` went; only the code is checked.
  const code = fs.readFileSync(path.join(SRC, 'videoRecoveryStore.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /RETURNING\s+\*/);
  assert.doesNotMatch(code, /SELECT\s+\*/);
});
