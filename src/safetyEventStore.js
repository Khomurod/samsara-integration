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
const { getPgPool } = require('./db');

/**
 * The SHARED pool, read at call time.
 *
 * This was `const { pool } = require('./db')`, and `db.js` has never exported a
 * `pool` — only `getPgPool()`. So `pool` was `undefined`, every `pool.query`
 * threw, `ensureTable` caught it and returned false, and `recordSafetyEvent`
 * returned false before touching the database. FOR THE WHOLE LIFE OF THE
 * FEATURE. Alerts went out normally, nothing logged above a warning nobody
 * read, and `driver_safety_events` stayed empty while the coaching engine
 * downstream waited for rows that could never arrive.
 *
 * No test caught it because the only test of this file imports the pure
 * `unitFromVehicleName`, and the delivery test injects a FAKE recorder — so the
 * real module's one line of wiring was never executed anywhere.
 * `tests/safetyEventStoreWiring.test.js` now executes exactly that line.
 */
function db() {
  return getPgPool();
}

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
/** Why the last attempt could not record, for the health probe below. */
let lastFailure = null;

/**
 * Create the table if this service booted before the hub applied its migration.
 *
 * "No DATABASE_URL" and "the query failed" are reported apart. The first is a
 * deployment that was never meant to record; the second is a fault. Collapsing
 * them into one false is how the bug above stayed invisible.
 *
 * CALLED AT STARTUP AS WELL AS ON THE FIRST EVENT, and that is the point.
 * Reached only from `recordSafetyEvent`, `ready` below answered "has an event
 * been recorded since boot" — a fact about the FLEET wearing the clothes of a
 * fact about the SERVICE. Production said `{ ready: false, configured: true,
 * lastFailure: null }` and the honest reading was "nothing has been tried yet",
 * which left the connection, the credentials, the permissions and the schema
 * unproven until the first incident. An incident is the worst moment to find
 * out the role cannot write.
 *
 * It is idempotent and it writes no row, so arming it early invents nothing:
 * an empty table stays empty.
 */
async function ensureTable() {
  if (ensured) return true;
  const pool = db();
  if (!pool) {
    lastFailure = 'no_database_url';
    return false;
  }
  try {
    await pool.query(CREATE_TABLE_SQL);
    ensured = true;
    lastFailure = null;
    return true;
  } catch (err) {
    lastFailure = `ensure_failed: ${err.message}`;
    console.warn('[SafetyStore] could not ensure driver_safety_events:', err.message);
    return false;
  }
}

/**
 * Whether this process can record at all, and why not.
 *
 * Exported so the hub's self-healing watch can tell "the fleet had no incidents"
 * from "this service has been unable to write for three days" — which are the
 * same empty table.
 */
function recordingStatus() {
  return { ready: ensured, configured: Boolean(db()), lastFailure };
}

/**
 * The unit number from a vehicle label.
 *
 * A LOCAL parser, and the comment that used to sit here was wrong. It said this
 * reused `routing.js` to avoid the "first number anywhere" bug — but
 * `routing.js`'s `extractUnitNumber` IS `raw.match(/\d+/)`, so it reads
 * `2021 Freightliner 305` as unit 2021 and this file inherited exactly the bug
 * it claimed to have escaped.
 *
 * The order below is what a label actually looks like: an explicit `UNIT #`
 * marker wins; failing that a lone `#`; failing that the LAST number, because
 * vehicle labels put the make and model year first and the unit last. A
 * four-digit year on its own is never a unit.
 *
 * ROUTING IS DELIBERATELY NOT CHANGED HERE. `routing.js`'s parser decides which
 * driver group receives a safety alert, and that is a live behaviour with a
 * fleet's worth of group titles behind it; it also now runs SECOND to the
 * stored `groups.samsara_vehicle_id` link and files a finding whenever the
 * fallback fires, so a wrong parse is visible rather than silent. This column
 * is a convenience — every query that matters groups by `person_id` or
 * `group_id` — so correcting it costs nothing and risks nothing.
 */
const YEAR = /^(19|20)\d{2}$/;

function unitFromVehicleName(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;

  const marked = raw.match(/unit\s*#?\s*(\d+)/i) || raw.match(/#\s*(\d+)/);
  if (marked) return marked[1];

  const numbers = raw.match(/\d+/g);
  if (!numbers || !numbers.length) return null;

  const notYears = numbers.filter((n) => !YEAR.test(n));
  const chosen = notYears.length ? notYears[notYears.length - 1] : numbers[numbers.length - 1];
  return chosen || null;
}

/**
 * The person behind a chat, through the identity spine.
 *
 * A driver who changes truck or chat is the same person, and a safety history
 * that resets on a truck change hides exactly the driver a pattern would find.
 */
async function resolvePersonForGroup(groupId) {
  if (!groupId) return null;
  const pool = db();
  if (!pool) return null;
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
  const pool = db();
  if (!pool) return false;
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
    lastFailure = `insert_failed: ${err.message}`;
    console.warn(`[SafetyStore] could not record ${eventId}:`, err.message);
    return false;
  }
}

module.exports = {
  CREATE_TABLE_SQL, ensureTable, unitFromVehicleName, recordSafetyEvent, recordingStatus,
};
