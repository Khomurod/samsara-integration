/**
 * The retrieval window — the fix for a request Samsara could never satisfy.
 *
 * Both retrieval paths used to build it as `start = event.startMs || event.time`
 * and `end = event.endMs || event.time`, so any event reporting a single
 * instant — most of them — asked for footage from T to T. Samsara cannot
 * produce a clip of no duration, and the request came back empty forever.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildRetrievalWindow, pickMediaUrls } = require('../src/cameraMediaRetrieval');

// The name the callers know it by; the assertions below are about the window.
const inferVideoRetrievalParams = buildRetrievalWindow;

test('inferVideoRetrievalParams tolerates invalid start with valid end', () => {
  const out = inferVideoRetrievalParams({
    asset: { id: 'veh-1' },
    startMs: 'not-a-time',
    endMs: '2026-05-29T14:56:32.338Z',
  });
  assert.equal(out.vehicleId, 'veh-1');
  // It used to answer start === end === the one usable timestamp. Samsara
  // cannot produce a clip of no duration, so that request could only ever come
  // back empty. The window is now anchored on the event and genuinely wide.
  assert.ok(out.durationSeconds > 0, 'a retrieval window must have real duration');
  assert.ok(Date.parse(out.endTime) > Date.parse(out.startTime));
  assert.equal(out.startTime, '2026-05-29T14:56:17.338Z');
  assert.equal(out.endTime, '2026-05-29T14:57:17.338Z');
});

test('inferVideoRetrievalParams never returns a zero-length window, whatever the event says', () => {
  // The common shape: one instant, reported as both ends.
  const instant = inferVideoRetrievalParams({
    vehicle: { id: 'veh-2' },
    startMs: '2026-05-29T14:56:00.000Z',
    endMs: '2026-05-29T14:56:00.000Z',
  });
  assert.ok(instant.durationSeconds >= 5);
  assert.notEqual(instant.startTime, instant.endTime);

  // And the other direction: a long event is bounded, so one alert cannot ask a
  // truck to upload half an hour of video.
  const long = inferVideoRetrievalParams({
    asset: { id: 'veh-3' },
    startMs: '2026-05-29T14:00:00.000Z',
    endMs: '2026-05-29T15:00:00.000Z',
  });
  assert.ok(long.durationSeconds <= 600, `expected a bounded window, got ${long.durationSeconds}s`);

  // No vehicle, or no usable time at all, is honestly nothing rather than a
  // request Samsara will reject.
  assert.equal(inferVideoRetrievalParams({ time: '2026-05-29T14:56:00.000Z' }), null);
  assert.equal(inferVideoRetrievalParams({ asset: { id: 'veh-4' } }), null);
});

test('pickMediaUrls sorts the two cameras apart, whatever shape the rows arrive in', () => {
  const urls = pickMediaUrls([
    { mediaType: 'videoHighRes', input: 'dashcamDriverFacing', urlInfo: { url: 'https://in.mp4' } },
    { mediaType: 'videoHighRes', input: 'dashcamRoadFacing', urlInfo: { url: 'https://fwd.mp4' } },
  ]);
  assert.deepEqual(urls, { forwardUrl: 'https://fwd.mp4', inwardUrl: 'https://in.mp4' });

  // A single unlabelled clip is the forward camera, not nothing.
  assert.equal(pickMediaUrls([{ mediaType: 'videoHighRes', urlInfo: { url: 'https://only.mp4' } }]).forwardUrl,
    'https://only.mp4');
  assert.deepEqual(pickMediaUrls([]), { forwardUrl: null, inwardUrl: null });
});

test('a retrieval request returns the id worth persisting', async () => {
  // Keeping the id is what stops every retry becoming another request for the
  // same seconds of video.
  const { requestVideoRetrieval } = require('../src/cameraMediaRetrieval');
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { retrievalId: 'ret-55' } }) };
  };

  const out = await requestVideoRetrieval({
    vehicleId: 'veh-1',
    startTime: '2026-05-29T14:56:00.000Z',
    endTime: '2026-05-29T14:57:00.000Z',
    apiKey: 'k',
    baseUrl: 'https://api.samsara.com/',
    fetchImpl,
  });

  assert.equal(out.retrievalId, 'ret-55');
  assert.match(seen[0].url, /^https:\/\/api\.samsara\.com\/cameras\/media\/retrieval$/, 'the trailing slash is normalised away');
  assert.deepEqual(seen[0].body.inputs, ['dashcamRoadFacing', 'dashcamDriverFacing']);
});

test('a refused call throws with the status, so the worker can record why', async () => {
  const { listCameraMediaUrls } = require('../src/cameraMediaRetrieval');
  await assert.rejects(
    () => listCameraMediaUrls({
      vehicleId: 'veh-1',
      startTime: '2026-05-29T14:56:00.000Z',
      endTime: '2026-05-29T14:57:00.000Z',
      apiKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
    }),
    /media list 429/,
  );
});

test('an existing retrieval is polled by its own id', async () => {
  const { fetchRetrievalMediaUrls } = require('../src/cameraMediaRetrieval');
  const seen = [];
  const out = await fetchRetrievalMediaUrls({
    retrievalId: 'ret-55',
    apiKey: 'k',
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { media: [{ status: 'processing' }] } }) };
    },
  });
  assert.match(seen[0], /retrievalId=ret-55/);
  assert.equal(out.pending, true, 'still working — come back later, do not ask again');
  assert.equal(out.forwardUrl, null);
});
