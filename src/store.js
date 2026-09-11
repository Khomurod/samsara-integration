/**
 * store.js
 * Persists subscribed Telegram chat IDs using Upstash Redis.
 *
 * When UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set,
 * subscribers are stored in Redis and survive ALL restarts/redeploys.
 *
 * Falls back to a local in-memory + JSON file store if Redis is not configured.
 */

const fs = require('fs');
const path = require('path');
const {
  extractUnitNumber, normalizeName, resolveGroupByUnitAndName, chooseRoutedGroup,
} = require('./routing');
const { recordRoutingFinding } = require('./routingFindings');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = 'samsara_bot_subscribers';
const DATABASE_URL = process.env.DATABASE_URL;

const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
let sharedPgPool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  sharedPgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── Redis store ───────────────────────────────────────────────────────────────
let redis = null;
if (USE_REDIS) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  console.log('[Store] Using Upstash Redis for persistent subscriber storage.');
} else {
  console.log('[Store] Redis not configured — using local file store (dev mode).');
}

// ── Local file fallback ───────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'subscribers.json');

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (_) { }

function loadFromDisk() {
  try {
    if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (_) { }
  return [];
}

function saveToDisk(set) {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify([...set]), 'utf8'); } catch (_) { }
}

// In-memory cache — always stores chat IDs as STRINGS for consistency
let cache = new Set(loadFromDisk().map(String));

// Helper: normalize Redis response to an array of strings
function normalizeMembers(members) {
  if (!Array.isArray(members)) return [];
  return members.map(String);
}

// ── Public API ────────────────────────────────────────────────────────────────
module.exports = {

  /**
   * Add a subscriber. Returns true if newly added.
   */
  async add(chatId) {
    const id = String(chatId);
    if (USE_REDIS) {
      try {
        const added = await redis.sadd(REDIS_KEY, id);
        cache.add(id);
        console.log(`[Store] Redis: added ${id}. New: ${added > 0}. Cache size: ${cache.size}`);
        return added > 0;
      } catch (err) {
        console.error(`[Store] Redis add failed: ${err.message}`);
        cache.add(id);
        return true;
      }
    } else {
      if (cache.has(id)) return false;
      cache.add(id);
      saveToDisk(cache);
      return true;
    }
  },

  /**
   * Remove a subscriber. Returns true if removed.
   */
  async remove(chatId) {
    const id = String(chatId);
    if (USE_REDIS) {
      try {
        const removed = await redis.srem(REDIS_KEY, id);
        cache.delete(id);
        return removed > 0;
      } catch (err) {
        console.error(`[Store] Redis remove failed: ${err.message}`);
        cache.delete(id);
        return true;
      }
    } else {
      if (!cache.has(id)) return false;
      cache.delete(id);
      saveToDisk(cache);
      return true;
    }
  },

  /**
   * Check if subscribed (uses in-memory cache — always strings).
   */
  has(chatId) {
    return cache.has(String(chatId));
  },

  /**
   * Get all subscribers. Always refreshes from Redis if available.
   */
  async getAll() {
    if (USE_REDIS) {
      try {
        const members = await redis.smembers(REDIS_KEY);
        const normalized = normalizeMembers(members);
        cache = new Set(normalized);
        console.log(`[Store] Refreshed from Redis: ${cache.size} subscriber(s)`);
        return normalized;
      } catch (err) {
        console.error('[Store] Redis getAll failed, using cache:', err.message);
        return [...cache];
      }
    }
    return [...cache];
  },

  /**
   * Total count (from cache).
   */
  count() {
    return cache.size;
  },

  /**
   * Load all subscribers from Redis into cache on startup.
   * Ensures all IDs are stored as strings for consistent lookups.
   */
  async init() {
    if (USE_REDIS) {
      try {
        const members = await redis.smembers(REDIS_KEY);
        const normalized = normalizeMembers(members);
        cache = new Set(normalized);
        console.log(`[Store] Loaded ${cache.size} subscriber(s) from Redis: [${normalized.join(', ')}]`);
      } catch (err) {
        console.error('[Store] Failed to load from Redis on init:', err.message);
      }
    }
  },

  /**
   * Resolve the driver group for a Samsara vehicle.
   *
   * Prefers the stored `groups.samsara_vehicle_id` link and keeps the unit-number
   * parse as the fallback; see `chooseRoutedGroup` in routing.js for which wins
   * and what gets reported. Returns the matched group or null — never a guess,
   * and never the management group.
   */
  async findGroupByUnit(unitNumber, driverName, vehicleName, vehicleId = null) {
    if (!unitNumber && !vehicleId) return null;
    if (!sharedPgPool) {
      console.warn('[Store] DATABASE_URL not set — cannot resolve unit group.');
      return null;
    }

    try {
      // BOTH resolutions run, even though only one can win. The stored link is
      // new and the string parse is what has been routing alerts for a year;
      // running the old one alongside the new one is how a wrong link becomes a
      // `serious` finding on day one instead of a driver who quietly stops
      // receiving safety alerts. It is one extra indexed lookup on a table of a
      // few hundred rows, per safety event.
      const claims = await findGroupsByVehicleId(vehicleId);
      const parsed = await findGroupByNameParse(unitNumber, driverName, vehicleName);

      const choice = chooseRoutedGroup({
        stored: claims.length === 1 ? claims[0] : null,
        contestedStored: claims.length > 1 ? claims : null,
        parsed,
        vehicleId,
        vehicleName,
        unitNumber,
      });
      if (choice.finding) {
        await recordRoutingFinding(sharedPgPool, choice.finding);
      }
      if (!choice.group) return null;

      return {
        // The internal id as well as the chat id: `driver_safety_events` keys on
        // `groups.id`, and it is the join to the driver's permanent identity.
        // Resolving it a second time from the chat id would be a second query
        // for a value already in hand.
        groupId: choice.group.id,
        telegramGroupId: String(choice.group.telegram_group_id),
        groupName: choice.group.group_name,
        matchReason: choice.matchReason,
      };
    } catch (err) {
      console.error('[Store] findGroupByUnit query failed:', err.message);
      return null;
    }
  },
};

/**
 * Every active driver group claiming this vehicle — usually none or one.
 *
 * `groups.samsara_vehicle_id` is written by bot-backend's duplicate-unit scan
 * only when the resolution is unambiguous in both directions, so two claimants
 * should not be reachable. ALL of them are returned anyway, rather than
 * collapsing to null, because "two groups claim this truck" and "no group claims
 * this truck" are opposite facts and only one of them is worth waking somebody
 * over. `chooseRoutedGroup` turns the first into a `serious` finding; collapsing
 * them here would have hidden it behind a silent fallback to the name parse.
 */
async function findGroupsByVehicleId(vehicleId) {
  const id = String(vehicleId || '').trim();
  if (!id) return [];

  const res = await sharedPgPool.query(
    `SELECT id, telegram_group_id, group_name
     FROM groups
     WHERE samsara_vehicle_id = $1
       AND group_type = 'driver'
       AND active = TRUE
     ORDER BY id ASC`,
    [id]
  );
  return res.rows;
}

/** The parse that has always run. Unchanged, and now the fallback. */
async function findGroupByNameParse(unitNumber, driverName, vehicleName) {
  const cleanUnit = String(unitNumber || '').replace(/\D/g, '');
  if (!cleanUnit) return null;

  const res = await sharedPgPool.query(
    `SELECT id, telegram_group_id, group_name
     FROM groups
     WHERE group_type = 'driver'
       AND active = TRUE
       AND group_name ILIKE $1
     ORDER BY id DESC`,
    [`%${cleanUnit}%`]
  );

  const nameHints = [driverName, vehicleName].map(normalizeName).filter(Boolean);
  const fallbackNameHint = normalizeName(String(vehicleName || '').replace(/^\s*#?\s*\d+\s*/, ''));
  if (fallbackNameHint) nameHints.push(fallbackNameHint);

  const resolved = resolveGroupByUnitAndName(res.rows, cleanUnit, nameHints);
  if (!resolved) return null;

  const resolvedUnit = extractUnitNumber(resolved.group_name);
  return {
    ...resolved,
    matchReason: resolvedUnit === cleanUnit && nameHints.length > 0 ? 'unit+name' : 'unit',
  };
}
