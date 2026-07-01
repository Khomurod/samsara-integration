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
const { extractUnitNumber, normalizeName, resolveGroupByUnitAndName } = require('./routing');

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
   * Resolve Driver Group by unit number and optional name hints.
   * Returns matched group object or null when not found.
   */
  async findGroupByUnit(unitNumber, driverName, vehicleName) {
    if (!unitNumber) return null;
    if (!sharedPgPool) {
      console.warn('[Store] DATABASE_URL not set — cannot resolve unit group.');
      return null;
    }

    try {
      const cleanUnit = String(unitNumber).replace(/\D/g, '');
      if (!cleanUnit) return null;

      const query = `
        SELECT id, telegram_group_id, group_name
        FROM groups
        WHERE group_type = 'driver'
          AND active = TRUE
          AND group_name ILIKE $1
        ORDER BY id DESC
      `;
      const res = await sharedPgPool.query(query, [`%${cleanUnit}%`]);
      const nameHints = [driverName, vehicleName]
        .map(normalizeName)
        .filter(Boolean);
      const fallbackNameHint = normalizeName(String(vehicleName || '').replace(/^\s*#?\s*\d+\s*/, ''));
      if (fallbackNameHint) nameHints.push(fallbackNameHint);
      const resolved = resolveGroupByUnitAndName(res.rows, cleanUnit, nameHints);
      if (!resolved) return null;
      const resolvedUnit = extractUnitNumber(resolved.group_name);
      const matchReason = resolvedUnit === cleanUnit && nameHints.length > 0 ? 'unit+name' : 'unit';
      return {
        telegramGroupId: String(resolved.telegram_group_id),
        groupName: resolved.group_name,
        matchReason,
      };
    } catch (err) {
      console.error('[Store] findGroupByUnit query failed:', err.message);
      return null;
    }
  },
};
