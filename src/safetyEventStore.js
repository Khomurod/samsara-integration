/**
 * Keeping each safety event, so a driver's PATTERN can be seen.
 *
 * WHY IT DID NOT EXIST. This poller has been formatting safety events and
 * sending them to Telegram for a long time, then throwing them away. The only
 * durable trace was `samsara_processed_events(id, processed_at)` — an id and a
 * timestamp, for deduplication. So "how many harsh-braking events has this
 * driver had this month" was never answerable, and every alert was necessarily
 * treated as an isolated incident: a first hard brake in traffic and the fourth
 * this week produced the same message.
 *
 * Every field written here is already in memory at the moment the alert is
 * formatted. Nothing new is fetched and no extra API call is made.
 *
 * WHAT IT DOES NOT STORE: any media reference. A Samsara video URL is a
 * credential with an expiry, and this table is read by features that put things
 * into chat messages.
 *
 * The admin/hub (bot-backend, migration 0033) owns the canonical DDL; the
 * CREATE TABLE IF NOT EXISTS here mirrors it so this service works even if it
 * boots first. Keep the two in sync.
 */
const { pool } = require('./db');

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS driver_safety_events (
  samsara_event_id TEXT PRIMARY KEY,
  person_id INTEGER NULL,
  group_id INTEGER NULL,
  vehicle_id TEXT NULL,
  unit_number TEXT NULL,
  driver_name TEXT NULL,
  behavior TEXT NOT NULL,
  severity TEXT NULL,
  g_force DOUBLE PRECISION NULL,
  speed_mph DOUBLE PRECISION NULL,
  posted_speed_mph DOUBLE PRECISION NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NULL,
  lng DOUBLE PRECISION NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_driver_safety_events_person
  ON driver_safety_events (person_id, occurred_at DESC) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_safety_events_group
  ON driver_safety_events (group_id, occurred_at DESC) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_safety_events_behavior
  ON driver_safety_events (behavior, occurred_at DESC);
`;

let ensured = false;

/** Create the table if this service booted before the hub applied its migration. */
async function ensureTable() {
  if (ensured) return true;
  try {
    await pool.query(CREATE_TABLE_SQL);
    ensured = true;
    return true;
  } catch (err) {
    console.warn('[SafetyStore] could not ensure driver_safety_events:', err.message);
    return false;
  }
}

/**
 * The unit number from a vehicle label.
 *
 * Reuses `routing.js`'s parser rather than writing a fourth one. The naive
 * "first number anywhere" reading is a known bug in this repository — a vehicle
 * labelled `2021 Freightliner 305` reads as unit 2021 — and it is worth exactly
 * nothing to reproduce it here. The unit is a convenience column anyway: every
 * query that matters groups by `person_id` or `group_id`.
 */
const { extractUnitNumber } = require('./routing');

function unitFromVehicleName(name) {
  return extractUnitNumber(name);
}

/**
 * The person behind a chat, through the identity spine.
 *
 * A driver who changes truck or chat is the same person, and a safety history
 * that resets on a truck change hides exactly the driver a pattern would find.
 */
async function resolvePersonForGroup(groupId) {
  if (!groupId) return null;
  try {
    const res = await pool.query(
      `SELECT person_id FROM driver_person_groups
        WHERE group_id = $1 AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [groupId]
    );
    return res.rows[0]?.person_id ?? null;
  } catch (_) {
    // The identity layer may not exist yet in a partially migrated database.
    // An event with no person is still worth keeping: it groups by chat.
    return null;
  }
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Record one safety event.
 *
 * `ON CONFLICT DO NOTHING` on Samsara's own id, because the poller re-reads an
 * overlapping window on every pass — without it one hard brake would become a
 * pattern by itself within the hour.
 *
 * NEVER THROWS. Recording an event for later analysis must not be able to stop
 * the alert that is going out now.
 *
 * @returns {Promise<boolean>} true when a new row was written.
 */
async function recordSafetyEvent({
  eventId, behavior, severity = null, gForce = null, speedMph = null, postedSpeedMph = null,
  occurredAt, vehicleId = null, vehicleName = null, driverName = null, groupId = null,
  lat = null, lng = null,
}) {
  if (!eventId || !behavior || !occurredAt) return false;
  if (!(await ensureTable())) return false;
  try {
    const personId = await resolvePersonForGroup(groupId);
    const res = await pool.query(
      `INSERT INTO driver_safety_events
         (samsara_event_id, person_id, group_id, vehicle_id, unit_number, driver_name,
          behavior, severity, g_force, speed_mph, posted_speed_mph, occurred_at, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14)
       ON CONFLICT (samsara_event_id) DO NOTHING
       RETURNING samsara_event_id`,
      [
        String(eventId), personId, groupId || null, vehicleId ? String(vehicleId) : null,
        unitFromVehicleName(vehicleName), driverName || null,
        String(behavior), severity || null,
        toNumberOrNull(gForce), toNumberOrNull(speedMph), toNumberOrNull(postedSpeedMph),
        occurredAt, toNumberOrNull(lat), toNumberOrNull(lng),
      ]
    );
    return res.rowCount > 0;
  } catch (err) {
    console.warn(`[SafetyStore] could not record ${eventId}:`, err.message);
    return false;
  }
}

module.exports = { CREATE_TABLE_SQL, unitFromVehicleName, recordSafetyEvent };
