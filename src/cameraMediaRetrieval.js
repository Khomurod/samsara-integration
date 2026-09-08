/**
 * cameraMediaRetrieval.js
 *
 * Asking a Samsara dashcam to produce footage, and finding it once it exists.
 *
 * TWO BUGS THIS MODULE EXISTS TO FIX.
 *
 * 1. THE ZERO-LENGTH INTERVAL. Both retrieval paths used to build their window
 *    as `startTime = event.startMs || event.time` and
 *    `endTime = event.endMs || event.time` — so any event that reports a single
 *    instant (most of them) asked Samsara for footage from T to T. Samsara
 *    cannot produce a clip of no duration, and the request either failed or
 *    came back empty forever. `buildRetrievalWindow` now always widens to a
 *    real interval around the event, bounded on both sides so a long event
 *    still cannot ask for minutes of footage.
 *
 * 2. THE DUPLICATE REQUEST. Every retry created a NEW retrieval job, because
 *    nothing kept the id of the one already running. `requestVideoRetrieval`
 *    returns the id Samsara issued so the caller can persist it and CHECK that
 *    request next time instead of queueing another.
 *
 * Every function here does ONE round trip and returns. Pacing, retries and
 * giving up belong to the durable worker, not to a sleep loop inside an HTTP
 * helper — that is what made the old flow impossible to resume after a restart.
 */

const DEFAULT_BASE_URL = 'https://api.samsara.com';

/** Samsara's own names for the two cameras. */
const ROAD_INPUT = 'dashcamRoadFacing';
const DRIVER_INPUT = 'dashcamDriverFacing';

const MIN_WINDOW_SECONDS = 5;
const MAX_WINDOW_SECONDS = 600;

function parseMs(value) {
  if (value == null) return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function clampSeconds(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * A GENUINE video interval around a safety event.
 *
 * The event's own start and end are used when it really has two different
 * instants; otherwise the single instant it reports is the anchor. Either way
 * the window is padded by `beforeSeconds` / `afterSeconds` and is guaranteed to
 * be at least MIN_WINDOW_SECONDS long and no more than MAX_WINDOW_SECONDS —
 * long enough for Samsara to produce something, short enough not to ask a truck
 * to upload half an hour of video.
 *
 * @returns {{vehicleId:string, startTime:string, endTime:string, durationSeconds:number}|null}
 *   null when the event carries no vehicle or no usable timestamp at all.
 */
function buildRetrievalWindow(rawEvent, { beforeSeconds = 15, afterSeconds = 45 } = {}) {
  const vehicleId = rawEvent?.asset?.id || rawEvent?.vehicle?.id || null;
  if (!vehicleId) return null;

  const before = clampSeconds(beforeSeconds, 0, MAX_WINDOW_SECONDS, 15);
  const after = clampSeconds(afterSeconds, MIN_WINDOW_SECONDS, MAX_WINDOW_SECONDS, 45);

  const startCandidate = parseMs(rawEvent?.startMs ?? rawEvent?.time ?? rawEvent?.happenedAtTime ?? rawEvent?.createdAtTime);
  const endCandidate = parseMs(rawEvent?.endMs ?? rawEvent?.time ?? rawEvent?.happenedAtTime ?? rawEvent?.updatedAtTime ?? rawEvent?.createdAtTime);

  const anchorStart = Number.isFinite(startCandidate) ? startCandidate : endCandidate;
  const anchorEnd = Number.isFinite(endCandidate) ? endCandidate : startCandidate;
  if (!Number.isFinite(anchorStart) && !Number.isFinite(anchorEnd)) return null;

  const eventStart = Number.isFinite(anchorStart) ? anchorStart : anchorEnd;
  // An "end" before the start is nonsense from the API; treat it as an instant.
  const eventEnd = Number.isFinite(anchorEnd) && anchorEnd > eventStart ? anchorEnd : eventStart;

  let startMs = eventStart - before * 1000;
  let endMs = eventEnd + after * 1000;

  // Both guards below are what stop a zero-length or runaway request reaching
  // Samsara, whatever the event said.
  if (endMs - startMs < MIN_WINDOW_SECONDS * 1000) {
    endMs = startMs + MIN_WINDOW_SECONDS * 1000;
  }
  if (endMs - startMs > MAX_WINDOW_SECONDS * 1000) {
    endMs = startMs + MAX_WINDOW_SECONDS * 1000;
  }

  return {
    vehicleId: String(vehicleId),
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    durationSeconds: Math.round((endMs - startMs) / 1000),
  };
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
}

function normalizeBase(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** The forward / inward URLs in a list of Samsara media rows, whatever shape they arrive in. */
function pickMediaUrls(rows) {
  const media = Array.isArray(rows) ? rows : [];
  const urlOf = (row) => row?.urlInfo?.url || row?.url || null;
  const inputOf = (row) => String(row?.input || row?.cameraInput || '');
  const isVideo = (row) => /video/i.test(String(row?.mediaType || row?.type || 'video'));

  const forwardUrl = urlOf(media.find((r) => isVideo(r) && /road|front|primary/i.test(inputOf(r)) && urlOf(r)))
    || urlOf(media.find((r) => isVideo(r) && !/driver|secondary/i.test(inputOf(r)) && urlOf(r)))
    || null;
  const inwardUrl = urlOf(media.find((r) => isVideo(r) && /driver|secondary/i.test(inputOf(r)) && urlOf(r)))
    || null;

  return { forwardUrl, inwardUrl };
}

/**
 * Ask Samsara to produce footage for a window.
 *
 * @returns {Promise<{ok:boolean, retrievalId:string|null, urls:{forwardUrl,inwardUrl}}>}
 *   `retrievalId` is the thing worth persisting: with it, a later check polls
 *   THIS request instead of creating a second one for the same footage.
 * @throws on a non-2xx response, so the caller can record why and back off.
 */
async function requestVideoRetrieval({
  vehicleId, startTime, endTime, apiKey, baseUrl, fetchImpl = fetch,
}) {
  if (!vehicleId || !startTime || !endTime || !apiKey) {
    return { ok: false, retrievalId: null, urls: { forwardUrl: null, inwardUrl: null } };
  }
  const res = await fetchImpl(`${normalizeBase(baseUrl)}/cameras/media/retrieval`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vehicleId,
      startTime,
      endTime,
      mediaType: 'videoHighRes',
      inputs: [ROAD_INPUT, DRIVER_INPUT],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`retrieval ${res.status}: ${String(text).slice(0, 200)}`);
  }
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  const data = json.data || json;
  return {
    ok: true,
    retrievalId: data?.retrievalId ? String(data.retrievalId) : null,
    // Occasionally the clip is already on the camera and comes straight back.
    urls: pickMediaUrls(data?.media),
  };
}

/**
 * Check ONE previously accepted retrieval. One round trip, no sleeping.
 *
 * @returns {Promise<{forwardUrl:string|null, inwardUrl:string|null, pending:boolean}>}
 *   `pending` is true while Samsara still reports the job in progress.
 */
async function fetchRetrievalMediaUrls({ retrievalId, apiKey, baseUrl, fetchImpl = fetch }) {
  if (!retrievalId || !apiKey) return { forwardUrl: null, inwardUrl: null, pending: false };
  const url = new URL(`${normalizeBase(baseUrl)}/cameras/media/retrieval`);
  url.searchParams.set('retrievalId', retrievalId);
  const res = await fetchImpl(url.toString(), { headers: authHeaders(apiKey) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`retrieval status ${res.status}: ${String(text).slice(0, 200)}`);
  }
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  const media = json.data?.media || json.media || [];
  const urls = pickMediaUrls(media);
  const pending = !urls.forwardUrl && !urls.inwardUrl
    && media.some((row) => /pending|processing|inprogress|uploading/i.test(String(row?.status || '')));
  return { ...urls, pending };
}

/**
 * List whatever camera media exists for a window. One round trip.
 *
 * This is the belt to `fetchRetrievalMediaUrls`'s braces: a retrieval that
 * finished can also be found here, and a clip the camera uploaded on its own
 * shows up here without any retrieval at all.
 */
async function listCameraMediaUrls({
  vehicleId, startTime, endTime, apiKey, baseUrl, fetchImpl = fetch,
}) {
  if (!vehicleId || !startTime || !endTime || !apiKey) {
    return { forwardUrl: null, inwardUrl: null };
  }
  const url = new URL(`${normalizeBase(baseUrl)}/cameras/media`);
  url.searchParams.set('vehicleIds', vehicleId);
  // A minute either side of the requested window: Samsara clips are cut on
  // camera boundaries and can start slightly before what we asked for.
  url.searchParams.set('startTime', new Date(Date.parse(startTime) - 60_000).toISOString());
  url.searchParams.set('endTime', new Date(Date.parse(endTime) + 120_000).toISOString());
  url.searchParams.append('mediaTypes', 'videoHighRes');
  url.searchParams.append('inputs', ROAD_INPUT);
  url.searchParams.append('inputs', DRIVER_INPUT);

  const res = await fetchImpl(url.toString(), { headers: authHeaders(apiKey) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`media list ${res.status}: ${String(text).slice(0, 200)}`);
  }
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  return pickMediaUrls(json.data?.media || []);
}

module.exports = {
  DEFAULT_BASE_URL,
  MIN_WINDOW_SECONDS,
  MAX_WINDOW_SECONDS,
  buildRetrievalWindow,
  pickMediaUrls,
  requestVideoRetrieval,
  fetchRetrievalMediaUrls,
  listCameraMediaUrls,
};
