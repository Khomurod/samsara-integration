/**
 * samsaraSettings.js
 *
 * WHERE THIS SERVICE'S OPERATIONAL SETTINGS COME FROM.
 *
 * The admin/hub (`bot-backend`) writes one row — `samsara_settings` id = 1 —
 * over the database both services already share, and this module reads it. That
 * is what lets an operator replace the Samsara API key, turn missing-video
 * recovery off, or move the initial re-check delay from the admin panel instead
 * of redeploying this Render service.
 *
 * THE ENVIRONMENT IS STILL THE FALLBACK, PER VALUE. An empty column means
 * "keep using the environment variable", so the SAMSARA_API_KEY currently
 * deployed keeps working with nothing entered and nothing migrated. Only a
 * saved value overrides it. If the table does not exist, the database is
 * unreachable, or the key cannot be decrypted, every value falls back and the
 * service runs exactly as it did before — a settings problem must never stop
 * safety-event monitoring.
 *
 * The row is cached briefly: it is read on the polling path, and a change
 * should still land within about a minute.
 */

const { safeDecryptShared, fingerprint, isAvailable } = require('./sharedIntegrationCrypto');

const CACHE_TTL_MS = 30_000;
const DEFAULT_API_BASE = 'https://api.samsara.com';

/**
 * Shipped defaults. These must match bot-backend/database/samsaraSettings.js —
 * they are what a deployment gets before anyone opens the admin panel.
 */
const DEFAULTS = {
  enabled: true,
  speedingEventsEnabled: true,
  maxVideoMegabytes: 25,
  videoRecoveryEnabled: true,
  videoRecoveryInitialDelaySeconds: 300,
  videoRetrievalEnabled: true,
  videoRecoveryRetryIntervalSeconds: 300,
  videoRecoveryMaxAttempts: 12,
  videoRetrievalWindowBeforeSeconds: 15,
  videoRetrievalWindowAfterSeconds: 45,
};

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== 'false';
}

/**
 * The environment's veto on missing-video recovery.
 *
 * Read synchronously and separately from `load()` because the alert path
 * decides whether to attach a recovery descriptor while formatting, before it
 * can await anything. It is a VETO, not the setting: `false` here disables
 * recovery whatever the admin panel says, which is how a deployment that turned
 * it off stays off.
 */
function isVideoRecoveryEnabledInEnv() {
  return process.env.SAMSARA_VIDEO_RETRY_ENABLED !== 'false';
}

// The shipped initial delay, and a floor so a mis-set value cannot become a
// tight loop. There is deliberately NO ceiling: the old 30s…180s clamp silently
// overrode the operator's chosen delay, so an admin-set 5 minutes could only
// ever be 3. The wait is durable now, so a long one costs nothing.
const DEFAULT_INITIAL_DELAY_MS = 300_000;
const MIN_INITIAL_DELAY_MS = 5_000;

/** The environment's initial re-check delay, in ms. The database wins over it. */
function envInitialDelayMs() {
  const parsed = parseInt(process.env.SAMSARA_VIDEO_RETRY_DELAY_MS || String(DEFAULT_INITIAL_DELAY_MS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_INITIAL_DELAY_MS;
  return Math.max(MIN_INITIAL_DELAY_MS, parsed);
}

function intOr(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * What this service uses when the database says nothing. Deliberately built
 * from the SAME environment variables the service has always read, so removing
 * the row changes nothing.
 */
function envConfig() {
  return {
    enabled: true,
    apiKey: process.env.SAMSARA_API_KEY || '',
    apiKeySource: process.env.SAMSARA_API_KEY ? 'environment' : 'none',
    apiBase: (process.env.SAMSARA_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, ''),
    speedingEventsEnabled: envBool('SAMSARA_SPEEDING_ENABLED', DEFAULTS.speedingEventsEnabled),
    maxVideoMegabytes: (() => {
      const bytes = intOr(process.env.SAMSARA_MAX_VIDEO_BYTES, 0);
      return bytes > 0 ? Math.max(1, Math.round(bytes / (1024 * 1024))) : DEFAULTS.maxVideoMegabytes;
    })(),
    videoRecoveryEnabled: isVideoRecoveryEnabledInEnv(),
    videoRecoveryInitialDelaySeconds: Math.round(envInitialDelayMs() / 1000),
    videoRetrievalEnabled: DEFAULTS.videoRetrievalEnabled,
    videoRecoveryRetryIntervalSeconds: DEFAULTS.videoRecoveryRetryIntervalSeconds,
    videoRecoveryMaxAttempts: DEFAULTS.videoRecoveryMaxAttempts,
    videoRetrievalWindowBeforeSeconds: DEFAULTS.videoRetrievalWindowBeforeSeconds,
    videoRetrievalWindowAfterSeconds: DEFAULTS.videoRetrievalWindowAfterSeconds,
    source: 'environment',
  };
}

/**
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool  shared pool (db.getPgPool())
 * @param {Console} [opts.log]
 */
function createSamsaraSettingsStore({ pool, log = console } = {}) {
  let cache = null;
  let cacheExpiresAt = 0;
  let warnedUnreadableKey = false;
  let warnedNoTable = false;

  function clearCache() {
    cache = null;
    cacheExpiresAt = 0;
  }

  /** NULL is "not saved in the panel" and inherits; only a real boolean overrides. */
  function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  /**
   * NULL IS MEANINGFUL IN EVERY OPERATIONAL COLUMN: "nothing saved — inherit
   * the environment variable this service has always read". That is what lets
   * the settings row exist from the moment the migration runs without changing
   * a single thing about a running deployment.
   */
  function mapRow(row) {
    const env = envConfig();
    const storedKey = row.api_key_encrypted ? safeDecryptShared(row.api_key_encrypted) : '';

    if (row.api_key_encrypted && !storedKey && !warnedUnreadableKey) {
      warnedUnreadableKey = true;
      // NEVER the key, never the ciphertext — only which key material was
      // expected, so the mismatch is diagnosable from the log alone.
      log.warn?.(
        '[SamsaraSettings] A Samsara API key is saved in the admin panel but this service '
        + `cannot decrypt it (it was written under key ${row.api_key_fingerprint || 'unknown'}, `
        + `this service derives ${fingerprint() || 'none'}). Falling back to SAMSARA_API_KEY. `
        + 'Re-save the key in Settings → Samsara, or set the same INTEGRATION_SECRET_KEY on both services.'
      );
    }

    return {
      enabled: row.enabled !== false,
      apiKey: storedKey || env.apiKey,
      apiKeySource: storedKey ? 'database' : env.apiKeySource,
      apiBase: (row.api_base || env.apiBase).replace(/\/+$/, ''),
      speedingEventsEnabled: bool(row.speeding_events_enabled, env.speedingEventsEnabled),
      maxVideoMegabytes: intOr(row.max_video_megabytes, env.maxVideoMegabytes),
      videoRecoveryEnabled: bool(row.video_recovery_enabled, env.videoRecoveryEnabled),
      videoRecoveryInitialDelaySeconds: intOr(
        row.video_recovery_initial_delay_seconds, env.videoRecoveryInitialDelaySeconds
      ),
      videoRetrievalEnabled: bool(row.video_retrieval_enabled, env.videoRetrievalEnabled),
      videoRecoveryRetryIntervalSeconds: intOr(
        row.video_recovery_retry_interval_seconds, env.videoRecoveryRetryIntervalSeconds
      ),
      videoRecoveryMaxAttempts: intOr(row.video_recovery_max_attempts, env.videoRecoveryMaxAttempts),
      videoRetrievalWindowBeforeSeconds: intOr(
        row.video_retrieval_window_before_seconds, env.videoRetrievalWindowBeforeSeconds
      ),
      videoRetrievalWindowAfterSeconds: intOr(
        row.video_retrieval_window_after_seconds, env.videoRetrievalWindowAfterSeconds
      ),
      source: 'database',
    };
  }

  /**
   * The effective settings. NEVER throws and never returns nothing: any problem
   * degrades to the environment configuration this service has always used.
   */
  async function load({ now = Date.now() } = {}) {
    if (cache && now < cacheExpiresAt) return cache;
    let effective;
    if (!pool) {
      effective = envConfig();
    } else {
      try {
        const res = await pool.query('SELECT * FROM samsara_settings WHERE id = 1');
        effective = res.rows[0] ? mapRow(res.rows[0]) : envConfig();
      } catch (err) {
        if (!warnedNoTable) {
          warnedNoTable = true;
          log.warn?.(`[SamsaraSettings] Cannot read samsara_settings (${err.message}); using environment configuration.`);
        }
        effective = envConfig();
      }
    }
    cache = effective;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return effective;
  }

  /** A one-line, secret-free readiness summary for the startup log. */
  async function describe() {
    const cfg = await load();
    return `source=${cfg.source} key=${cfg.apiKey ? cfg.apiKeySource : 'MISSING'} `
      + `recovery=${cfg.videoRecoveryEnabled ? 'on' : 'off'} `
      + `initialDelay=${cfg.videoRecoveryInitialDelaySeconds}s `
      + `retrieval=${cfg.videoRetrievalEnabled ? 'on' : 'off'} `
      + `maxAttempts=${cfg.videoRecoveryMaxAttempts} `
      + `sharedSecret=${isAvailable() ? 'available' : 'unavailable'}`;
  }

  return { load, describe, clearCache };
}

/**
 * The ONE store the running process shares.
 *
 * The pollers, the downloader and the recovery worker all ask the same
 * instance, so they see the same values and one cache refresh serves all of
 * them — rather than each opening its own and drifting for up to a TTL.
 * Created lazily so requiring this module never touches the database.
 */
let defaultStore = null;
function getSamsaraSettingsStore() {
  if (!defaultStore) {
    // Required lazily: src/db.js is what owns the shared pool, and requiring it
    // at module load would make this file's own require order matter.
    const db = require('./db');
    defaultStore = createSamsaraSettingsStore({ pool: db.getPgPool(), log: console });
  }
  return defaultStore;
}

/** Shorthand for the common case. Never throws — see the store's `load`. */
function loadSamsaraConfig() {
  return getSamsaraSettingsStore().load();
}

module.exports = {
  DEFAULTS,
  DEFAULT_API_BASE,
  DEFAULT_INITIAL_DELAY_MS,
  MIN_INITIAL_DELAY_MS,
  isVideoRecoveryEnabledInEnv,
  envInitialDelayMs,
  envConfig,
  createSamsaraSettingsStore,
  getSamsaraSettingsStore,
  loadSamsaraConfig,
};
