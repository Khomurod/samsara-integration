const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractVideoUrlsFromSafetyEvent,
  mergeSafetyEventDetail,
  refetchVideoUrlsViaFleetWindow,
} = require('../src/safetyEventMedia');

test('detectedStreams supplies forward URL when media is empty', () => {
  const event = {
    detectedStreams: [
      { input: 'dashcamRoadFacing', url: 'https://d111.cloudfront.net/f.mp4' },
    ],
  };
  const { forwardUrl, inwardUrl } = extractVideoUrlsFromSafetyEvent(event);
  assert.equal(forwardUrl, 'https://d111.cloudfront.net/f.mp4');
  assert.equal(inwardUrl, null);
});

test('analog camera used when road-facing missing', () => {
  const event = {
    media: [{ input: 'analog1', url: 'https://api.samsara.com/x.mp4' }],
  };
  const { forwardUrl } = extractVideoUrlsFromSafetyEvent(event);
  assert.equal(forwardUrl, 'https://api.samsara.com/x.mp4');
});

test('driver-facing is inward and not preferred as forward when two streams exist', () => {
  const event = {
    media: [
      { input: 'dashcamDriverFacing', url: 'https://in.mp4' },
      { input: 'dashcamRoadFacing', url: 'https://out.mp4' },
    ],
  };
  const { forwardUrl, inwardUrl } = extractVideoUrlsFromSafetyEvent(event);
  assert.equal(forwardUrl, 'https://out.mp4');
  assert.equal(inwardUrl, 'https://in.mp4');
});

test('mergeSafetyEventDetail prefers non-empty media from detail response', () => {
  const listEvent = { id: '1', media: [], detectedStreams: [] };
  const detailed = {
    media: [{ input: 'dashcamRoadFacing', url: 'https://filled.mp4' }],
    detectedStreams: [],
  };
  const merged = mergeSafetyEventDetail(listEvent, detailed);
  assert.equal(merged.media.length, 1);
  assert.equal(merged.media[0].url, 'https://filled.mp4');
});

test('refetchVideoUrlsViaFleetWindow finds the event by id and reads downloadForwardVideoUrl', async () => {
  const origFetch = global.fetch;
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      async json() {
        return {
          data: [
            { id: 'other-event', downloadForwardVideoUrl: 'https://nope.mp4' },
            { id: 'evt-42', downloadForwardVideoUrl: 'https://forward-42.mp4', downloadInwardVideoUrl: 'https://inward-42.mp4' },
          ],
        };
      },
    };
  };
  try {
    const urls = await refetchVideoUrlsViaFleetWindow(
      'evt-42',
      { id: 'evt-42', time: '2026-07-02T17:03:51.230Z' },
      'k',
      'https://api.samsara.com',
    );
    assert.equal(urls.forwardUrl, 'https://forward-42.mp4');
    assert.equal(urls.inwardUrl, 'https://inward-42.mp4');
    assert.match(calledUrl, /\/fleet\/safety-events\?/);
  } finally {
    global.fetch = origFetch;
  }
});

test('refetchVideoUrlsViaFleetWindow returns nulls when the event is not in the window', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return { data: [{ id: 'someone-else' }] }; } });
  try {
    const urls = await refetchVideoUrlsViaFleetWindow('missing', { id: 'missing' }, 'k');
    assert.deepEqual(urls, { forwardUrl: null, inwardUrl: null });
  } finally {
    global.fetch = origFetch;
  }
});
