/**
 * Writing a routing finding into bot-backend's `operational_findings`.
 *
 * The two services share one PostgreSQL database and nothing else. This poller
 * may WRITE a finding — it is the only thing that knows how a live safety alert
 * was routed — but it must never apply a correction; that authority lives in
 * bot-backend behind the tiered registry, the audit trail and the reversal path.
 * So this file has exactly one statement, and it is an upsert of a `warning`-tier
 * row.
 *
 * THREE WAYS THIS MUST NOT HURT ANYTHING:
 *
 *   1. It never throws. A safety alert is the payload; the finding is a note
 *      about the payload. Losing the note to keep the alert is the right trade
 *      every time, and the reverse would be indefensible.
 *   2. It degrades silently when the table is absent (42P01). The two services
 *      deploy independently, so this poller can be running against a database
 *      whose bot-backend has not applied migration 0016 yet. That window must
 *      not fill the log with the same error every alert.
 *   3. It cannot grow without bound. `ON CONFLICT (check_key, subject_type,
 *      subject_id)` means a vehicle that routes by name a thousand times has one
 *      row with a moving `last_seen_at` — the same shape bot-backend's own
 *      checks use, for the same reason.
 */

/** Postgres: relation does not exist. */
const UNDEFINED_TABLE = '42P01';

let warnedMissingTable = false;

async function recordRoutingFinding(pool, finding, { log = console } = {}) {
  if (!pool || !finding) return false;

  try {
    await pool.query(
      `INSERT INTO operational_findings
         (check_key, subject_type, subject_id, title, severity, tier, evidence_json)
       VALUES ($1, $2, $3, $4, $5, 'warning', $6::jsonb)
       ON CONFLICT (check_key, subject_type, subject_id) DO UPDATE
         SET title = EXCLUDED.title,
             severity = EXCLUDED.severity,
             evidence_json = EXCLUDED.evidence_json,
             last_seen_at = NOW(),
             updated_at = NOW(),
             status = CASE WHEN operational_findings.status = 'resolved'
                           THEN 'open' ELSE operational_findings.status END,
             resolved_at = CASE WHEN operational_findings.status = 'resolved'
                                THEN NULL ELSE operational_findings.resolved_at END`,
      [
        finding.checkKey,
        finding.subjectType,
        String(finding.subjectId),
        finding.title,
        finding.severity || 'info',
        JSON.stringify(finding.evidence || {}),
      ]
    );
    return true;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        log.warn?.('[Routing] operational_findings is not present yet — routing findings skipped.');
      }
      return false;
    }
    log.error?.('[Routing] Failed to record a routing finding:', err.message);
    return false;
  }
}

/** Test seam — the "warn once" latch is process-wide by design. */
function resetMissingTableWarning() {
  warnedMissingTable = false;
}

module.exports = { recordRoutingFinding, resetMissingTableWarning, UNDEFINED_TABLE };
