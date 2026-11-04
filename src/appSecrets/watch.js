'use strict';

/**
 * Notice when the hub saved new values for THIS service, and restart to load
 * them.
 *
 * The hub restarts itself after a save in Settings → Secrets; this service is
 * a separate container the hub has no link to (only the shared database), so
 * it looks for itself once a minute:
 *
 *   1. the newest version's id — one tiny row; nothing else while it is the
 *      one already seen (the database is on a metered transfer allowance);
 *   2. when the id moved: this service's rows of that version, digested
 *      (./digest.js). Unchanged values keep their ciphertext, so the digest
 *      differs only when one of THIS service's values changed;
 *   3. if it differs: one log line, then the normal graceful shutdown
 *      (SIGTERM → index.js `shutdown`), and Docker starts the container again.
 *
 * It does nothing when the boot read was switched off or pinned to a version
 * (APP_SECRETS_OFF / APP_SECRETS_VERSION — a person is recovering by hand), or
 * when there is no INTEGRATION_SECRET_KEY to read with. A version written
 * under another key is ignored: it could not be opened anyway.
 */
const sharedCrypto = require('../sharedIntegrationCrypto');
const { SCOPES, digestRows } = require('./digest');

const INTERVAL_MS = 60_000;

function defaultRestart() {
  process.kill(process.pid, 'SIGTERM');
}

function createSecretsWatch({
  query,
  boot,
  env = process.env,
  intervalMs = INTERVAL_MS,
  restart = defaultRestart,
  log = console,
}) {
  const key = String(env.INTEGRATION_SECRET_KEY || '').trim();
  const reasonOff = (boot.status === 'off' && 'APP_SECRETS_OFF is set')
    || (boot.pinned && 'APP_SECRETS_VERSION is set')
    // Stored values that could not be opened at start would fail again after a
    // restart: watching would only restart it in a loop. (A database that could
    // not be reached is different — the first version read later restarts it
    // once, and that start succeeds.)
    || (boot.status === 'failed' && !boot.retryable && 'the stored settings could not be opened at start')
    || (!key && 'INTEGRATION_SECRET_KEY is not set')
    || (!String(env.DATABASE_URL || '').trim() && 'DATABASE_URL is not set')
    || null;
  const ourFingerprint = key ? sharedCrypto.fingerprint({ INTEGRATION_SECRET_KEY: key }) : null;
  const baseline = boot.status === 'loaded' && boot.digest ? boot.digest : digestRows([]);
  let lastSeen = boot.status === 'loaded' ? boot.version : null;
  let timer = null;
  let restarting = false;
  let lastError = null;

  async function check() {
    if (reasonOff || restarting) return { action: 'none' };
    let latest;
    try {
      latest = (await query('SELECT id, key_fingerprint FROM app_secret_versions ORDER BY id DESC LIMIT 1')).rows[0];
    } catch (err) {
      if (err && err.code === '42P01') return { action: 'none' };
      const code = (err && err.code) || 'error';
      if (code !== lastError) log.warn(`[Secrets] Could not check for new settings (${code}).`);
      lastError = code;
      return { action: 'error' };
    }
    if (!latest || Number(latest.id) === lastSeen) {
      lastError = null;
      return { action: 'none' };
    }
    const id = Number(latest.id);
    if (latest.key_fingerprint !== ourFingerprint) {
      lastSeen = id;
      log.warn(`[Secrets] Version ${id} was stored under a different INTEGRATION_SECRET_KEY — ignored.`);
      return { action: 'ignored', version: id };
    }
    let rows;
    try {
      rows = (await query(
        'SELECT scope, name, ciphertext FROM app_secret_values WHERE version_id = $1 AND scope = ANY($2::text[])',
        [id, SCOPES],
      )).rows;
    } catch (err) {
      // Not marked seen: the next minute asks again rather than missing the change.
      const code = (err && err.code) || 'error';
      if (code !== lastError) log.warn(`[Secrets] Could not read version ${id} (${code}).`);
      lastError = code;
      return { action: 'error', version: id };
    }
    lastError = null;
    lastSeen = id;
    if (digestRows(rows) === baseline) return { action: 'unchanged', version: id };
    restarting = true;
    log.log(`[Secrets] Version ${id} changed this service's settings — restarting to load them.`);
    restart();
    return { action: 'restart', version: id };
  }

  function start() {
    if (reasonOff) {
      log.log(`[Secrets] Not watching for new settings (${reasonOff}).`);
      return false;
    }
    timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, check };
}

module.exports = { createSecretsWatch, INTERVAL_MS };
