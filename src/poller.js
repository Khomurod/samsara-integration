/**
 * poller.js
 * Polls the Samsara API for new safety events using cursor-based pagination.
 * Ensures that no events are dropped even if the server restarts.
 * Sends raw events to the formatter and pushes them to a local queue.
 */

const {
    getCursor,
    saveCursor,
    clearCursor,
    isEventProcessed,
    markEventProcessed,
    getPollWatermark,
    savePollWatermark,
} = require('./db');
const { formatAlert } = require('./formatter');
const { reverseGeocode } = require('./geocoder');
const { enrichSafetyEventWithMediaIfNeeded } = require('./safetyEventMedia');
const { enqueueFormattedAlert } = require('./videoRetryDelivery');

const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
const SAMSARA_API_BASE = process.env.SAMSARA_API_BASE || 'https://api.samsara.com';
const PREVENT_POLL_OVERLAP = process.env.SAMSARA_PREVENT_POLL_OVERLAP !== 'false';
const USE_POLL_WATERMARK = process.env.SAMSARA_POLL_USE_WATERMARK !== 'false';
const ENABLE_POLL_METRICS = process.env.SAMSARA_POLL_METRICS !== 'false';
// Intentionally hardcoded for reliable late-event capture; no env override.
const POLL_BOOTSTRAP_WINDOW_MS = 86_400_000; // 24 hours
const POLL_WATERMARK_OVERLAP_MS = 7_200_000; // 2 hours
const MAX_ALERT_QUEUE = parseInt(process.env.SAMSARA_QUEUE_MAX || '100', 10);

// ── Rate-Limited Telegram Queue ─────────────────────────────────────────────
// Telegram has limits (usually ~30 msgs/sec globally, and ~20 msgs/min per group).
// To prevent hitting error 429 Too Many Requests, especially if the bot wakes up 
// after being asleep and pulls 50 events, we queue them.
const ALERT_QUEUE = [];
let isProcessingQueue = false;
let broadcastFn = null;
let droppedAlertsCount = 0;

// Keep track of recently seen event IDs to prevent duplicates if the cursor
// hasn't updated yet or if we fall back to time-based polling.
const SEEN_IDS = new Set();
// In-flight deliveries (picked up but not yet marked processed in DB).
const PENDING_DELIVERY_IDS = new Set();
const MAX_SEEN_IDS = parseInt(process.env.SAMSARA_SEEN_IDS_MAX || '500', 10);

async function noteEventDelivered(eventId) {
    if (!eventId) return;
    await markEventProcessed(eventId);
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

function isIsoTimestamp(value) {
    return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value);
}

/**
 * Push formatted alerts into the queue to be sent.
 * @param {Object} formattedAlert 
 */
function queueAlert(formattedAlert) {
    if (!formattedAlert) return;
    if (ALERT_QUEUE.length >= MAX_ALERT_QUEUE) {
        ALERT_QUEUE.shift();
        droppedAlertsCount += 1;
        console.warn(`[Queue] Queue limit reached (${MAX_ALERT_QUEUE}). Dropping oldest alert. Total dropped: ${droppedAlertsCount}`);
    }
    ALERT_QUEUE.push(formattedAlert);
    if (!isProcessingQueue) {
        processQueue();
    }
}

/**
 * Process the queue sequentially with a delay between each message.
 */
async function processQueue() {
    if (ALERT_QUEUE.length === 0) {
        isProcessingQueue = false;
        return; // Done
    }
    
    isProcessingQueue = true;
    const alert = ALERT_QUEUE.shift(); // Get oldest
    
    const eventId = alert?.samsaraEventId || null;

    if (broadcastFn) {
        try {
            await broadcastFn(alert);
            await noteEventDelivered(eventId);
        } catch (err) {
            noteEventDeliveryFailed(eventId);
            console.error('[Queue] Delivery failed, will retry on next poll:', err.message);
        }
    } else {
        console.warn('[Queue] No broadcastFn set. Dropping alert.');
        noteEventDeliveryFailed(eventId);
    }
    
    // Wait 2000ms before sending the next one (Rate Limiting)
    setTimeout(processQueue, 2000);
}


// ── Transformation / Formatting ───────────────────────────────────────────────
// Move the formatting logic previously locked inside the webhook express route
// directly into the poller.

/**
 * Re-formats the raw v2 API event into the shape the webhook formatter expects.
 * Adapts mergeEnrichedData from the old webhook.js into a direct transform.
 */
async function transformApiEventToWebhookShape(rawEvent) {
    const { event, forwardUrl, inwardUrl } = await enrichSafetyEventWithMediaIfNeeded(
        rawEvent,
        SAMSARA_API_KEY,
        SAMSARA_API_BASE
    );

    // Mimic the webhook envelope
    const happenedAtTime = event.time || event.happenedAtTime || new Date().toISOString();
    
    // Robust Vehicle extraction
    const vehicleObj = event.asset || event.vehicle || {};
    const vehicleName = vehicleObj.name || 'Unknown Unit';
    const vehicleId   = vehicleObj.id   || null;

    const webhookPayload = {
        eventType: 'AlertIncident',
        eventTime: happenedAtTime,
        data: {
            happenedAtTime,
            incidentUrl: event.incidentUrl || null,
            conditions: [{
                description: 'A safety event occurred',
                details: {
                    harshEvent: {
                        vehicle: vehicleId ? { id: vehicleId, name: vehicleName } : undefined,
                    }
                }
            }]
        }
    };

    const condition = webhookPayload.data.conditions[0];
    const details = condition.details;

    // Specific event type
    const behaviorLabel =
        event.behaviorLabels?.[0]?.label ||
        event.behaviorLabel ||
        event.type ||
        event.safetyEventType ||
        null;
    if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

    if (forwardUrl) {
        details.harshEvent.mediaUrl = forwardUrl;
        webhookPayload._enrichedVideoUrl = forwardUrl;
    }
    if (inwardUrl) {
        webhookPayload._enrichedVideoUrlInward = inwardUrl;
    }

    // Location
    const loc = event.location || null;
    if (loc?.latitude != null) {
        const addr = loc.address;
        let formatted = addr
            ? [addr.street || addr.streetAddress, addr.city, addr.state].filter(Boolean).join(', ')
            : null;
        
        // Enrichment: If Samsara didn't provide an address, try reverse geocoding
        if (!formatted) {
            formatted = await reverseGeocode(loc.latitude, loc.longitude);
        }

        details.harshEvent.location = {
            latitude: loc.latitude,
            longitude: loc.longitude,
            formattedLocation: formatted,
        };
    }

    // Speed — try multiple field locations across Samsara API versions
    const speedKph = event.speedingMetadata?.maxSpeedKilometersPerHour
        ?? event.speedKilometersPerHour
        ?? event.behaviorLabels?.[0]?.speedKilometersPerHour
        ?? null;
    const limitKph = event.speedingMetadata?.postedSpeedLimitKilometersPerHour
        ?? event.speedLimitKilometersPerHour
        ?? null;
    if (speedKph != null) {
        details.speed = {
            currentSpeedKilometersPerHour:   speedKph,
            thresholdSpeedKilometersPerHour: limitKph,
        };
    }

    // Severity — root-level first, then per-label field inside behaviorLabels
    const severityVal = event.severity || event.behaviorLabels?.[0]?.severity;
    if (severityVal) {
        if (!details.safetyEvent) details.safetyEvent = {};
        details.safetyEvent.severity = severityVal;
    }
    // behaviorLabels[0].type encodes severity in its name (e.g. "FollowingDistanceModerate");
    // store it so the formatter's keyword fallback can extract the severity level.
    const behaviorType = event.behaviorLabels?.[0]?.type;
    if (behaviorType) webhookPayload._enrichedBehaviorType = behaviorType;

    const gForce = event.maxAccelerationGForce ?? event.maxGForce ?? event.gForce ?? null;
    if (gForce != null) {
        details.harshEvent.gForce = gForce;
    }

    // Driver
    const driverObj = event.driver || {};
    if (driverObj.name) {
        details.harshEvent.driver = { name: driverObj.name, id: driverObj.id };
    }

    return webhookPayload;
}


// ── Samsara Poller Engine ─────────────────────────────────────────────────────

async function executePoll() {
    if (PREVENT_POLL_OVERLAP && executePoll.isRunning) {
        console.warn('[Poller] Previous poll still running; skipping overlapping tick.');
        return;
    }
    executePoll.isRunning = true;

    if (!SAMSARA_API_KEY) {
        console.warn('[Poller] SAMSARA_API_KEY is not set. Cannot poll.');
        executePoll.isRunning = false;
        return;
    }

    const rawCursor = (getCursor() || '').trim();
    const cursor = isIsoTimestamp(rawCursor) ? '' : rawCursor;
    const params = new URLSearchParams({
        includeDriver: 'true',
        limit: '100',
    });

    // Mandatory: Samsara Safety Events endpoint REQUIRES startTime/endTime.
    // We use a persisted watermark with overlap to avoid repeatedly scanning a large fixed window.
    const endTime = new Date().toISOString();
    const watermark = USE_POLL_WATERMARK ? await getPollWatermark() : null;
    const watermarkMs = watermark ? Date.parse(watermark) : NaN;
    const startTime = Number.isFinite(watermarkMs)
        ? new Date(Math.max(0, watermarkMs - POLL_WATERMARK_OVERLAP_MS)).toISOString()
        : new Date(Date.now() - POLL_BOOTSTRAP_WINDOW_MS).toISOString();
    
    params.set('startTime', startTime);
    params.set('endTime', endTime);

    if (rawCursor && isIsoTimestamp(rawCursor)) {
        // Older builds accidentally persisted timestamp values instead of cursors.
        // Samsara rejects these as an invalid "after" pagination token.
        console.warn(`[Poller] Ignoring invalid timestamp cursor: ${rawCursor}`);
        clearCursor();
    }

    if (cursor && cursor !== 'null' && cursor !== 'undefined') {
        params.set('after', cursor);
        console.log(`[Poller] Requesting events since cursor: ${cursor}`);
    } else {
        console.log(`[Poller] No valid cursor found. Fetching fresh window from: ${startTime}`);
    }

    const url = `${SAMSARA_API_BASE}/fleet/safety-events?${params.toString()}`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${SAMSARA_API_KEY}`,
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            const body = await response.text();
            console.error(`[Poller] HTTP ${response.status}: ${body}`);
            if (response.status === 400 && body.includes(`invalid pagination 'after' parameter`)) {
                console.warn('[Poller] Clearing invalid cursor so next poll uses time window only.');
                clearCursor();
            }
            executePoll.isRunning = false;
            return;
        }

        let json = await response.json();
        const events = json.data || [];
        const nextCursor = json.pagination?.endCursor;
        json = null;

        if (events.length > 0) {
            let newEventsCount = 0;
            for (const rawEvent of events) {
                // In-memory dedup: delivered or already queued for delivery
                if (SEEN_IDS.has(rawEvent.id) || PENDING_DELIVERY_IDS.has(rawEvent.id)) continue;

                // Permanent PostgreSQL dedup (successfully delivered in a prior run)
                if (await isEventProcessed(rawEvent.id)) {
                    SEEN_IDS.add(rawEvent.id);
                    continue;
                }

                PENDING_DELIVERY_IDS.add(rawEvent.id);
                newEventsCount++;
                const mappedPayload = await transformApiEventToWebhookShape(rawEvent);
                const formattedMessage = formatAlert(mappedPayload);
                
                // Pass metadata for dynamic routing
                formattedMessage.vehicleName = rawEvent.vehicle?.name || rawEvent.asset?.name || '';
                formattedMessage.vehicleId = rawEvent.vehicle?.id || rawEvent.asset?.id || null;
                formattedMessage.driverName = rawEvent.driver?.name || null;
                
                enqueueFormattedAlert(formattedMessage, rawEvent, queueAlert);
            }
            
            if (newEventsCount > 0) {
                console.log(`[Poller] Picked up ${newEventsCount} new event(s).`);
            }
        } else {
            // Uncomment if you want noisy logs
            // console.log(`[Poller] No new events.`);
        }

        // Save the cursor for the next run, even if no events were found
        // Samsara provides a new timestamp cursor to prevent querying the same window.
        if (nextCursor) {
            saveCursor(nextCursor);
        }
        if (USE_POLL_WATERMARK) {
            await savePollWatermark(endTime);
        }

    } catch (err) {
        console.error('[Poller] Fetch error:', err.message);
    } finally {
        executePoll.isRunning = false;
    }
}

// ── Exported API ──────────────────────────────────────────────────────────────

let intervalId = null;
let metricsIntervalId = null;

/** @internal Test hook: process one queued alert without inter-alert delay. */
async function processNextQueuedAlertForTest() {
    if (ALERT_QUEUE.length === 0) return { processed: false };

    const alert = ALERT_QUEUE.shift();
    const eventId = alert?.samsaraEventId || null;

    if (!broadcastFn) {
        noteEventDeliveryFailed(eventId);
        return { processed: true, delivered: false, eventId };
    }

    try {
        await broadcastFn(alert);
        await noteEventDelivered(eventId);
        return { processed: true, delivered: true, eventId };
    } catch (err) {
        noteEventDeliveryFailed(eventId);
        return { processed: true, delivered: false, eventId, error: err.message };
    }
}

function enqueueAlertForTest(formattedAlert) {
    if (!formattedAlert) return;
    ALERT_QUEUE.push(formattedAlert);
}

function resetDeliveryStateForTest() {
    SEEN_IDS.clear();
    PENDING_DELIVERY_IDS.clear();
    ALERT_QUEUE.length = 0;
    isProcessingQueue = false;
}

module.exports = {
    /**
     * Set the function that actually sends the message via the Telegram Bot.
     * @param {Function} fn 
     */
    setBroadcastFn(fn) {
        broadcastFn = fn;
    },

    executePoll,

    _forTest: {
        enqueueAlertForTest,
        processNextQueuedAlertForTest,
        resetDeliveryStateForTest,
        getPendingDeliveryIds: () => new Set(PENDING_DELIVERY_IDS),
        getSeenIds: () => new Set(SEEN_IDS),
    },

    /**
     * Stop polling gracefully.
     */
    stop() {
        console.log('[Poller] Stopped API polling loop.');
    }
};
