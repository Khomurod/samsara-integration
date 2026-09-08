/**
 * videoRetryDelivery.js
 *
 * The alert side of "the dashcam clip is not ready yet".
 *
 * The alert is NEVER held back for video: `enqueueFormattedAlert` queues it
 * immediately, text-only when there is no clip, and attaches a `videoBackfill`
 * descriptor the delivery layer turns into a DURABLE recovery job once the
 * messages have actually been sent (src/videoRecoveryStore.js).
 *
 * The Samsara HTTP calls themselves live in ./cameraMediaRetrieval.js — one
 * round trip per function, no sleeping — because pacing and giving up belong to
 * the durable worker. The wrappers kept here are the convenience flow used when
 * a caller genuinely wants "ask and wait" in one call, and they are what the
 * speeding poller's own resolver is built on.
 */
const {
  fetchSafetyEventDetailFromApi,
  mergeSafetyEventDetail,
  extractVideoUrlsFromSafetyEvent,
} = require('./safetyEventMedia');
const {
  buildRetrievalWindow,
  requestVideoRetrieval,
  listCameraMediaUrls,
  fetchRetrievalMediaUrls,
} = require('./cameraMediaRetrieval');

const DEFAULT_DELAY_MS = 300_000; // 5 minutes — the admin-panel default
// A floor only, to stop a mis-set value becoming a tight loop. There is
// deliberately NO ceiling any more: the old 3-minute cap silently overrode the
// operator's chosen delay, so a 5-minute setting could never actually be
// honoured. The wait is durable now, so a long one costs nothing.
const MIN_DELAY_MS = 5_000;
const DEFAULT_RETRIEVAL_POLLS = 8;
const DEFAULT_RETRIEVAL_POLL_INTERVAL_MS = 15_000;

function isVideoRetryEnabled() {
  return process.env.SAMSARA_VIDEO_RETRY_ENABLED !== 'false';
}

/**
 * The environment's idea of the initial re-check delay.
 *
 * The DATABASE is the real source now (samsara_settings, via
 * src/samsaraSettings.js); this remains the fallback for a deployment that has
 * not run the migration, and the floor is the only clamp left.
 */
function getVideoRetryDelayMs() {
  const parsed = parseInt(process.env.SAMSARA_VIDEO_RETRY_DELAY_MS || String(DEFAULT_DELAY_MS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DELAY_MS;
  return Math.max(MIN_DELAY_MS, parsed);
}

function patchAlertVideoUrls(formattedAlert, urls) {
  if (!formattedAlert || !urls) return formattedAlert;
  if (urls.forwardUrl) formattedAlert.videoUrl = urls.forwardUrl;
  if (urls.inwardUrl) formattedAlert.inwardVideoUrl = urls.inwardUrl;
  return formattedAlert;
}

async function refetchVideoUrls(eventId, apiKey, baseUrl) {
  const detailed = await fetchSafetyEventDetailFromApi(eventId, apiKey, baseUrl);
  const merged = mergeSafetyEventDetail({ id: eventId }, detailed);
  return extractVideoUrlsFromSafetyEvent(merged);
}

/**
 * The retrieval window for an event.
 *
 * Kept under its original name because callers and tests know it, but it is now
 * `buildRetrievalWindow` — which is the fix: this used to return
 * `startTime === endTime` for any event reporting a single instant, and Samsara
 * cannot produce a clip of no duration.
 */
function inferVideoRetrievalParams(rawEvent, options = {}) {
  return buildRetrievalWindow(rawEvent, options);
}

/**
 * Ask for footage, then poll until it appears or the budget runs out.
 *
 * This is the "one call does everything" convenience path. The durable worker
 * does NOT use it — it persists the retrieval id and comes back later, so a
 * restart mid-wait loses nothing.
 */
async function pollRetrievedVideoUrls({
  vehicleId,
  startTime,
  endTime,
  apiKey,
  baseUrl,
  retrievalId = null,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPolls = DEFAULT_RETRIEVAL_POLLS,
  pollIntervalMs = DEFAULT_RETRIEVAL_POLL_INTERVAL_MS,
}) {
  if (!vehicleId || !startTime || !endTime || !apiKey) {
    return { forwardUrl: null, inwardUrl: null };
  }

  for (let i = 0; i < maxPolls; i++) {
    if (pollIntervalMs > 0) {
      await sleepImpl(pollIntervalMs);
    }
    try {
      if (retrievalId) {
        const byId = await fetchRetrievalMediaUrls({ retrievalId, apiKey, baseUrl, fetchImpl });
        if (byId.forwardUrl || byId.inwardUrl) return { forwardUrl: byId.forwardUrl, inwardUrl: byId.inwardUrl };
      }
      const listed = await listCameraMediaUrls({ vehicleId, startTime, endTime, apiKey, baseUrl, fetchImpl });
      if (listed.forwardUrl || listed.inwardUrl) return listed;
    } catch (err) {
      console.warn('[VideoRetry] Retrieval polling attempt failed:', err.message);
    }
  }

  return { forwardUrl: null, inwardUrl: null };
}

async function runVideoRetrievalFlow(rawEvent, { apiKey, baseUrl, window = {} } = {}) {
  const params = inferVideoRetrievalParams(rawEvent, window);
  if (!params || !apiKey) return { forwardUrl: null, inwardUrl: null };
  const requested = await requestVideoRetrieval({ ...params, apiKey, baseUrl });
  if (requested.urls?.forwardUrl || requested.urls?.inwardUrl) return requested.urls;
  return pollRetrievedVideoUrls({ ...params, retrievalId: requested.retrievalId, apiKey, baseUrl });
}

/**
 * Queue a formatted alert for IMMEDIATE delivery.
 *
 * The notification is never held back waiting for video. When the clip is
 * missing and recovery is enabled we attach a `videoBackfill` descriptor; the
 * delivery layer reads it AFTER the alert is sent and writes a durable recovery
 * job (see index.js → src/videoRecoveryWorker.js), so the wait survives a
 * restart or a redeploy.
 */
function enqueueFormattedAlert(formattedAlert, rawEvent, queueAlert, options = {}) {
  if (!formattedAlert) return;

  const eventId = rawEvent?.id || null;
  if (eventId) {
    formattedAlert.samsaraEventId = eventId;
  }

  const hasVideo = Boolean(formattedAlert.videoUrl || formattedAlert.inwardVideoUrl);
  if (!hasVideo && eventId && isVideoRetryEnabled()) {
    formattedAlert.videoBackfill = {
      eventId,
      rawEvent,
      refetchFn: options.refetchFn || null,
      retrievalFn: options.retrievalFn || null,
      delayMs: options.delayMs,
    };
  }

  queueAlert(formattedAlert);
}

module.exports = {
  isVideoRetryEnabled,
  getVideoRetryDelayMs,
  patchAlertVideoUrls,
  refetchVideoUrls,
  inferVideoRetrievalParams,
  requestVideoRetrieval,
  pollRetrievedVideoUrls,
  runVideoRetrievalFlow,
  enqueueFormattedAlert,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
};
