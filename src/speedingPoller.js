/**
 * speedingPoller.js
 * Polls Samsara v2 /safety-events/stream for speeding labels only.
 * Keeps isolated state/dedup so legacy /fleet/safety-events flow is untouched.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { formatAlert } = require('./formatter');
const { reverseGeocode } = require('./geocoder');
const { enqueueFormattedAlert } = require('./videoRetryDelivery');
const { loadSamsaraConfig } = require('./samsaraSettings');

// ── The Samsara credential, base URL and the speeding switch ─────────────────
// MUTABLE, and `executePoll` is their only writer. They start as the
// environment variables this service has always used and are refreshed from the
// admin-panel settings row at the top of every poll, so replacing the API key
// or turning speeding events off in the panel takes effect within a cycle
// instead of needing a redeploy.
let SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
let SAMSARA_API_BASE = process.env.SAMSARA_API_BASE || 'https://api.samsara.com';
let SPEEDING_ENABLED = process.env.SAMSARA_SPEEDING_ENABLED !== 'false';

async function refreshRuntimeConfig() {
  try {
    const cfg = await loadSamsaraConfig();
    if (cfg.apiKey) SAMSARA_API_KEY = cfg.apiKey;
    if (cfg.apiBase) SAMSARA_API_BASE = cfg.apiBase;
    // The env var stays a veto: a deployment that turned speeding off there
    // must not be silently re-enabled by a database default.
    SPEEDING_ENABLED = process.env.SAMSARA_SPEEDING_ENABLED !== 'false'
      && cfg.speedingEventsEnabled !== false
      && cfg.enabled !== false;
    return cfg;
  } catch (err) {
    console.warn('[SpeedPoller] Could not refresh Samsara settings:', err.message);
    return null;
  }
}
const ENABLE_METRICS = process.env.SAMSARA_POLL_METRICS !== 'false';
const POLL_BOOTSTRAP_WINDOW_MS = 86_400_000;
const POLL_WATERMARK_OVERLAP_MS = 7_200_000;
const MAX_ALERT_QUEUE = parseInt(process.env.SAMSARA_QUEUE_MAX || '200', 10);

const SPEEDING_LABELS = [
  'SevereSpeeding',
  'HeavySpeeding',
  'ModerateSpeeding',
  'LightSpeeding',
  'Speeding',
];

const CURSOR_KEY = 'speeding_stream_cursor';
const WATERMARK_KEY = 'speeding_stream_last_end_time';
const PROCESSED_PREFIX = 'speed:';

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_JSON = path.join(DATA_DIR, 'speeding-stream-state.json');

let pgPool = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

const ALERT_QUEUE = [];
let isProcessingQueue = false;
let broadcastFn = null;
let droppedAlertsCount = 0;

// ── Observability only (read by the /health endpoint) ──────────────────────
// These NEVER influence polling, delivery, dedup, or DB behaviour.
let lastSuccessfulPollAt = null; // ms epoch of the last successful stream poll
let lastPollEndTime = null;      // ISO endTime of the last successful stream poll
let lastApiError = null;         // { code, message, at } — sanitized before it leaves /health

const SEEN_IDS = new Set();
const PENDING_DELIVERY_IDS = new Set();
const MAX_SEEN_IDS = 1000;

const vehicleNameCache = new Map();
const VEHICLE_CACHE_TTL_MS = 10 * 60 * 1000;

let intervalId = null;
let metricsIntervalId = null;

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
  if (pgPool) {
    try {
      const res = await pgPool.query('SELECT value FROM samsara_poll_state WHERE key = $1', [key]);
      return res.rows[0]?.value || null;
    } catch (err) {
      console.error('[SpeedPoller] getPollState error:', err.message);
      return null;
    }
  }
  const state = getJsonState();
  return state[key] || null;
}

async function savePollState(key, value) {
  if (!value) return;
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO samsara_poll_state (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
      return;
    } catch (err) {
      console.error('[SpeedPoller] savePollState error:', err.message);
      return;
    }
  }
  saveJsonState({ [key]: value, updated_at: new Date().toISOString() });
}

async function isSpeedingEventProcessed(eventId) {
  if (!eventId) return false;
  const namespaced = `${PROCESSED_PREFIX}${eventId}`;
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

function queueAlert(formattedAlert) {
  if (!formattedAlert) return;
  if (ALERT_QUEUE.length >= MAX_ALERT_QUEUE) {
    ALERT_QUEUE.shift();
    droppedAlertsCount += 1;
    console.warn(`[SpeedPoller] Queue limit reached (${MAX_ALERT_QUEUE}); dropped=${droppedAlertsCount}`);
  }
  ALERT_QUEUE.push(formattedAlert);
  if (!isProcessingQueue) processQueue();
}

async function noteEventDelivered(eventId) {
  if (!eventId) return;
  await markSpeedingEventProcessed(eventId);
  SEEN_IDS.add(eventId);
  PENDING_DELIVERY_IDS.delete(eventId);
  if (SEEN_IDS.size > MAX_SEEN_IDS) {
    const oldest = SEEN_IDS.values().next().value;
    SEEN_IDS.delete(oldest);
  }
}

function noteEventDeliveryFailed(eventId) {
  if (!eventId) return;
  PENDING_DELIVERY_IDS.delete(eventId);
}

async function processQueue() {
  if (ALERT_QUEUE.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const alert = ALERT_QUEUE.shift();
  const eventId = alert?.samsaraEventId || null;

  if (!broadcastFn) {
    console.warn('[SpeedPoller] No broadcastFn set. Dropping alert.');
    noteEventDeliveryFailed(eventId);
    setTimeout(processQueue, 2000);
    return;
  }

  try {
    await broadcastFn(alert);
    await noteEventDelivered(eventId);
  } catch (err) {
    noteEventDeliveryFailed(eventId);
    console.error('[SpeedPoller] Delivery failed, will retry on next poll:', err.message);
  }

  setTimeout(processQueue, 2000);
}

async function fetchVehicleName(vehicleId, fetchImpl = fetch) {
  if (!vehicleId) return null;
  const now = Date.now();
  const cached = vehicleNameCache.get(vehicleId);
  if (cached && cached.expiresAt > now) return cached.name;

  try {
    const res = await fetchImpl(`${SAMSARA_API_BASE}/fleet/vehicles/${vehicleId}`, {
      headers: {
        Authorization: `Bearer ${SAMSARA_API_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body}`);
    }
    const json = await res.json();
    const name = json.data?.name || null;
    vehicleNameCache.set(vehicleId, { name, expiresAt: now + VEHICLE_CACHE_TTL_MS });
    return name;
  } catch (err) {
    console.warn('[SpeedPoller] Vehicle lookup failed:', err.message);
    return null;
  }
}

async function transformV2SpeedEvent(rawEvent, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const reverseGeocodeFn = options.reverseGeocodeFn || reverseGeocode;

  const vehicleId = rawEvent.asset?.id || rawEvent.vehicle?.id || null;
  const vehicleName = rawEvent.asset?.name || rawEvent.vehicle?.name || await fetchVehicleName(vehicleId, fetchImpl) || 'Unknown Unit';
  const happenedAtTime = rawEvent.startMs || rawEvent.time || rawEvent.createdAtTime || new Date().toISOString();

  const webhookPayload = {
    eventType: 'AlertIncident',
    eventTime: happenedAtTime,
    data: {
      happenedAtTime,
      incidentUrl: rawEvent.inboxEventUrl || rawEvent.incidentReportUrl || rawEvent.incidentUrl || null,
      conditions: [{
        description: 'A safety event occurred',
        details: {
          harshEvent: {
            vehicle: vehicleId ? { id: vehicleId, name: vehicleName } : undefined,
          },
        },
      }],
    },
  };

  const details = webhookPayload.data.conditions[0].details;
  const behaviorLabel = rawEvent.behaviorLabels?.[0]?.label || rawEvent.behaviorLabels?.[0]?.name || rawEvent.behaviorLabel || rawEvent.type || rawEvent.safetyEventType || null;
  if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

  const speedKph = rawEvent.speedingMetadata?.maxSpeedKilometersPerHour ?? rawEvent.speedKilometersPerHour ?? null;
  const limitKph = rawEvent.speedingMetadata?.postedSpeedLimitKilometersPerHour ?? rawEvent.speedLimitKilometersPerHour ?? null;
  if (speedKph != null) {
    details.speed = {
      currentSpeedKilometersPerHour: speedKph,
      thresholdSpeedKilometersPerHour: limitKph,
    };
  }

  const severityVal = rawEvent.severity || rawEvent.behaviorLabels?.[0]?.severity;
  if (severityVal) {
    details.safetyEvent = { ...(details.safetyEvent || {}), severity: severityVal };
  }

  const behaviorType = rawEvent.behaviorLabels?.[0]?.type;
  if (behaviorType) webhookPayload._enrichedBehaviorType = behaviorType;

  const loc = rawEvent.location;
  if (loc?.latitude != null) {
    const addr = loc.address;
    let formatted = addr ? [addr.street || addr.streetAddress, addr.city, addr.state].filter(Boolean).join(', ') : null;
    if (!formatted) formatted = await reverseGeocodeFn(loc.latitude, loc.longitude);
    details.harshEvent.location = {
      latitude: loc.latitude,
      longitude: loc.longitude,
      formattedLocation: formatted,
    };
  }

  const derivedDriver = String(vehicleName || '').replace(/^\s*#?\s*\d+\s*/, '').trim();
  if (derivedDriver) {
    details.harshEvent.driver = { name: derivedDriver };
  }

  return {
    payload: webhookPayload,
    vehicleName,
    vehicleId,
    driverName: derivedDriver || null,
  };
}

async function fetchSpeedingEventsPage({ startTime, endTime, cursor }) {
  const url = new URL(`${SAMSARA_API_BASE}/safety-events/stream`);
  url.searchParams.set('startTime', startTime);
  url.searchParams.set('endTime', endTime);
  url.searchParams.set('includeDriver', 'true');
  url.searchParams.set('includeAsset', 'true');
  url.searchParams.set('limit', '100');
  url.searchParams.set('behaviorLabels', SPEEDING_LABELS.join(','));
  if (cursor) url.searchParams.set('after', cursor);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${SAMSARA_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  const json = await response.json();
  return {
    events: json.data || [],
    nextCursor: json.pagination?.endCursor || null,
    hasNextPage: !!json.pagination?.hasNextPage,
  };
}

function isSpeedingLike(rawEvent) {
  const labels = rawEvent.behaviorLabels || [];
  const blob = [rawEvent.type, rawEvent.safetyEventType, ...labels.map((l) => l.label), ...labels.map((l) => l.name)].join(' ');
  return /speed/i.test(blob) || !!rawEvent.speedingMetadata;
}

async function executePoll() {
  if (executePoll.isRunning) {
    console.warn('[SpeedPoller] Previous poll still running; skipping overlapping tick.');
    return;
  }
  executePoll.isRunning = true;

  await refreshRuntimeConfig();
  if (!SPEEDING_ENABLED) {
    executePoll.isRunning = false;
    return;
  }
  if (!SAMSARA_API_KEY) {
    console.warn('[SpeedPoller] No Samsara API key (admin panel or SAMSARA_API_KEY). Cannot poll.');
    executePoll.isRunning = false;
    return;
  }

  try {
    const rawCursor = ((await getPollState(CURSOR_KEY)) || '').trim();
    const endTime = new Date().toISOString();
    const watermark = await getPollState(WATERMARK_KEY);
    const watermarkMs = watermark ? Date.parse(watermark) : NaN;
    const startTime = Number.isFinite(watermarkMs)
      ? new Date(Math.max(0, watermarkMs - POLL_WATERMARK_OVERLAP_MS)).toISOString()
      : new Date(Date.now() - POLL_BOOTSTRAP_WINDOW_MS).toISOString();

    let cursor = rawCursor || '';
    let pages = 0;
    let totalQueued = 0;

    while (pages < 2) {
      const { events, nextCursor, hasNextPage } = await fetchSpeedingEventsPage({ startTime, endTime, cursor });

      for (const rawEvent of events) {
        if (!rawEvent?.id) continue;
        if (!isSpeedingLike(rawEvent)) continue;
        const eventId = rawEvent.id;

        if (SEEN_IDS.has(eventId) || PENDING_DELIVERY_IDS.has(eventId)) continue;
        if (await isSpeedingEventProcessed(eventId)) {
          SEEN_IDS.add(eventId);
          continue;
        }

        PENDING_DELIVERY_IDS.add(eventId);

        try {
          const transformed = await transformV2SpeedEvent(rawEvent);
          const formatted = formatAlert(transformed.payload);
          formatted.vehicleName = transformed.vehicleName || '';
          formatted.vehicleId = transformed.vehicleId || null;
          formatted.driverName = transformed.driverName || null;
          formatted.samsaraEventId = eventId;
          // Tag as a speeding event so the delivery layer can scope the
          // driver-group music overlay to speeding videos only. The Samsara
          // notifications group is unaffected regardless of this flag.
          formatted.isSpeeding = true;

          const directVideoUrl = rawEvent.downloadForwardVideoUrl || rawEvent.media?.[0]?.url || null;
          if (directVideoUrl) {
            formatted.videoUrl = directVideoUrl;
            formatted.inwardVideoUrl = null;
          }

          // No video yet? The alert still goes out now, and a DURABLE recovery
          // job resolves the clip later — see src/videoRecoveryWorker.js. This
          // used to hand in its own refetch/retrieval closures, a second
          // implementation of the camera calls that has since been consolidated
          // into src/cameraMediaRetrieval.js and, unlike this one, survives a
          // restart.
          enqueueFormattedAlert(formatted, rawEvent, queueAlert);

          totalQueued += 1;
        } catch (eventErr) {
          noteEventDeliveryFailed(eventId);
          console.error(`[SpeedPoller] Failed processing speed event ${eventId}:`, eventErr.message);
        }
      }

      pages += 1;
      if (nextCursor) {
        await savePollState(CURSOR_KEY, nextCursor);
        cursor = nextCursor;
      }

      if (!hasNextPage) break;
    }

    await savePollState(WATERMARK_KEY, endTime);

    // Observability: the stream poll completed its page scan successfully.
    // Recorded for /health staleness detection.
    lastSuccessfulPollAt = Date.now();
    lastPollEndTime = endTime;

    if (totalQueued > 0) {
      console.log(`[SpeedPoller] Picked up ${totalQueued} new speeding event(s).`);
    }
  } catch (err) {
    console.error('[SpeedPoller] Fetch error:', err.message);
    lastApiError = { code: 'STREAM_ERROR', message: String(err.message).slice(0, 500), at: new Date().toISOString() };
  } finally {
    executePoll.isRunning = false;
  }
}

module.exports = {
  setBroadcastFn(fn) {
    broadcastFn = fn;
  },

  executePoll,

  /**
   * Read-only operational snapshot for the /health endpoint. Contains no
   * secrets and never mutates poller state.
   */
  getStatus() {
    return {
      enabled: SPEEDING_ENABLED,
      lastSuccessAt: lastSuccessfulPollAt,
      lastPollEndTime,
      lastApiError,
      queueSize: ALERT_QUEUE.length,
      droppedAlerts: droppedAlertsCount,
    };
  },

  start(intervalMs = 15000) {
    if (!SPEEDING_ENABLED) {
      console.log('[SpeedPoller] Disabled by SAMSARA_SPEEDING_ENABLED=false');
      return;
    }
  },

  stop() {
    console.log('[SpeedPoller] Stopped v2 speed polling loop.');
  },

  _forTest: {
    transformV2SpeedEvent,
    isSpeedingLike,
    resetState() {
      ALERT_QUEUE.length = 0;
      isProcessingQueue = false;
      SEEN_IDS.clear();
      PENDING_DELIVERY_IDS.clear();
      vehicleNameCache.clear();
    },
  },
};
