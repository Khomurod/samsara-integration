'use strict';

/**
 * Put this service's app secrets into process.env — the FIRST thing index.js
 * does, before it reads any setting. The twin of the hub's
 * config/appSecretsBoot.js; the rules are the hub's
 * docs/architecture/app-secrets.md:
 *
 *   - a stored value OVERRIDES the same name in Coolify;
 *   - anything that goes wrong leaves process.env exactly as Coolify set it,
 *     with one log line saying why;
 *   - APP_SECRETS_OFF=true skips the read; APP_SECRETS_VERSION=<id> loads that
 *     older version (the way back when a saved version breaks the start);
 *   - no value is ever logged — names and a version number are.
 *
 * The read runs in a child process (./fetch.js) that is waited for: the
 * database read is asynchronous and this must not be.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const FETCH_TIMEOUT_MS = 40_000;

const state = { status: 'not-run', reason: null, version: null, digest: null, names: [], pinned: false };

function isOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function runFetch(env) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'fetch.js')], {
    env,
    encoding: 'utf8',
    timeout: FETCH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return JSON.parse(String(out || '').trim().split('\n').pop());
}

function loadAppSecrets({ env = process.env, fetch = runFetch, log = console } = {}) {
  const pinned = Boolean(String(env.APP_SECRETS_VERSION || '').trim());
  if (isOn(env.APP_SECRETS_OFF)) {
    Object.assign(state, { status: 'off', reason: 'APP_SECRETS_OFF is set in Coolify', pinned });
    log.warn('[Secrets] APP_SECRETS_OFF is set — using only the Coolify environment.');
    return state;
  }

  let result;
  try {
    result = fetch(env);
  } catch (err) {
    result = { status: 'failed', reason: err && err.code === 'ETIMEDOUT' ? 'the read timed out' : 'the read could not run' };
  }

  if (!result || result.status !== 'loaded') {
    const status = result && result.status === 'skipped' ? 'skipped' : 'failed';
    const reason = (result && result.reason) || 'no answer';
    Object.assign(state, { status, reason, version: null, digest: null, names: [], pinned });
    (status === 'skipped' ? log.log : log.error).call(log, `[Secrets] Not loaded from the app (${reason}) — using the Coolify environment.`);
    return state;
  }

  const names = Object.keys(result.values).sort();
  const overridden = names.filter((name) => env[name] !== undefined && env[name] !== result.values[name]);
  for (const name of names) env[name] = result.values[name];
  Object.assign(state, { status: 'loaded', reason: null, version: result.version, digest: result.digest || null, names, pinned });
  log.log(
    `[Secrets] Loaded ${names.length} setting(s) from the app (version ${result.version}${pinned ? ', pinned by APP_SECRETS_VERSION' : ''})`
    + `${overridden.length ? `; overriding Coolify for ${overridden.join(', ')}` : ''}.`,
  );
  return state;
}

/** index.js's first line: a local .env (development) first, then the stored values over it. */
function bootAppSecrets() {
  require('dotenv').config();
  return loadAppSecrets();
}

function getBootState() {
  return { ...state, names: [...state.names] };
}

module.exports = { bootAppSecrets, loadAppSecrets, getBootState };
