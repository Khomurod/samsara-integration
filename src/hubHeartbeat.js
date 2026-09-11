/**
 * Telling the hub this service is alive.
 *
 * THE PROBLEM. This poller is a SEPARATE Render service. It shares exactly one
 * thing with bot-backend — the Postgres database — and nothing else. So from
 * the hub's side, "the Samsara poller has been dead since Tuesday" and "the
 * fleet has had no safety events this week" produce identical evidence: an
 * empty `driver_safety_events` table and a quiet channel. A fleet CAN have a
 * quiet week. That is the whole difficulty.
 *
 * One row, updated in place, in the hub's `background_service_runs` ledger
 * under the key `samsara_safety_pipeline`, which the hub's self-healing watch
 * already looks for. No new table, no queue, no extra service.
 *
 * WHAT IT WRITES: a status word, a timestamp and three counts. No event, no
 * driver, no vehicle, no media URL, no API key — the hub publishes this row on
 * a public health endpoint.
 *
 * IT IS BEST-EFFORT AND SILENT ON FAILURE. A heartbeat that can break the poll
 * it reports on is worse than no heartbeat: the poll is the product and this is
 * a comment on it. A database without the ledger table (a hub that has not
 * deployed migration 0039 yet) simply writes nothing.
 */
const { getPgPool } = require('./db');

const SERVICE_KEY = 'samsara_safety_pipeline';
/** How often the hub should expect to hear from this service, in seconds. */
const EXPECTED_INTERVAL_SECONDS = 3600;

let lastFailure = null;

/**
 * @param {'ok'|'error'|'skipped'|'blocked'} status
 * @param {object} [options]
 * @param {string|null} [options.detail]  short, and never a provider's text
 * @param {object|null} [options.summary] counts only
 */
async function beat(status, { detail = null, summary = null } = {}) {
  const pool = getPgPool();
  if (!pool) return false;
  const failed = status === 'error';
  try {
    await pool.query(
      `INSERT INTO background_service_runs
         (service_key, last_started_at, last_finished_at, last_status, last_error,
          last_summary, last_ok_at, last_error_at, consecutive_failures, runs_total,
          failures_total, expected_interval_seconds, updated_at)
       VALUES ($1, NOW(), NOW(), $2, $3, $4::jsonb,
               CASE WHEN $5 THEN NULL ELSE NOW() END,
               CASE WHEN $5 THEN NOW() ELSE NULL END,
               CASE WHEN $5 THEN 1 ELSE 0 END, 1, CASE WHEN $5 THEN 1 ELSE 0 END, $6, NOW())
       ON CONFLICT (service_key) DO UPDATE SET
         last_finished_at = NOW(),
         last_status = EXCLUDED.last_status,
         last_error = EXCLUDED.last_error,
         last_summary = EXCLUDED.last_summary,
         last_ok_at = CASE WHEN $5 THEN background_service_runs.last_ok_at ELSE NOW() END,
         last_error_at = CASE WHEN $5 THEN NOW() ELSE background_service_runs.last_error_at END,
         consecutive_failures =
           CASE WHEN $5 THEN background_service_runs.consecutive_failures + 1 ELSE 0 END,
         runs_total = background_service_runs.runs_total + 1,
         failures_total = background_service_runs.failures_total + CASE WHEN $5 THEN 1 ELSE 0 END,
         expected_interval_seconds = EXCLUDED.expected_interval_seconds,
         updated_at = NOW()`,
      [
        SERVICE_KEY, status,
        detail ? String(detail).slice(0, 300) : null,
        summary ? JSON.stringify(summary) : null,
        failed, EXPECTED_INTERVAL_SECONDS,
      ]
    );
    lastFailure = null;
    return true;
  } catch (err) {
    // Once, quietly. A missing table is the ordinary case on a database whose
    // hub has not deployed the migration yet, and a warning per poll would
    // bury the poller's own logs.
    if (lastFailure !== err.message) {
      lastFailure = err.message;
      console.warn('[Heartbeat] could not record poll:', err.message);
    }
    return false;
  }
}

function heartbeatStatus() {
  return { serviceKey: SERVICE_KEY, configured: Boolean(getPgPool()), lastFailure };
}

module.exports = { SERVICE_KEY, EXPECTED_INTERVAL_SECONDS, beat, heartbeatStatus };
