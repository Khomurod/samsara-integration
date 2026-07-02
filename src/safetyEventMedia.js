/**
 * Resolves dashcam video URLs from Samsara safety event payloads.
 *
 * Harsh braking / acceleration / turn events often expose footage under
 * `detectedStreams` instead of `media`, or only after a follow-up GET by id.
 */

const ROAD_FACING_INPUTS = new Set([
  'MEDIA_INPUT_PRIMARY',
  'dashcamRoadFacing',
]);

const DRIVER_FACING_INPUTS = new Set([
  'MEDIA_INPUT_SECONDARY',
  'dashcamDriverFacing',
]);

function collectMediaLikeRows(event) {
  const rows = [];
  const seenUrl = new Set();
  const push = (m) => {
    if (!m?.url || typeof m.url !== 'string') return;
    if (seenUrl.has(m.url)) return;
    seenUrl.add(m.url);
    rows.push(m);
  };
  for (const m of event.media || []) push(m);
  for (const m of event.detectedStreams || []) push(m);
  return rows;
}

function extractVideoUrlsFromSafetyEvent(event) {
  if (!event || typeof event !== 'object') {
    return { forwardUrl: null, inwardUrl: null };
  }

  const rows = collectMediaLikeRows(event);

  const inwardUrl =
    rows.find((m) => DRIVER_FACING_INPUTS.has(m.input))?.url ||
    event.downloadInwardVideoUrl ||
    null;

  let forwardUrl =
    rows.find((m) => ROAD_FACING_INPUTS.has(m.input))?.url ||
    rows.find((m) => /^analog[1-4]$/i.test(m.input || ''))?.url ||
    rows.find((m) => m.input && !DRIVER_FACING_INPUTS.has(m.input))?.url ||
    rows[0]?.url ||
    event.downloadForwardVideoUrl ||
    event.mediaUrl ||
    event.videoUrl ||
    null;

  if (
    forwardUrl &&
    inwardUrl &&
    forwardUrl === inwardUrl &&
    rows.length > 1
  ) {
    const alt = rows.find((r) => r.url && r.url !== inwardUrl);
    if (alt?.url) forwardUrl = alt.url;
  }

  return { forwardUrl, inwardUrl };
}

function mergeSafetyEventDetail(listEvent, detailed) {
  if (!detailed) return listEvent;
  return {
    ...listEvent,
    ...detailed,
    media:
      (detailed.media && detailed.media.length > 0
        ? detailed.media
        : listEvent.media) || [],
    detectedStreams:
      (detailed.detectedStreams && detailed.detectedStreams.length > 0
        ? detailed.detectedStreams
        : listEvent.detectedStreams) || [],
  };
}

async function fetchSafetyEventDetailFromApi(eventId, apiKey, baseUrl) {
  if (!eventId || !apiKey) return null;

  const base = (baseUrl || 'https://api.samsara.com').replace(/\/$/, '');
  const params = new URLSearchParams({
    safetyEventIds: eventId,
    includeDriver: 'true',
  });
  const url = `${base}/safety-events?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }

  const json = await res.json();
  const row = (json.data || [])[0];
  return row || null;
}

/**
 * Refetch a safety event via the /fleet/safety-events time-window endpoint and
 * return the matching row. Harsh-event ids from /fleet/safety-events (e.g.
 * "281475003766008-1783011831230") are NOT UUIDs, so the /safety-events
 * ?safetyEventIds= lookup rejects them with HTTP 400 — the time-window query is
 * the reliable way to re-read an event once its `downloadForwardVideoUrl`
 * finishes uploading.
 */
async function fetchSafetyEventViaFleetWindow(eventId, rawEvent, apiKey, baseUrl) {
  if (!eventId || !apiKey) return null;

  const base = (baseUrl || 'https://api.samsara.com').replace(/\/$/, '');
  const anchorMs = Date.parse(
    rawEvent?.time || rawEvent?.happenedAtTime || rawEvent?.createdAtTime || '',
  );
  const centerMs = Number.isFinite(anchorMs) ? anchorMs : Date.now();
  const startTime = new Date(centerMs - 5 * 60 * 1000).toISOString();
  const endTime = new Date(centerMs + 5 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    startTime,
    endTime,
    limit: '100',
    includeDriver: 'true',
  });
  const url = `${base}/fleet/safety-events?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const rows = json.data || [];
  return rows.find((r) => String(r.id) === String(eventId)) || null;
}

/**
 * Re-read an event's video URLs after a delay via the fleet time-window
 * endpoint (the cheap path — no camera retrieval job needed once the clip has
 * uploaded and `downloadForwardVideoUrl` is populated).
 */
async function refetchVideoUrlsViaFleetWindow(eventId, rawEvent, apiKey, baseUrl) {
  const row = await fetchSafetyEventViaFleetWindow(eventId, rawEvent, apiKey, baseUrl);
  if (!row) return { forwardUrl: null, inwardUrl: null };
  return extractVideoUrlsFromSafetyEvent(row);
}

/**
 * Refetch by id when the list/time-window response omitted `media` URLs
 * (common for harsh events until clips finish uploading).
 */
async function enrichSafetyEventWithMediaIfNeeded(event, apiKey, baseUrl) {
  let current = event;
  let urls = extractVideoUrlsFromSafetyEvent(current);

  if (urls.forwardUrl || !current?.id || !apiKey) {
    return { event: current, forwardUrl: urls.forwardUrl, inwardUrl: urls.inwardUrl };
  }

  try {
    const detailed = await fetchSafetyEventDetailFromApi(
      current.id,
      apiKey,
      baseUrl
    );
    const merged = mergeSafetyEventDetail(current, detailed);
    urls = extractVideoUrlsFromSafetyEvent(merged);
    return { event: merged, forwardUrl: urls.forwardUrl, inwardUrl: urls.inwardUrl };
  } catch (err) {
    console.warn('[SafetyEventMedia] Detail refetch failed:', err.message);
    urls = extractVideoUrlsFromSafetyEvent(current);
    return { event: current, forwardUrl: urls.forwardUrl, inwardUrl: urls.inwardUrl };
  }
}

module.exports = {
  extractVideoUrlsFromSafetyEvent,
  fetchSafetyEventDetailFromApi,
  fetchSafetyEventViaFleetWindow,
  refetchVideoUrlsViaFleetWindow,
  enrichSafetyEventWithMediaIfNeeded,
  mergeSafetyEventDetail,
};
