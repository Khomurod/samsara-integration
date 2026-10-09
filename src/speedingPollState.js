/**
 * speedingPollState.js
 * Where the speeding poller keeps its place: the stream cursor, the time
 * watermark, and the ids of the events it has already delivered.
 *
 * Postgres when there is a database — the cursor and watermark go through
 * src/db.js's poll-state cache (read once per key, written only when they
 * change), and the delivered ids share `samsara_processed_events` with the
 * safety poller, `speed:`-namespaced so the two can never collide. A JSON file
 * under data/ when there is not.
 *
 * Moved out of speedingPoller.js as it was; the only change is that it now
 * reaches the process's ONE shared pool instead of opening its own.
 */

const fs = require('fs');
const path = require('path');

const PROCESSED_PREFIX = 'speed:';

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_JSON = path.join(DATA_DIR, 'speeding-stream-state.json');

/**
 * src/db.js, which owns the shared pool and the poll-state cache. Required when
 * used rather than when this file loads, so the order in which modules require
 * each other can never leave this holding a half-loaded module.
 */
function db() {
  return require('./db');
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[SpeedPoller] Failed creating data dir:', err.message);
  }
}

function getJsonState() {
  ensureDataDir();
  try {
    if (!fs.existsSync(STATE_JSON)) return {};
    return JSON.parse(fs.readFileSync(STATE_JSON, 'utf8'));
  } catch (err) {
    console.error('[SpeedPoller] JSON state read error:', err.message);
    return {};
  }
}

function saveJsonState(patch) {
  const state = getJsonState();
  const next = { ...state, ...patch };
  ensureDataDir();
  try {
    fs.writeFileSync(STATE_JSON, JSON.stringify(next));
  } catch (err) {
    console.error('[SpeedPoller] JSON state write error:', err.message);
  }
}

async function getPollState(key) {
  if (db().getPgPool()) return db().getPollState(key);
  const state = getJsonState();
  return state[key] || null;
}

async function savePollState(key, value) {
  if (!value) return;
  if (db().getPgPool()) {
    await db().savePollState(key, value);
    return;
  }
  saveJsonState({ [key]: value, updated_at: new Date().toISOString() });
}

async function isSpeedingEventProcessed(eventId) {
  if (!eventId) return false;
  const namespaced = `${PROCESSED_PREFIX}${eventId}`;
  const pgPool = db().getPgPool();
  if (!pgPool) {
    const state = getJsonState();
    const list = Array.isArray(state.speeding_processed_ids) ? state.speeding_processed_ids : [];
    return list.includes(namespaced);
  }

  try {
    const res = await pgPool.query('SELECT id FROM samsara_processed_events WHERE id = $1', [namespaced]);
    return res.rows.length > 0;
  } catch (err) {
    console.error('[SpeedPoller] isSpeedingEventProcessed error:', err.message);
    return false;
  }
}

async function markSpeedingEventProcessed(eventId) {
  if (!eventId) return;
  const namespaced = `${PROCESSED_PREFIX}${eventId}`;
  const pgPool = db().getPgPool();
  if (!pgPool) {
    const state = getJsonState();
    const list = Array.isArray(state.speeding_processed_ids) ? state.speeding_processed_ids : [];
    if (!list.includes(namespaced)) {
      list.push(namespaced);
      saveJsonState({ speeding_processed_ids: list.slice(-5000) });
    }
    return;
  }

  try {
    await pgPool.query('INSERT INTO samsara_processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING', [namespaced]);
  } catch (err) {
    console.error('[SpeedPoller] markSpeedingEventProcessed error:', err.message);
  }
}

module.exports = {
  getPollState,
  savePollState,
  isSpeedingEventProcessed,
  markSpeedingEventProcessed,
};
