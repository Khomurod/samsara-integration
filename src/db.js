/**
 * db.js
 * Persistent storage for the Samsara API pagination cursor.
 * Uses better-sqlite3 if available, or falls back to JSON file storage.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pgPool = null;
if (process.env.DATABASE_URL) {
    pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'cursor.db');
const JSON_FILE = path.join(DATA_DIR, 'cursor.json');

// Ensure data directory exists
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
} catch (err) {
    console.error('[DB] Failed to create data directory:', err.message);
}

let db = null;
let useJsonFallback = false;

try {
    const Database = require('better-sqlite3');
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL'); // Better concurrency, less disk I/O
    console.log(`[DB] Connected to SQLite cursor database at ${DB_FILE}`);

    // Create table if it doesn't exist
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
            id INTEGER PRIMARY KEY,
            next_cursor TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Ensure the single row exists
    const rowCount = db.prepare('SELECT COUNT(*) as count FROM sync_state WHERE id = 1').get().count;
    if (rowCount === 0) {
        db.prepare('INSERT INTO sync_state (id, next_cursor) VALUES (1, NULL)').run();
    }

} catch (err) {
    console.warn('[DB] SQLite initialization failed (normal if better-sqlite3 is not installed).');
    console.warn(`[DB] Falling back to JSON storage at ${JSON_FILE}`);
    useJsonFallback = true;
}

let cachedCursor = null;
let cachedPollWatermark = null;

function isIsoTimestamp(value) {
    return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value);
}

function clearCursorInternal() {
    cachedCursor = null;

    if (useJsonFallback) {
        try {
            if (fs.existsSync(JSON_FILE)) {
                fs.unlinkSync(JSON_FILE);
            }
        } catch (e) {
            console.error('[DB] JSON Clear Error:', e.message);
        }
        return;
    }

    if (!db) return;
    try {
        db.prepare(`
            UPDATE sync_state
            SET next_cursor = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `).run();
    } catch (err) {
        console.error('[DB] Error clearing cursor:', err.message);
    }
}

module.exports = {
    /**
     * Get the last saved cursor.
     * @returns {string|null} The cursor string, or null if none saved.
     */
    getCursor() {
        if (cachedCursor) {
            if (isIsoTimestamp(cachedCursor)) {
                console.warn(`[DB] Found legacy timestamp cursor in cache (${cachedCursor}). Clearing.`);
                clearCursorInternal();
                return null;
            }
            return cachedCursor;
        }

        if (useJsonFallback) {
            try {
                if (fs.existsSync(JSON_FILE)) {
                    const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
                    cachedCursor = data.next_cursor || null;
                    if (isIsoTimestamp(cachedCursor)) {
                        console.warn(`[DB] Found legacy timestamp cursor in JSON (${cachedCursor}). Clearing.`);
                        clearCursorInternal();
                        return null;
                    }
                    return cachedCursor;
                }
            } catch (e) {
                console.error('[DB] JSON Read Error:', e.message);
            }
            return null;
        }

        if (!db) return null;
        try {
            const row = db.prepare('SELECT next_cursor FROM sync_state WHERE id = 1').get();
            cachedCursor = row ? row.next_cursor : null;
            if (isIsoTimestamp(cachedCursor)) {
                console.warn(`[DB] Found legacy timestamp cursor in SQLite (${cachedCursor}). Clearing.`);
                clearCursorInternal();
                return null;
            }
            return cachedCursor;
        } catch (err) {
            console.error('[DB] Error reading cursor:', err.message);
            return null;
        }
    },

    /**
     * Save the newly fetched cursor.
     * @param {string} cursor - The cursor from Samsara API (pagination.endCursor).
     */
    saveCursor(cursor) {
        if (!cursor) return;
        if (cursor === cachedCursor) return; // No change

        cachedCursor = cursor;

        if (useJsonFallback) {
            try {
                fs.writeFileSync(JSON_FILE, JSON.stringify({ next_cursor: cursor, updated_at: new Date().toISOString() }));
                // console.log(`[DB] Saved new cursor to JSON: ${cursor}`);
            } catch (e) {
                console.error('[DB] JSON Write Error:', e.message);
            }
            return;
        }

        if (!db) return;
        try {
            db.prepare(`
                UPDATE sync_state 
                SET next_cursor = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE id = 1
            `).run(cursor);
            // console.log(`[DB] Saved new cursor: ${cursor}`);
        } catch (err) {
            console.error(`[DB] Error saving cursor (${cursor}):`, err.message);
        }
    },

    /**
     * Clear the persisted cursor (used when Samsara rejects a stale/invalid cursor).
     */
    clearCursor() {
        clearCursorInternal();
    },

    /**
     * Persisted fallback watermark for time-window polling.
     * Stored in Postgres so it survives restarts on ephemeral filesystems.
     */
    async getPollWatermark() {
        if (cachedPollWatermark) return cachedPollWatermark;
        if (!pgPool) return null;
        try {
            const res = await pgPool.query('SELECT value FROM samsara_poll_state WHERE key = $1', ['last_successful_poll_end_time']);
            cachedPollWatermark = res.rows[0]?.value || null;
            return cachedPollWatermark;
        } catch (err) {
            console.error('[DB] getPollWatermark error:', err.message);
            return null;
        }
    },

    async savePollWatermark(isoTime) {
        if (!isoTime || !pgPool) return;
        cachedPollWatermark = isoTime;
        try {
            await pgPool.query(
                `INSERT INTO samsara_poll_state (key, value, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE
                 SET value = EXCLUDED.value,
                     updated_at = NOW()`,
                ['last_successful_poll_end_time', isoTime]
            );
        } catch (err) {
            console.error('[DB] savePollWatermark error:', err.message);
        }
    },

    /**
     * EXTENSION: Postgres Group Lookup
     *
     * Reuses the module-level `pgPool` instead of spinning up (and tearing
     * down) a brand-new Pool on every call. Creating + ending a pool per
     * lookup leaks connections under load and slows Samsara event routing
     * significantly.
     */
    async findGroupByUnit(unitNumber) {
        if (!unitNumber) return null;
        if (!pgPool) {
            console.warn('[DB] DATABASE_URL not set — cannot perform dynamic group lookup.');
            return null;
        }

        try {
            const query = `
                SELECT telegram_group_id, group_name
                FROM groups
                WHERE group_type = 'driver'
                AND group_name ~* $1
                ORDER BY id DESC LIMIT 1
            `;
            const cleanUnit = String(unitNumber).replace(/\D/g, '');
            if (!cleanUnit) return null;
            const regexPattern = `#\\s*${cleanUnit}\\y`;
            const res = await pgPool.query(query, [regexPattern]);

            if (res.rows.length > 0) {
                console.log(`[DB] Resolved Unit #${cleanUnit} to group: ${res.rows[0].group_name} (${res.rows[0].telegram_group_id})`);
                return res.rows[0].telegram_group_id;
            }

            console.log(`[DB] No specific group found for Unit #${cleanUnit}`);
            return null;
        } catch (err) {
            console.error('[DB] Postgres lookup error:', err.message);
            return null;
        }
    },

    async initPgDb() {
        if (pgPool) {
            try {
                await pgPool.query(`CREATE TABLE IF NOT EXISTS samsara_processed_events (
                    id VARCHAR(255) PRIMARY KEY,
                    processed_at TIMESTAMP DEFAULT NOW()
                )`);
                await pgPool.query(`CREATE TABLE IF NOT EXISTS samsara_poll_state (
                    key VARCHAR(120) PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                )`);
                console.log('[DB] PostgreSQL deduplication table ready.');
            } catch (err) {
                console.error('[DB] Failed to init pg table:', err.message);
            }
        }
    },

    async isEventProcessed(eventId) {
        if (!pgPool) return false;
        try {
            const res = await pgPool.query('SELECT id FROM samsara_processed_events WHERE id = $1', [eventId]);
            return res.rows.length > 0;
        } catch (err) {
            console.error('[DB] isEventProcessed error:', err.message);
            return false;
        }
    },

    async markEventProcessed(eventId) {
        if (!pgPool) return;
        try {
            await pgPool.query('INSERT INTO samsara_processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
        } catch (err) {
            console.error('[DB] markEventProcessed error:', err.message);
        }
    },
};
