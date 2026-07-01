const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractVideoUrlsFromSafetyEvent,
  mergeSafetyEventDetail,
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
