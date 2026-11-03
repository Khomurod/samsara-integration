/**
 * standby.js
 *
 * STANDBY: the service is up, and does nothing anyone can see.
 *
 * Moving this service to another host must never mean two copies working at
 * once. Two processes polling one bot token is Telegram's 409 Conflict, and two
 * pollers on one Samsara account can post the same alert twice. So the new host
 * starts with SAMSARA_STANDBY=true:
 *
 *   - no Telegram polling (getUpdates is never called) and no webhook change;
 *   - no Samsara polling, no deliveries, no video recovery, and no heartbeat to
 *     the hub — the hub keeps hearing only from the copy that is live;
 *   - no schema setup: the shared database is only read, and a webhook update
 *     is acknowledged and dropped (index.js);
 *   - instead, a PREFLIGHT: every dependency the live service needs is tried
 *     once, read-only, and the answers are on /health and in the log.
 *
 * Going live is SAMSARA_STANDBY=false and a restart, AFTER the old host has
 * stopped. docs/deployment/coolify.md is the runbook.
 *
 * Nothing in the preflight posts anything. Telegram is asked getMe and getChat.
 * The upload path is proven by sending a large request body to getMe, which
 * Telegram answers without posting anywhere — the IPv6 black hole this host is
 * known for shows up as no answer at all. Samsara is asked for one vehicle, and
 * the database for `SELECT 1` and one column.
 */
const https = require('https');

const DEFAULT_CHECK_TIMEOUT_MS = 30_000;
const UPLOAD_PROBE_BYTES = 256 * 1024;

/** SAMSARA_STANDBY=true|1|yes|on turns standby on; anything else is live. */
function isStandby(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.SAMSARA_STANDBY || '').trim());
}

/** Remove every secret from a message before it reaches a log or /health. */
function scrub(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (secret) out = out.split(String(secret)).join('***');
  }
  return out.slice(0, 300);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: no answer within ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run every check once. NEVER throws: a check that throws or hangs is a failed
 * check, and the others still run.
 *
 * @param {Record<string, () => Promise<{ok: boolean, detail?: string}>>} checks
 * @returns {Promise<{ok: boolean, checkedAt: string, checks: Record<string, {ok: boolean, detail: string, ms: number}>}>}
 */
async function runPreflight(checks, { secrets = [], timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const results = {};
  for (const [name, check] of Object.entries(checks)) {
    const started = now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await withTimeout(Promise.resolve().then(check), timeoutMs, name);
      results[name] = { ok: out?.ok === true, detail: scrub(out?.detail || '', secrets), ms: now() - started };
    } catch (err) {
      results[name] = { ok: false, detail: scrub(err?.message || err, secrets), ms: now() - started };
    }
  }
  return {
    ok: Object.values(results).every((r) => r.ok),
    checkedAt: new Date(now()).toISOString(),
    checks: results,
  };
}

/**
 * /health while in standby. ALWAYS 200: the process is up and idle on purpose,
 * and a 503 would make the host restart or unroute the very copy we are trying
 * to inspect. Whether it is READY to go live is `ready`, with every check's
 * answer beside it.
 */
function buildStandbyHealth({ preflight = null, uptimeSeconds = 0, now = Date.now() } = {}) {
  return {
    statusCode: 200,
    body: {
      status: 'standby',
      mode: 'standby',
      healthy: true,
      ready: preflight ? preflight.ok === true : null,
      note: 'Standby: not polling Samsara or Telegram, not posting anything. '
        + 'Set SAMSARA_STANDBY=false and restart once the old host has stopped.',
      uptime: Math.round(uptimeSeconds),
      timestamp: new Date(now).toISOString(),
      preflight: preflight || { pending: true },
    },
  };
}

/**
 * Prove a LARGE request body reaches Telegram and an answer comes back — the
 * exact thing an IPv6 black hole breaks — without posting anything: the body
 * goes to getMe, which ignores it.
 *
 * Passes only when the whole body was handed to the network AND Telegram
 * answered `200 {"ok":true}` after it: getMe parses the request before it
 * answers, so that answer means the bytes arrived. Anything else proves
 * nothing about the upload path and fails, saying why — an answer that came
 * before the body finished (a refusal from the headers), a 401 for the token,
 * or silence until the timeout (the black hole itself).
 */
function probeTelegramUpload({
  token,
  agent,
  bytes = UPLOAD_PROBE_BYTES,
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  transport = https,
  hostname = 'api.telegram.org',
  port,
  now = () => Date.now(),
} = {}) {
  return new Promise((resolve) => {
    if (!token) {
      resolve({ ok: false, detail: 'no token' });
      return;
    }
    const kb = Math.round(bytes / 1024);
    const body = Buffer.from(JSON.stringify({ padding: 'x'.repeat(bytes) }));
    const started = now();
    let bodySent = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = transport.request({
      hostname,
      port,
      agent,
      method: 'POST',
      path: `/bot${token}/getMe`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: timeoutMs,
    }, (res) => {
      const answeredBeforeBody = !bodySent;
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
      res.on('end', () => {
        let okJson = false;
        try { okJson = JSON.parse(Buffer.concat(chunks).toString('utf8')).ok === true; } catch (_) { okJson = false; }
        if (answeredBeforeBody) {
          finish({ ok: false, detail: `inconclusive: HTTP ${res.statusCode} came before the ${kb} KB body was sent` });
        } else if (res.statusCode === 200 && okJson) {
          finish({ ok: true, detail: `a ${kb} KB body reached Telegram, answered 200 ok in ${now() - started} ms` });
        } else {
          finish({ ok: false, detail: `inconclusive: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (token rejected)' : ''} after the ${kb} KB body` });
        }
      });
      res.on('error', (err) => finish({ ok: false, detail: scrub(err.code || err.message, [token]) }));
    });
    req.on('finish', () => { bodySent = true; });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, detail: `no answer within ${Math.round(timeoutMs / 1000)}s for a ${kb} KB body — uploads would stall` });
    });
    req.on('error', (err) => finish({ ok: false, detail: scrub(err.code || err.message, [token]) }));
    req.end(body);
  });
}

/**
 * The checks the live service depends on, built from the real collaborators.
 * Every one of them only reads.
 */
function defaultChecks({
  pool,
  settingsStore,
  notificationBot,
  driverBot,
  notificationToken,
  forcedGroupId,
  ffmpeg,
  agent,
  subscribers = null,
  fetchImpl = fetch,
}) {
  return {
    database: async () => {
      if (!pool) return { ok: false, detail: 'DATABASE_URL is not set' };
      await pool.query('SELECT 1');
      return { ok: true, detail: 'connected' };
    },
    driverGroupSwitch: async () => {
      if (!pool) return { ok: false, detail: 'no database' };
      const res = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'groups' AND column_name = 'samsara_driver_alerts_enabled'`,
      );
      return res.rows.length
        ? { ok: true, detail: 'groups.samsara_driver_alerts_enabled present' }
        : { ok: false, detail: 'column missing (bot-backend migration 0090 not run) — every group would read as ON' };
    },
    samsaraSettings: async () => {
      const cfg = await settingsStore.load();
      return cfg.apiKey
        ? { ok: true, detail: `source=${cfg.source} key=${cfg.apiKeySource}` }
        : { ok: false, detail: `source=${cfg.source} key=MISSING` };
    },
    samsaraApi: async () => {
      const cfg = await settingsStore.load();
      if (!cfg.apiKey) return { ok: false, detail: 'no API key' };
      const base = String(cfg.apiBase || 'https://api.samsara.com').replace(/\/$/, '');
      const res = await fetchImpl(`${base}/fleet/vehicles?limit=1`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_CHECK_TIMEOUT_MS),
      });
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    },
    notificationBot: async () => {
      const me = await notificationBot.getMe();
      const chat = await notificationBot.getChat(forcedGroupId);
      return { ok: true, detail: `@${me.username}; notifications group "${chat.title || forcedGroupId}"` };
    },
    driverBot: async () => {
      if (!driverBot) return { ok: false, detail: 'BOT_TOKEN is not set — driver groups would get nothing' };
      const me = await driverBot.getMe();
      return { ok: true, detail: `@${me.username}` };
    },
    telegramUpload: () => probeTelegramUpload({ token: notificationToken, agent }),
    // Informational: never blocks "ready". A local file is this host's own and
    // starts empty here — docs/deployment/coolify.md says what to do about it.
    subscribers: async () => {
      if (!subscribers) return { ok: true, detail: 'not checked' };
      const where = subscribers.backend();
      const n = subscribers.count();
      if (where === 'upstash') {
        const loaded = typeof subscribers.loadedFromUpstash !== 'function' || subscribers.loadedFromUpstash();
        return loaded
          ? { ok: true, detail: `Upstash, ${n} subscriber(s) — shared with the old host` }
          : { ok: true, detail: 'Upstash is configured but the startup read FAILED — the shared list is not loaded here; check UPSTASH_* and redeploy' };
      }
      return { ok: true, detail: `local file, ${n} subscriber(s) on THIS host — the old host's list does not come across` };
    },
    ffmpeg: async () => {
      const ok = await ffmpeg.isAvailable();
      return ok
        ? { ok: true, detail: 'available' }
        : { ok: false, detail: 'not available — driver-group speeding videos would go without music' };
    },
  };
}

/** One line per check, secret-free, for the startup log. */
function logPreflight(preflight, log = console) {
  log.log?.(`[Standby] Preflight ${preflight.ok ? 'PASSED — ready to go live' : 'has FAILURES — not ready to go live'}:`);
  for (const [name, r] of Object.entries(preflight.checks)) {
    log.log?.(`[Standby]   ${r.ok ? '✓' : '✗'} ${name}: ${r.detail} (${r.ms} ms)`);
  }
}

module.exports = {
  isStandby,
  scrub,
  runPreflight,
  buildStandbyHealth,
  probeTelegramUpload,
  defaultChecks,
  logPreflight,
  UPLOAD_PROBE_BYTES,
};
