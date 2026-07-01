/**
 * Defer Telegram delivery when dashcam video is missing on first Samsara fetch,
 * then refetch once after a delay and queue the alert with video if available.
 */
const {
  fetchSafetyEventDetailFromApi,
  mergeSafetyEventDetail,
  extractVideoUrlsFromSafetyEvent,
} = require('./safetyEventMedia');

const DEFAULT_DELAY_MS = 60_000;
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 180_000;
const DEFAULT_RETRIEVAL_POLLS = 8;
const DEFAULT_RETRIEVAL_POLL_INTERVAL_MS = 15_000;

function isVideoRetryEnabled() {
  return process.env.SAMSARA_VIDEO_RETRY_ENABLED !== 'false';
}

function getVideoRetryDelayMs() {
  const parsed = parseInt(process.env.SAMSARA_VIDEO_RETRY_DELAY_MS || String(DEFAULT_DELAY_MS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, parsed));
}

function shouldDeferVideoRetry(formattedAlert, eventId) {
  if (!isVideoRetryEnabled()) return false;
  if (!eventId) return false;
  if (!formattedAlert || typeof formattedAlert !== 'object') return false;
  if (formattedAlert.videoUrl || formattedAlert.inwardVideoUrl) return false;
  return true;
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

function toIsoTime(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function inferVideoRetrievalParams(rawEvent) {
  const vehicleId = rawEvent?.asset?.id || rawEvent?.vehicle?.id || null;
  const startCandidate = rawEvent?.startMs || rawEvent?.time || rawEvent?.happenedAtTime || rawEvent?.createdAtTime || null;
  const endCandidate = rawEvent?.endMs || rawEvent?.updatedAtTime || rawEvent?.time || rawEvent?.happenedAtTime || rawEvent?.createdAtTime || null;
  const startParsed = Date.parse(String(startCandidate || ''));
  const endParsed = Date.parse(String(endCandidate || ''));
  const fallbackStartMs = Number.isFinite(startParsed) ? startParsed : endParsed;
  const startTime = Number.isFinite(fallbackStartMs) ? new Date(fallbackStartMs).toISOString() : toIsoTime(startCandidate);
  const endBaseMs = Number.isFinite(endParsed)
    ? endParsed
    : (Number.isFinite(startParsed) ? startParsed : NaN);
  const safeEndMs = Number.isFinite(startParsed) && Number.isFinite(endBaseMs)
    ? Math.max(startParsed, endBaseMs)
    : endBaseMs;
  const endTime = Number.isFinite(safeEndMs) ? new Date(safeEndMs).toISOString() : toIsoTime(endCandidate);

  if (!vehicleId || !startTime || !endTime) return null;
  return { vehicleId, startTime, endTime };
}

async function requestVideoRetrieval({
  vehicleId,
  startTime,
  endTime,
  apiKey,
  baseUrl,
  fetchImpl = fetch,
}) {
  if (!vehicleId || !startTime || !endTime || !apiKey) return false;
  const base = (baseUrl || 'https://api.samsara.com').replace(/\/$/, '');
  const res = await fetchImpl(`${base}/cameras/media/retrieval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vehicleId,
      startTime,
      endTime,
      mediaType: 'videoHighRes',
      inputs: ['dashcamRoadFacing', 'dashcamDriverFacing'],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`retrieval ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

async function pollRetrievedVideoUrls({
  vehicleId,
  startTime,
  endTime,
  apiKey,
  baseUrl,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPolls = DEFAULT_RETRIEVAL_POLLS,
  pollIntervalMs = DEFAULT_RETRIEVAL_POLL_INTERVAL_MS,
}) {
  if (!vehicleId || !startTime || !endTime || !apiKey) {
    return { forwardUrl: null, inwardUrl: null };
  }

  const base = (baseUrl || 'https://api.samsara.com').replace(/\/$/, '');
  const queryStart = new Date(Date.parse(startTime) - 60_000).toISOString();
  const queryEnd = new Date(Date.parse(endTime) + 120_000).toISOString();

  for (let i = 0; i < maxPolls; i++) {
    if (pollIntervalMs > 0) {
      await sleepImpl(pollIntervalMs);
    }

    const url = new URL(`${base}/cameras/media`);
    url.searchParams.set('vehicleIds', vehicleId);
    url.searchParams.set('startTime', queryStart);
    url.searchParams.set('endTime', queryEnd);
    url.searchParams.append('mediaTypes', 'videoHighRes');
    url.searchParams.append('inputs', 'dashcamRoadFacing');
    url.searchParams.append('inputs', 'dashcamDriverFacing');

    try {
      const res = await fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`media list ${res.status}: ${text.slice(0, 200)}`);
      }

      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      const mediaRows = json.data?.media || [];
      const forward = mediaRows.find((row) =>
        /video/i.test(String(row.mediaType || ''))
        && /road|front|primary/i.test(String(row.input || row.cameraInput || ''))
        && row.urlInfo?.url,
      )?.urlInfo?.url || mediaRows.find((row) =>
        /video/i.test(String(row.mediaType || '')) && row.urlInfo?.url,
      )?.urlInfo?.url || null;
      const inward = mediaRows.find((row) =>
        /video/i.test(String(row.mediaType || ''))
        && /driver|secondary/i.test(String(row.input || row.cameraInput || ''))
        && row.urlInfo?.url,
      )?.urlInfo?.url || null;

      if (forward || inward) return { forwardUrl: forward, inwardUrl: inward };
    } catch (err) {
      console.warn('[VideoRetry] Retrieval polling attempt failed:', err.message);
    }
  }

  return { forwardUrl: null, inwardUrl: null };
}

async function runVideoRetrievalFlow(rawEvent, { apiKey, baseUrl } = {}) {
  const params = inferVideoRetrievalParams(rawEvent);
  if (!params || !apiKey) return { forwardUrl: null, inwardUrl: null };
  await requestVideoRetrieval({ ...params, apiKey, baseUrl });
  return pollRetrievedVideoUrls({ ...params, apiKey, baseUrl });
}

function scheduleVideoRetryDelivery({
  formattedAlert,
  rawEvent,
  eventId,
  queueAlert,
  delayMs,
  apiKey,
  baseUrl,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  refetchFn,
  retrievalFn,
}) {
  const waitMs = Number.isFinite(delayMs) ? delayMs : getVideoRetryDelayMs();
  console.log(`[VideoRetry] deferring event ${eventId} for ${Math.round(waitMs / 1000)}s`);

  const doRefetch = refetchFn
    || (() => refetchVideoUrls(eventId, apiKey, baseUrl));
  const doRetrieval = retrievalFn
    || (() => runVideoRetrievalFlow(rawEvent, { apiKey, baseUrl }));

  setTimer(async () => {
    try {
      let urls = await doRefetch();
      if (urls?.forwardUrl || urls?.inwardUrl) {
        patchAlertVideoUrls(formattedAlert, urls);
        console.log(`[VideoRetry] event ${eventId}: video found after retry`);
      } else {
        console.log(`[VideoRetry] event ${eventId}: no video after retry, starting retrieval`);
        urls = await doRetrieval();
        if (urls?.forwardUrl || urls?.inwardUrl) {
          patchAlertVideoUrls(formattedAlert, urls);
          console.log(`[VideoRetry] event ${eventId}: video found after retrieval`);
        } else {
          console.log(`[VideoRetry] event ${eventId}: still no video after retrieval flow`);
        }
      }
    } catch (err) {
      console.warn(`[VideoRetry] event ${eventId}: video retry flow failed:`, err.message);
    }
    queueAlert(formattedAlert);
  }, waitMs);
}

function enqueueFormattedAlert(formattedAlert, rawEvent, queueAlert, options = {}) {
  if (!formattedAlert) return;

  const eventId = rawEvent?.id || null;
  if (eventId) {
    formattedAlert.samsaraEventId = eventId;
  }

  const apiKey = options.apiKey ?? process.env.SAMSARA_API_KEY;
  const baseUrl = options.baseUrl ?? (process.env.SAMSARA_API_BASE || 'https://api.samsara.com');

  if (!shouldDeferVideoRetry(formattedAlert, eventId)) {
    queueAlert(formattedAlert);
    return;
  }

  scheduleVideoRetryDelivery({
    formattedAlert,
    rawEvent,
    eventId,
    queueAlert,
    delayMs: options.delayMs,
    apiKey,
    baseUrl,
    setTimer: options.setTimer,
    refetchFn: options.refetchFn,
    retrievalFn: options.retrievalFn,
  });
}

module.exports = {
  isVideoRetryEnabled,
  getVideoRetryDelayMs,
  shouldDeferVideoRetry,
  patchAlertVideoUrls,
  refetchVideoUrls,
  inferVideoRetrievalParams,
  requestVideoRetrieval,
  pollRetrievedVideoUrls,
  runVideoRetrievalFlow,
  scheduleVideoRetryDelivery,
  enqueueFormattedAlert,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
};
