/**
 * videoRecoveryStore.js
 *
 * The DURABLE record of "this safety event was alerted without video".
 *
 * It replaces an in-memory `setTimeout` + `Set`. That worked until Render
 * restarted or redeployed inside the wait window, at which point every pending
 * video was silently dropped — the text alert had gone out, so nothing looked
 * broken, and the clip simply never arrived. A row in the shared Postgres
 * survives all of that, which is the entire reason this module exists.
 *
 * NO NEW INFRASTRUCTURE. This is the same database the poller already uses for
 * dedup and the delivery ledger — no Redis, no queue service, no second store.
 * The whole worker protocol is: claim the rows whose `next_check_at` has
 * passed, advance them, put them back.
 *
 * WHAT A ROW HOLDS, and what it deliberately does not: the event id (UNIQUE —
 * that is what makes enqueue idempotent), the vehicle and event time, the
 * Telegram messages to fold the video into, the retrieval this job is waiting
 * on, the attempt count, the status and the last error. It never holds a signed
 * media URL and never holds a credential.
 *
 * The admin/hub (bot-backend, migration 0013) owns the canonical DDL; the
 * CREATE TABLE IF NOT EXISTS here mirrors it so this service works even if it
 * boots first. Keep the two in sync.
 */

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS samsara_video_recovery_jobs (
  id BIGSERIAL PRIMARY KEY,
  samsara_event_id TEXT NOT NULL UNIQUE,
  vehicle_id TEXT NULL,
  event_time TIMESTAMPTZ NULL,
  is_speeding BOOLEAN NOT NULL DEFAULT FALSE,
  raw_event JSONB NULL,
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending_recheck'
    CHECK (status IN ('pending_recheck','pending_retrieval','video_available','completed','no_video','failed')),
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  retrieval_id TEXT NULL,
  retrieval_requested_at TIMESTAMPTZ NULL,
  retrieval_start_time TIMESTAMPTZ NULL,
  retrieval_end_time TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  locked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL
)`;

const CREATE_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_samsara_video_recovery_due
     ON samsara_video_recovery_jobs (next_check_at)
     WHERE status IN ('pending_recheck', 'pending_retrieval', 'video_available')`,
  `CREATE INDEX IF NOT EXISTS idx_samsara_video_recovery_status_created
     ON samsara_video_recovery_jobs (status, created_at DESC)`,
];

/** A claim older than this belonged to a process that died mid-job. */
const STALE_LOCK_MS = 10 * 60 * 1000;

const OPEN_STATUSES = ['pending_recheck', 'pending_retrieval', 'video_available'];

/** Trim an error to something a table column and a human can both hold. */
function shortError(err) {
  const message = typeof err === 'string' ? err : (err?.message || String(err || ''));
  return message.slice(0, 500) || null;
}

/**
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {Console} [opts.log]
 */
function createVideoRecoveryStore({ pool, log = console } = {}) {
  let ready = false;

  async function ensureSchema() {
    if (!pool || ready) return ready;
    try {
      await pool.query(CREATE_TABLE_SQL);
      for (const sql of CREATE_INDEXES_SQL) await pool.query(sql);
      ready = true;
      log.log?.('[VideoRecovery] Durable recovery table ready.');
    } catch (err) {
      log.error?.(`[VideoRecovery] Could not prepare the recovery table: ${err.message}`);
      ready = false;
    }
    return ready;
  }

  /**
   * Record a new recovery, or leave the existing one alone.
   *
   * ON CONFLICT DO NOTHING is the duplicate guard: a re-delivered event, a
   * retried delivery or a second poller can all call this and there is still
   * exactly one recovery — and therefore at most one Samsara retrieval request
   * — per event.
   *
   * @returns {Promise<{created: boolean, job: object|null}>}
   */
  async function enqueue({
    eventId, vehicleId = null, eventTime = null, isSpeeding = false,
    rawEvent = null, targets = [], nextCheckAt,
  }) {
    if (!pool || !eventId) return { created: false, job: null };
    try {
      const res = await pool.query(
        `INSERT INTO samsara_video_recovery_jobs
           (samsara_event_id, vehicle_id, event_time, is_speeding, raw_event, targets, status, next_check_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending_recheck', $7)
         ON CONFLICT (samsara_event_id) DO NOTHING
         RETURNING *`,
        [
          String(eventId),
          vehicleId == null ? null : String(vehicleId),
          eventTime || null,
          Boolean(isSpeeding),
          JSON.stringify(rawEvent || null),
          JSON.stringify(targets || []),
          nextCheckAt || new Date(),
        ],
      );
      if (res.rows[0]) return { created: true, job: res.rows[0] };
      const existing = await pool.query(
        'SELECT * FROM samsara_video_recovery_jobs WHERE samsara_event_id = $1',
        [String(eventId)],
      );
      return { created: false, job: existing.rows[0] || null };
    } catch (err) {
      log.error?.(`[VideoRecovery] enqueue failed for event ${eventId}: ${err.message}`);
      return { created: false, job: null };
    }
  }

  /**
   * Claim the jobs that are due, atomically.
   *
   * FOR UPDATE SKIP LOCKED plus the `locked_at` marker means a second worker —
   * or the same worker whose previous tick has not finished — cannot pick up a
   * row already in flight. A claim older than STALE_LOCK_MS is reclaimable, so
   * a process killed mid-job strands nothing.
   */
  async function claimDueJobs({ limit = 5, now = new Date() } = {}) {
    if (!pool) return [];
    try {
      const res = await pool.query(
        `UPDATE samsara_video_recovery_jobs
            SET locked_at = $2, updated_at = NOW()
          WHERE id IN (
            SELECT id FROM samsara_video_recovery_jobs
             WHERE status IN ('pending_recheck', 'pending_retrieval', 'video_available')
               AND next_check_at <= $2
               AND (locked_at IS NULL OR locked_at < $3)
             ORDER BY next_check_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [limit, now, new Date(now.getTime() - STALE_LOCK_MS)],
      );
      return res.rows;
    } catch (err) {
      log.error?.(`[VideoRecovery] claim failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Put a job back for another look.
   *
   * `attempts` is incremented here rather than by the caller so "how many times
   * have we asked Samsara about this?" has exactly one owner.
   */
  async function reschedule(jobId, {
    status = 'pending_recheck',
    nextCheckAt,
    lastError = null,
    retrievalId,
    retrievalStartTime,
    retrievalEndTime,
  } = {}) {
    if (!pool || !jobId) return null;
    try {
      const res = await pool.query(
        `UPDATE samsara_video_recovery_jobs
            SET status = $2,
                next_check_at = $3,
                attempts = attempts + 1,
                last_error = $4,
                retrieval_id = COALESCE($5, retrieval_id),
                retrieval_requested_at = CASE
                  WHEN $5 IS NOT NULL AND retrieval_id IS NULL THEN NOW()
                  ELSE retrieval_requested_at END,
                retrieval_start_time = COALESCE($6, retrieval_start_time),
                retrieval_end_time = COALESCE($7, retrieval_end_time),
                locked_at = NULL,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          jobId, status, nextCheckAt || new Date(), shortError(lastError),
          retrievalId || null, retrievalStartTime || null, retrievalEndTime || null,
        ],
      );
      return res.rows[0] || null;
    } catch (err) {
      log.error?.(`[VideoRecovery] reschedule of job ${jobId} failed: ${err.message}`);
      return null;
    }
  }

  /**
   * End a job. `completed`, `no_video` and `failed` are all terminal, and all
   * three are recorded rather than dropped — "we gave up, here is why" is the
   * thing an operator needs and the thing the old in-memory version could not
   * tell anyone.
   */
  async function finish(jobId, { status, lastError = null } = {}) {
    if (!pool || !jobId) return null;
    try {
      const res = await pool.query(
        `UPDATE samsara_video_recovery_jobs
            SET status = $2,
                last_error = $3,
                locked_at = NULL,
                completed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [jobId, status, shortError(lastError)],
      );
      return res.rows[0] || null;
    } catch (err) {
      log.error?.(`[VideoRecovery] finishing job ${jobId} failed: ${err.message}`);
      return null;
    }
  }

  /** Drop a claim without changing anything else (an unexpected throw mid-tick). */
  async function release(jobId) {
    if (!pool || !jobId) return;
    try {
      await pool.query(
        'UPDATE samsara_video_recovery_jobs SET locked_at = NULL, updated_at = NOW() WHERE id = $1',
        [jobId],
      );
    } catch (err) {
      log.warn?.(`[VideoRecovery] releasing job ${jobId} failed: ${err.message}`);
    }
  }

  /**
   * Replace the outstanding targets.
   *
   * Called after a fold-in that reached some destinations and not others: the
   * ones that got their video are REMOVED, so a retry can never post a second
   * video into a group that already has one. That is the per-target
   * idempotency the immediate-delivery ledger gives the alert itself.
   */
  async function setTargets(jobId, targets) {
    if (!pool || !jobId) return null;
    try {
      const res = await pool.query(
        `UPDATE samsara_video_recovery_jobs
            SET targets = $2::jsonb, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [jobId, JSON.stringify(targets || [])],
      );
      return res.rows[0] || null;
    } catch (err) {
      log.error?.(`[VideoRecovery] updating targets of job ${jobId} failed: ${err.message}`);
      return null;
    }
  }

  /** Whether an event already has a recovery, in any state. Used by the dedup path. */
  async function hasJob(eventId) {
    if (!pool || !eventId) return false;
    try {
      const res = await pool.query(
        'SELECT 1 FROM samsara_video_recovery_jobs WHERE samsara_event_id = $1',
        [String(eventId)],
      );
      return res.rows.length > 0;
    } catch (err) {
      log.warn?.(`[VideoRecovery] hasJob(${eventId}) failed: ${err.message}`);
      return false;
    }
  }

  /** Counts by status — the /health and startup summaries. */
  async function countsByStatus() {
    if (!pool) return {};
    try {
      const res = await pool.query(
        'SELECT status, COUNT(*)::int AS count FROM samsara_video_recovery_jobs GROUP BY status'
      );
      return Object.fromEntries(res.rows.map((r) => [r.status, r.count]));
    } catch {
      return {};
    }
  }

  return {
    ensureSchema,
    enqueue,
    claimDueJobs,
    reschedule,
    setTargets,
    finish,
    release,
    hasJob,
    countsByStatus,
    isReady: () => ready,
  };
}

module.exports = {
  createVideoRecoveryStore,
  OPEN_STATUSES,
  STALE_LOCK_MS,
  shortError,
  _sql: { CREATE_TABLE_SQL, CREATE_INDEXES_SQL },
};
