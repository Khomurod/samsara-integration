'use strict';

/**
 * healthReport.js
 *
 * PURE, side-effect-free logic for the /health endpoint. It takes an already
 * collected snapshot of the service's operational state and decides:
 *   - whether the service is healthy,
 *   - the HTTP status to return (200 healthy / "starting", 503 unhealthy),
 *   - a sanitized, secret-free body describing each poller.
 *
 * It performs NO I/O and reads NO globals (time/uptime are injected), so it can
 * be unit-tested exhaustively and reused by the Express handler in index.js.
 * It never changes polling, delivery, dedup, routing, or database behaviour.
 */

// Patterns that must never leak into a health response even though poll errors
// normally do not contain secrets. Scrubbing is defensive.
const SECRET_PATTERNS = [
  // Authorization: Bearer <token>
  [/Bearer\s+[A-Za-z0-9._:\-]+/gi, 'Bearer [redacted]'],
  // Samsara API keys
  [/samsara_api_[A-Za-z0-9._-]+/gi, 'samsara_api_[redacted]'],
  // Telegram bot tokens: <digits>:<authstring>
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-telegram-token]'],
  // querystring secrets (apikey=, token=, key=, signature=, sig=)
  [/([?&](?:apikey|api_key|token|key|signature|sig)=)[^&\s]+/gi, '$1[redacted]'],
];

const MAX_ERROR_MESSAGE_LEN = 300;

/**
 * Best-effort scrub + truncate for an error message shown in /health.
 * @param {*} message
 * @returns {string|null}
 */
function sanitizeErrorMessage(message) {
  if (message == null) return null;
  let text = String(message);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > MAX_ERROR_MESSAGE_LEN) {
    text = `${text.slice(0, MAX_ERROR_MESSAGE_LEN - 1)}…`;
  }
  return text;
}

function sanitizeLastError(lastError) {
  if (!lastError || typeof lastError !== 'object') return null;
  return {
    code: lastError.code ?? null,
    message: sanitizeErrorMessage(lastError.message),
    at: lastError.at || null,
  };
}

/**
 * Evaluate a single poller's snapshot against the staleness rules.
 * @returns {{ enabled: boolean, hasSucceeded: boolean, stale: boolean,
 *             ageMs: number|null, view: object }}
 */
function evaluatePoller(kind, snapshot, opts) {
  const s = snapshot || {};
  const enabled = s.enabled !== false; // default enabled
  const hasSucceeded = Number.isFinite(s.lastSuccessAt);
  const ageMs = hasSucceeded ? Math.max(0, opts.now - s.lastSuccessAt) : null;

  let stale;
  if (!enabled) {
    stale = false; // a deliberately disabled poller can never be "stale"
  } else if (hasSucceeded) {
    stale = ageMs > opts.staleThresholdMs;
  } else {
    // Never succeeded: only "stale/stopped" once the startup grace has elapsed.
    stale = opts.uptimeMs > opts.startupGraceMs;
  }

  return {
    enabled,
    hasSucceeded,
    stale,
    ageMs,
    view: {
      enabled,
      lastSuccessAt: hasSucceeded ? new Date(s.lastSuccessAt).toISOString() : null,
      ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
      stale,
      lastPollEndTime: s.lastPollEndTime || null,
      queueSize: Number.isFinite(s.queueSize) ? s.queueSize : 0,
      droppedAlerts: Number.isFinite(s.droppedAlerts) ? s.droppedAlerts : 0,
      lastError: sanitizeLastError(s.lastApiError),
    },
  };
}

/**
 * Build the /health report from a collected snapshot.
 *
 * @param {Object} input
 * @param {number} input.now                 Current time (ms since epoch).
 * @param {number} input.uptimeSeconds        process.uptime().
 * @param {boolean} input.coordinatorRunning  Is the poll coordinator active?
 * @param {number} input.staleThresholdMs      Max age of a successful poll before "stale".
 * @param {number} input.startupGraceMs        Grace after boot before "never started" = unhealthy.
 * @param {Object} input.safety                Safety poller snapshot.
 * @param {Object} input.speeding              Speeding poller snapshot.
 * @returns {{ statusCode: number, body: object }}
 */
function buildHealthReport(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const uptimeSeconds = Number.isFinite(input.uptimeSeconds) ? input.uptimeSeconds : 0;
  const uptimeMs = uptimeSeconds * 1000;
  const staleThresholdMs = Number.isFinite(input.staleThresholdMs) ? input.staleThresholdMs : 300_000;
  const startupGraceMs = Number.isFinite(input.startupGraceMs) ? input.startupGraceMs : 120_000;
  const coordinatorRunning = input.coordinatorRunning === true;

  const opts = { now, uptimeMs, staleThresholdMs, startupGraceMs };
  const safety = evaluatePoller('safety', input.safety, opts);
  const speeding = evaluatePoller('speeding', input.speeding, opts);

  const anyStale = safety.stale || speeding.stale;
  const anySucceeded = safety.hasSucceeded || speeding.hasSucceeded;
  const withinStartupGrace = uptimeMs <= startupGraceMs;

  const healthy = coordinatorRunning && !anyStale;

  let status;
  if (!healthy) {
    status = 'unhealthy';
  } else if (!anySucceeded && withinStartupGrace) {
    status = 'starting';
  } else {
    status = 'ok';
  }

  const statusCode = healthy ? 200 : 503;

  return {
    statusCode,
    body: {
      // Backward-compatible top-level fields (the old endpoint returned
      // status/uptime/timestamp; "ok" is preserved for the healthy case).
      status,
      healthy,
      uptime: Math.round(uptimeSeconds),
      timestamp: new Date(now).toISOString(),
      coordinatorRunning,
      thresholds: { staleThresholdMs, startupGraceMs },
      pollers: {
        safety: safety.view,
        speeding: speeding.view,
      },
    },
  };
}

module.exports = { buildHealthReport, sanitizeErrorMessage };
