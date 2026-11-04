'use strict';

/**
 * Read this service's app secrets and print them as JSON on stdout.
 *
 *   node src/appSecrets/fetch.js
 *
 * Since November 2026 the deployment's settings are stored in the hub's
 * database, encrypted, and managed in the hub's Settings → Secrets (see the
 * hub's docs/architecture/app-secrets.md). Coolify keeps only DATABASE_URL and
 * INTEGRATION_SECRET_KEY. This is the read — the twin of the hub's
 * config/appSecretsFetch.js — run by ./boot.js as a short child process,
 * because the values must be in process.env before index.js reads its first
 * setting and a database read is asynchronous.
 *
 * Reads the newest version (or APP_SECRETS_VERSION), scopes 'both' then
 * 'samsara', opens each value with INTEGRATION_SECRET_KEY ONLY — never the key
 * derived from DATABASE_URL — and prints one line:
 *   {"status":"loaded","version":12,"digest":"…","values":{...}}
 *   {"status":"skipped","reason":"..."}     nothing to apply
 *   {"status":"failed","reason":"..."}      could not read what is there
 * A reason never contains a value.
 */
const { Client } = require('pg');
const sharedCrypto = require('../sharedIntegrationCrypto');
const { SCOPES, digestRows } = require('./digest');

const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 10_000;

async function fetchAppSecrets(env = process.env, ClientImpl = Client) {
  const url = String(env.DATABASE_URL || '').trim();
  const key = String(env.INTEGRATION_SECRET_KEY || '').trim();
  if (!url) return { status: 'skipped', reason: 'DATABASE_URL is not set' };
  if (!key) return { status: 'skipped', reason: 'INTEGRATION_SECRET_KEY is not set' };

  const pinnedRaw = String(env.APP_SECRETS_VERSION || '').trim();
  if (pinnedRaw && !/^\d+$/.test(pinnedRaw)) {
    return { status: 'failed', reason: 'APP_SECRETS_VERSION must be a version number' };
  }
  const keyEnv = { INTEGRATION_SECRET_KEY: key };

  const client = new ClientImpl({
    connectionString: url,
    // The same TLS setting as this service's pool (src/db.js): always on.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
    let version;
    try {
      const res = await client.query(
        `SELECT id, key_fingerprint FROM app_secret_versions
          WHERE ($1::bigint IS NULL OR id = $1::bigint)
          ORDER BY id DESC LIMIT 1`,
        [pinnedRaw || null],
      );
      version = res.rows[0];
    } catch (err) {
      if (err && err.code === '42P01') return { status: 'skipped', reason: 'the secrets table does not exist yet' };
      throw err;
    }
    if (!version) {
      return pinnedRaw
        ? { status: 'failed', reason: `version ${pinnedRaw} does not exist` }
        : { status: 'skipped', reason: 'nothing is stored yet' };
    }
    if (version.key_fingerprint !== sharedCrypto.fingerprint(keyEnv)) {
      return { status: 'failed', reason: `version ${version.id} was stored under a different INTEGRATION_SECRET_KEY` };
    }

    const rows = (await client.query(
      'SELECT scope, name, ciphertext FROM app_secret_values WHERE version_id = $1 AND scope = ANY($2::text[])',
      [version.id, SCOPES],
    )).rows;

    const values = {};
    const unreadable = [];
    for (const scope of SCOPES) {
      for (const row of rows) {
        if (row.scope !== scope) continue;
        try {
          values[row.name] = sharedCrypto.decryptShared(row.ciphertext, keyEnv);
        } catch {
          unreadable.push(row.name);
        }
      }
    }
    if (unreadable.length) {
      return { status: 'failed', reason: `could not open ${unreadable.join(', ')} in version ${version.id}` };
    }
    return { status: 'loaded', version: Number(version.id), digest: digestRows(rows), values };
  } catch (err) {
    return { status: 'failed', reason: `database read failed${err && err.code ? ` (${err.code})` : ''}` };
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  fetchAppSecrets()
    .then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
    .catch(() => process.stdout.write(`${JSON.stringify({ status: 'failed', reason: 'unexpected error' })}\n`));
}

module.exports = { fetchAppSecrets };
