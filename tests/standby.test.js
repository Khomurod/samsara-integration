/**
 * Standby: up, preflight-checked, and silent.
 *
 * What a host move depends on, proven without a network or a database:
 *   · the switch reads only an explicit "on";
 *   · /health in standby is always 200 and says whether it is READY, so the
 *     host neither restarts nor unroutes the copy being inspected;
 *   · the preflight never throws: a check that throws or hangs is a failed
 *     check and the others still run;
 *   · no token ever reaches a log line or /health;
 *   · the upload probe passes when a large body gets ANY answer, and fails
 *     when the answer never comes — the IPv6 black hole it exists to catch;
 *   · the default checks only read, and say plainly what is missing.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  isStandby, scrub, runPreflight, buildStandbyHealth, probeTelegramUpload, defaultChecks, logPreflight,
} = require('../src/standby');

const TOKEN = '123456:SECRET-notification-token';

test('standby is on only for an explicit yes', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) assert.equal(isStandby({ SAMSARA_STANDBY: v }), true, v);
  for (const v of [undefined, '', 'false', '0', 'no', 'off', 'standby']) assert.equal(isStandby({ SAMSARA_STANDBY: v }), false, String(v));
});

test('scrub removes every secret and caps the length', () => {
  assert.equal(scrub(`failed /bot${TOKEN}/getMe`, [TOKEN]), 'failed /bot***/getMe');
  assert.equal(scrub('x'.repeat(1000)).length, 300);
});

test('/health in standby is always 200 and reports readiness from the preflight', () => {
  const pending = buildStandbyHealth({ preflight: null, uptimeSeconds: 3.4, now: Date.parse('2026-11-03T18:00:00Z') });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.body.mode, 'standby');
  assert.equal(pending.body.ready, null);
  assert.deepEqual(pending.body.preflight, { pending: true });

  const failed = buildStandbyHealth({ preflight: { ok: false, checks: {} } });
  assert.equal(failed.statusCode, 200, 'a failed preflight must not make the host restart the copy being inspected');
  assert.equal(failed.body.ready, false);
  assert.equal(buildStandbyHealth({ preflight: { ok: true, checks: {} } }).body.ready, true);
});

test('the preflight runs every check, isolates failures and hangs, and never throws', async () => {
  const out = await runPreflight({
    good: async () => ({ ok: true, detail: 'fine' }),
    thrown: async () => { throw new Error(`boom with ${TOKEN}`); },
    hangs: () => new Promise(() => {}),
    soft: async () => ({ ok: false, detail: 'missing' }),
    after: async () => ({ ok: true }),
  }, { secrets: [TOKEN], timeoutMs: 50 });

  assert.equal(out.ok, false);
  assert.equal(out.checks.good.ok, true);
  assert.equal(out.checks.thrown.ok, false);
  assert.equal(out.checks.thrown.detail.includes(TOKEN), false, 'no token in /health');
  assert.match(out.checks.thrown.detail, /boom with \*\*\*/);
  assert.equal(out.checks.hangs.ok, false);
  assert.match(out.checks.hangs.detail, /no answer within/);
  assert.equal(out.checks.soft.ok, false);
  assert.equal(out.checks.after.ok, true, 'a hung check does not stop the ones after it');
  assert.ok(out.checkedAt);
});

test('all checks passing makes the preflight ready', async () => {
  const out = await runPreflight({ a: async () => ({ ok: true }), b: async () => ({ ok: true }) });
  assert.equal(out.ok, true);
});

test('the preflight log has one line per check and no secrets', async () => {
  const lines = [];
  const out = await runPreflight({ db: async () => ({ ok: true, detail: 'connected' }), bot: async () => { throw new Error(TOKEN); } }, { secrets: [TOKEN] });
  logPreflight(out, { log: (m) => lines.push(m) });
  assert.match(lines[0], /FAILURES/);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !l.includes(TOKEN)));
});

// ─── upload probe ───────────────────────────────────────────────────────────

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('upload probe: a large body that gets an answer passes, and nothing is posted', async () => {
  const seen = [];
  const s = await server((req, res) => {
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, size });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"result":{"username":"wenzesambot"}}');
    });
  });
  try {
    const out = await probeTelegramUpload({ token: TOKEN, transport: http, hostname: '127.0.0.1', port: s.address().port, bytes: 64 * 1024 });
    assert.equal(out.ok, true);
    assert.match(out.detail, /HTTP 200 for a 64 KB body/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].path, `/bot${TOKEN}/getMe`, 'getMe only — never a send method');
    assert.ok(seen[0].size > 64 * 1024);
    assert.equal(out.detail.includes(TOKEN), false);
  } finally { s.close(); }
});

test('upload probe: any HTTP answer proves the bytes went through', async () => {
  const s = await server((req, res) => { req.resume(); req.on('end', () => { res.writeHead(413); res.end(); }); });
  try {
    const out = await probeTelegramUpload({ token: TOKEN, transport: http, hostname: '127.0.0.1', port: s.address().port, bytes: 1024 });
    assert.equal(out.ok, true);
    assert.match(out.detail, /HTTP 413/);
  } finally { s.close(); }
});

test('upload probe: no answer is a failure that says uploads would stall', async () => {
  const s = await server(() => { /* swallow the request, never answer */ });
  try {
    const out = await probeTelegramUpload({ token: TOKEN, transport: http, hostname: '127.0.0.1', port: s.address().port, bytes: 1024, timeoutMs: 150 });
    assert.equal(out.ok, false);
    assert.match(out.detail, /uploads would stall/);
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('upload probe: a connection error is reported without the token', async () => {
  const out = await probeTelegramUpload({ token: TOKEN, transport: http, hostname: '127.0.0.1', port: 1, bytes: 16 });
  assert.equal(out.ok, false);
  assert.equal(out.detail.includes(TOKEN), false);
});

test('upload probe without a token fails without a request', async () => {
  assert.deepEqual(await probeTelegramUpload({ token: '' }), { ok: false, detail: 'no token' });
});

// ─── default checks ─────────────────────────────────────────────────────────

function fakes(over = {}) {
  const queries = [];
  const bots = { notification: [], driver: [] };
  const botFor = (kind, name) => ({
    async getMe() { bots[kind].push('getMe'); return { username: name }; },
    async getChat(id) { bots[kind].push(`getChat:${id}`); return { title: 'Samsara Notifications' }; },
  });
  return {
    queries,
    bots,
    deps: {
      pool: { async query(sql) { queries.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [{ '?column?': 1 }] }; } },
      settingsStore: { async load() { return { source: 'database', apiKey: 'samsara-key', apiKeySource: 'database', apiBase: 'https://api.samsara.com' }; } },
      notificationBot: botFor('notification', 'wenzesambot'),
      driverBot: botFor('driver', 'wenzefeedback_bot'),
      notificationToken: TOKEN,
      forcedGroupId: '-500',
      ffmpeg: { async isAvailable() { return true; } },
      fetchImpl: async (url, opts) => { queries.push(`FETCH ${url} ${opts.headers.Authorization ? 'auth' : ''}`); return { ok: true, status: 200 }; },
      ...over,
    },
  };
}

test('default checks: every one only reads, and a full set passes', async () => {
  const f = fakes();
  const checks = defaultChecks(f.deps);
  delete checks.telegramUpload; // network; covered above
  const out = await runPreflight(checks);
  assert.equal(out.ok, true, JSON.stringify(out.checks));
  assert.ok(f.queries.every((q) => /^(SELECT|FETCH)/.test(q)), 'the database is only read');
  assert.ok(f.queries.some((q) => q.includes('samsara_driver_alerts_enabled')));
  assert.ok(f.queries.some((q) => q.startsWith('FETCH https://api.samsara.com/fleet/vehicles?limit=1 auth')));
  assert.deepEqual(f.bots.notification, ['getMe', 'getChat:-500']);
  assert.deepEqual(f.bots.driver, ['getMe']);
  assert.match(out.checks.samsaraSettings.detail, /source=database key=database/);
});

test('default checks: what is missing is said plainly', async () => {
  const f = fakes({
    pool: null,
    driverBot: null,
    settingsStore: { async load() { return { source: 'environment', apiKey: '', apiKeySource: 'none' }; } },
    ffmpeg: { async isAvailable() { return false; } },
  });
  const checks = defaultChecks(f.deps);
  delete checks.telegramUpload;
  const out = await runPreflight(checks);
  assert.equal(out.ok, false);
  assert.match(out.checks.database.detail, /DATABASE_URL is not set/);
  assert.match(out.checks.driverBot.detail, /BOT_TOKEN is not set/);
  assert.match(out.checks.samsaraSettings.detail, /key=MISSING/);
  assert.equal(out.checks.samsaraApi.ok, false);
  assert.match(out.checks.ffmpeg.detail, /without music/);
});

test('default checks: a hub without migration 0090 is reported, not hidden', async () => {
  const f = fakes({ pool: { async query(sql) { return { rows: /information_schema/.test(sql) ? [] : [{}] }; } } });
  const out = await runPreflight({ driverGroupSwitch: defaultChecks(f.deps).driverGroupSwitch });
  assert.equal(out.ok, false);
  assert.match(out.checks.driverGroupSwitch.detail, /migration 0090/);
});
