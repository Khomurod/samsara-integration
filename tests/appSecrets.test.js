'use strict';

/**
 * The app secrets on this side (src/appSecrets/*): the boot read puts the
 * stored values over Coolify's and changes nothing when it cannot read; only
 * INTEGRATION_SECRET_KEY opens a value; the watch restarts the service only
 * when ITS values changed, reads one tiny row while nothing did, and stands
 * down while a person is recovering by hand. No value is ever logged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadAppSecrets } = require('../src/appSecrets/boot');
const { fetchAppSecrets } = require('../src/appSecrets/fetch');
const { createSecretsWatch } = require('../src/appSecrets/watch');
const { digestRows } = require('../src/appSecrets/digest');
const sharedCrypto = require('../src/sharedIntegrationCrypto');

const KEY = 'samsara-side-test-key-0123456789abcdef';
const keyEnv = { INTEGRATION_SECRET_KEY: KEY };
const FP = sharedCrypto.fingerprint(keyEnv);
const enc = (v) => sharedCrypto.encryptShared(v, keyEnv);

function recorder() {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
}

// ── boot ───────────────────────────────────────────────────────────────────
test('stored values override Coolify; the log names a version, never a value', () => {
  const env = { SAMSARA_BOT_TOKEN: 'from-coolify-0000' };
  const { lines, log } = recorder();
  const state = loadAppSecrets({
    env, log, fetch: () => ({ status: 'loaded', version: 5, digest: 'd', values: { SAMSARA_BOT_TOKEN: 'from-app-1111', BOT_TOKEN: 'main-2222' } }),
  });
  assert.equal(env.SAMSARA_BOT_TOKEN, 'from-app-1111');
  assert.equal(env.BOT_TOKEN, 'main-2222');
  assert.equal(state.version, 5);
  assert.equal(state.digest, 'd');
  assert.ok(!/from-app|main-2222|from-coolify/.test(lines.join('\n')));
});

test('a failed, skipped or crashed read changes nothing; APP_SECRETS_OFF skips it', () => {
  for (const fetch of [() => ({ status: 'failed', reason: 'x' }), () => ({ status: 'skipped', reason: 'y' }), () => { throw new Error('z'); }]) {
    const env = { SAMSARA_BOT_TOKEN: 'coolify' };
    const state = loadAppSecrets({ env, fetch, log: recorder().log });
    assert.deepEqual(env, { SAMSARA_BOT_TOKEN: 'coolify' });
    assert.notEqual(state.status, 'loaded');
  }
  let called = false;
  const state = loadAppSecrets({ env: { APP_SECRETS_OFF: '1' }, fetch: () => { called = true; }, log: recorder().log });
  assert.equal(state.status, 'off');
  assert.equal(called, false);
});

test('index.js reads the secrets before anything else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const first = src.slice(src.indexOf('require('));
  assert.match(first, /^require\('\.\/src\/appSecrets\/boot'\)/);
  assert.ok(src.indexOf('bootAppSecrets()') < src.indexOf("require('express')"));
});

// ── fetch ──────────────────────────────────────────────────────────────────
function fakeClient({ version, rows = [], versionError = null }) {
  return class {
    async connect() {}
    async end() {}
    async query(sql, params) {
      if (sql.includes('FROM app_secret_versions')) {
        if (versionError) throw versionError;
        return { rows: version ? [version] : [] };
      }
      return { rows: rows.filter((r) => params[1].includes(r.scope)) };
    }
  };
}

test('the fetch reads "both" then "samsara" — never the hub\'s own values', async () => {
  const rows = [
    { scope: 'both', name: 'BOT_TOKEN', ciphertext: enc('main') },
    { scope: 'both', name: 'X', ciphertext: enc('shared') },
    { scope: 'samsara', name: 'X', ciphertext: enc('ours') },
    { scope: 'bot', name: 'TELEGRAM_BOT_TOKEN', ciphertext: enc('leads') },
  ];
  const env = { DATABASE_URL: 'postgres://u:p@localhost/db', INTEGRATION_SECRET_KEY: KEY };
  const out = await fetchAppSecrets(env, fakeClient({ version: { id: 3, key_fingerprint: FP }, rows }));
  assert.equal(out.status, 'loaded');
  assert.deepEqual(out.values, { BOT_TOKEN: 'main', X: 'ours' });
  assert.equal(out.digest, digestRows(rows));
});

test('a version under the DATABASE_URL-derived key is not opened; no key, no read', async () => {
  const env = { DATABASE_URL: 'postgres://u:p@localhost/db', INTEGRATION_SECRET_KEY: KEY };
  const derived = sharedCrypto.fingerprint({ DATABASE_URL: env.DATABASE_URL });
  const out = await fetchAppSecrets(env, fakeClient({ version: { id: 1, key_fingerprint: derived } }));
  assert.equal(out.status, 'failed');
  assert.equal((await fetchAppSecrets({ DATABASE_URL: env.DATABASE_URL })).status, 'skipped');
  const missing = Object.assign(new Error('no table'), { code: '42P01' });
  assert.equal((await fetchAppSecrets(env, fakeClient({ versionError: missing }))).status, 'skipped');
  const down = Object.assign(new Error('postgres://u:p@localhost/db refused'), { code: 'ECONNREFUSED' });
  const failed = await fetchAppSecrets(env, fakeClient({ versionError: down }));
  assert.equal(failed.status, 'failed');
  assert.ok(!failed.reason.includes('u:p@'));
});

// ── watch ──────────────────────────────────────────────────────────────────
function db({ latest, rows = [] }) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push(sql.includes('app_secret_values') ? 'values' : 'version');
    if (sql.includes('app_secret_versions')) return { rows: latest ? [latest()] : [] };
    return { rows: rows.filter((r) => params[1].includes(r.scope)) };
  };
  return { query, calls };
}

const ENV = { DATABASE_URL: 'postgres://x', INTEGRATION_SECRET_KEY: KEY };
const ours = [{ scope: 'samsara', name: 'SAMSARA_BOT_TOKEN', ciphertext: 'c1' }, { scope: 'both', name: 'BOT_TOKEN', ciphertext: 'c2' }];

test('nothing new: one tiny row a minute, no restart', async () => {
  const d = db({ latest: () => ({ id: 4, key_fingerprint: FP }), rows: ours });
  let restarts = 0;
  const w = createSecretsWatch({ query: d.query, env: ENV, boot: { status: 'loaded', version: 4, digest: digestRows(ours) }, restart: () => { restarts += 1; }, log: recorder().log });
  assert.deepEqual(await w.check(), { action: 'none' });
  assert.deepEqual(await w.check(), { action: 'none' });
  assert.deepEqual(d.calls, ['version', 'version']);
  assert.equal(restarts, 0);
});

test('a new version that changed only the hub\'s values does not restart', async () => {
  const rows = [...ours, { scope: 'bot', name: 'JWT_SECRET', ciphertext: 'changed' }];
  const d = db({ latest: () => ({ id: 5, key_fingerprint: FP }), rows });
  let restarts = 0;
  const w = createSecretsWatch({ query: d.query, env: ENV, boot: { status: 'loaded', version: 4, digest: digestRows(ours) }, restart: () => { restarts += 1; }, log: recorder().log });
  assert.deepEqual(await w.check(), { action: 'unchanged', version: 5 });
  assert.deepEqual(await w.check(), { action: 'none' });
  assert.equal(restarts, 0);
});

test('a new version that changed this service\'s values restarts it, once', async () => {
  const changed = [{ scope: 'samsara', name: 'SAMSARA_BOT_TOKEN', ciphertext: 'c9' }, ours[1]];
  const d = db({ latest: () => ({ id: 6, key_fingerprint: FP }), rows: changed });
  let restarts = 0;
  const { lines, log } = recorder();
  const w = createSecretsWatch({ query: d.query, env: ENV, boot: { status: 'loaded', version: 4, digest: digestRows(ours) }, restart: () => { restarts += 1; }, log });
  assert.deepEqual(await w.check(), { action: 'restart', version: 6 });
  assert.deepEqual(await w.check(), { action: 'none' });
  assert.equal(restarts, 1);
  assert.match(lines.join('\n'), /Version 6 changed this service's settings/);
});

test('values stored for the first time after a start without any restart it', async () => {
  const d = db({ latest: () => ({ id: 1, key_fingerprint: FP }), rows: ours });
  let restarts = 0;
  const w = createSecretsWatch({ query: d.query, env: ENV, boot: { status: 'skipped' }, restart: () => { restarts += 1; }, log: recorder().log });
  assert.equal((await w.check()).action, 'restart');
  assert.equal(restarts, 1);
  // …but a first version holding only the hub's values does not.
  const hubOnly = db({ latest: () => ({ id: 1, key_fingerprint: FP }), rows: [{ scope: 'bot', name: 'JWT_SECRET', ciphertext: 'j' }] });
  const w2 = createSecretsWatch({ query: hubOnly.query, env: ENV, boot: { status: 'skipped' }, restart: () => { restarts += 1; }, log: recorder().log });
  assert.equal((await w2.check()).action, 'unchanged');
  assert.equal(restarts, 1);
});

test('a version under another key is ignored; a person recovering by hand switches the watch off', async () => {
  const d = db({ latest: () => ({ id: 7, key_fingerprint: 'other' }), rows: ours });
  let restarts = 0;
  const w = createSecretsWatch({ query: d.query, env: ENV, boot: { status: 'loaded', version: 4, digest: 'x' }, restart: () => { restarts += 1; }, log: recorder().log });
  assert.equal((await w.check()).action, 'ignored');
  assert.equal(restarts, 0);
  for (const [boot, env] of [
    [{ status: 'off' }, ENV],
    [{ status: 'loaded', version: 2, pinned: true }, ENV],
    [{ status: 'skipped' }, { DATABASE_URL: 'postgres://x' }],
  ]) {
    const off = createSecretsWatch({ query: d.query, env, boot, restart: () => { restarts += 1; }, log: recorder().log });
    assert.equal(off.start(), false);
    assert.deepEqual(await off.check(), { action: 'none' });
  }
  assert.equal(restarts, 0);
});

test('a database hiccup is logged once by code and does not restart', async () => {
  let restarts = 0;
  const { lines, log } = recorder();
  const err = Object.assign(new Error('postgres://secret@host down'), { code: 'ECONNRESET' });
  const w = createSecretsWatch({ query: async () => { throw err; }, env: ENV, boot: { status: 'loaded', version: 1, digest: 'x' }, restart: () => { restarts += 1; }, log });
  assert.equal((await w.check()).action, 'error');
  assert.equal((await w.check()).action, 'error');
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('secret@host'));
  assert.equal(restarts, 0);
});
