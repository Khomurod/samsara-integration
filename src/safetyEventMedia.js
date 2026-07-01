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
  enrichSafetyEventWithMediaIfNeeded,
  mergeSafetyEventDetail,
};
