/**
 * Writing a routing finding into bot-backend's `operational_findings`.
 *
 * The two services share one PostgreSQL database and nothing else. This poller
 * may WRITE a finding — it is the only thing that knows how a live safety alert
 * was routed — but it must never apply a correction; that authority lives in
 * bot-backend behind the tiered registry, the audit trail and the reversal path.
 * So this file has exactly two statements: an upsert of a `warning`-tier row,
 * and the close of this poller's OWN rows for a vehicle once they stop being
 * true.
 *
 * WHY IT CLOSES ITS OWN. A routing finding says how one vehicle's alerts were
 * routed. Nothing else knows when that changes, so nothing else closed them:
 * on 20 October 2026, four of nine "routed by name" findings described
 * vehicles that had routed by their stored link for weeks. Now every routed
 * alert settles the record for its vehicle — the finding it files stays open,
 * the other routing findings for that vehicle are resolved — and an alert
 * that reaches nobody settles nothing.
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

/** Every key this poller files. These, and only these, it may also close. */
const ROUTING_KEYS = Object.freeze([
  'integrations.samsara_routed_by_name',
  'integrations.samsara_routing_disagreement',
  'integrations.samsara_vehicle_link_contested',
]);

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

/**
 * Resolve this vehicle's open routing findings, except the one just filed.
 * Never throws, for the same reason the upsert never does.
 *
 * @returns {Promise<number>} how many were resolved
 */
async function resolveRoutingFindings(pool, subjectId, { except = null, log = console } = {}) {
  if (!pool || !subjectId) return 0;
  const keys = ROUTING_KEYS.filter((key) => key !== except);
  try {
    const res = await pool.query(
      `UPDATE operational_findings
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
        WHERE check_key = ANY($1::text[])
          AND subject_type = 'samsara_vehicle'
          AND subject_id = $2
          AND status = 'open'`,
      [keys, String(subjectId)]
    );
    return res?.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    log.error?.('[Routing] Failed to settle routing findings:', err.message);
    return 0;
  }
}

/** Test seam — the "warn once" latch is process-wide by design. */
function resetMissingTableWarning() {
  warnedMissingTable = false;
}

module.exports = {
  recordRoutingFinding, resolveRoutingFindings, resetMissingTableWarning, UNDEFINED_TABLE, ROUTING_KEYS,
};
