const { test } = require('node:test');
const assert = require('node:assert/strict');

const speedPoller = require('../src/speedingPoller');

const { transformV2SpeedEvent, tryRetrieveSpeedingVideo } = speedPoller._forTest;

test.afterEach(() => {
  speedPoller._forTest.resetState();
});

test('transformV2SpeedEvent maps v2 severe speeding payload with vehicle lookup', async () => {
  const rawEvent = {
    id: 'uuid-1',
    startMs: '2026-05-28T17:07:48.000Z',
    endMs: '2026-05-28T17:08:30.004Z',
    asset: { id: '281474999386026' },
    behaviorLabels: [{ label: 'SevereSpeeding' }],
    speedingMetadata: {
      maxSpeedKilometersPerHour: 120,
      postedSpeedLimitKilometersPerHour: 96,
    },
    inboxEventUrl: 'https://cloud.samsara.com/event/abc',
    location: { latitude: 38.99, longitude: -83.76 },
  };

  const transformed = await transformV2SpeedEvent(rawEvent, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: { name: '004 SARAH OGBOMAH' } }),
    }),
    reverseGeocodeFn: async () => 'Road, City, ST',
  });

  assert.equal(transformed.vehicleName, '004 SARAH OGBOMAH');
  assert.equal(transformed.vehicleId, '281474999386026');
  assert.equal(transformed.driverName, 'SARAH OGBOMAH');

  const payload = transformed.payload;
  assert.equal(payload._enrichedEventType, 'SevereSpeeding');
  assert.equal(payload.eventTime, '2026-05-28T17:07:48.000Z');
  assert.equal(payload.data.incidentUrl, 'https://cloud.samsara.com/event/abc');
  assert.equal(
    payload.data.conditions[0].details.speed.currentSpeedKilometersPerHour,
    120,
  );
  assert.equal(
    payload.data.conditions[0].details.speed.thresholdSpeedKilometersPerHour,
    96,
  );
});

test('tryRetrieveSpeedingVideo returns URL when polling finds video', async () => {
  const responses = [
    {
      ok: true,
      text: async () => JSON.stringify({ data: { retrievalId: 'r1' } }),
    },
    {
      ok: true,
      text: async () => JSON.stringify({ data: { media: [] } }),
    },
    {
      ok: true,
      text: async () => JSON.stringify({
        data: {
          media: [
            {
              mediaType: 'videoHighRes',
              urlInfo: { url: 'https://s3.samsara.com/video.mp4' },
            },
          ],
        },
      }),
    },
  ];

  const url = await tryRetrieveSpeedingVideo({
    asset: { id: '281474999386026' },
    startMs: '2026-05-28T17:07:48.000Z',
    endMs: '2026-05-28T17:08:30.004Z',
  }, {
    fetchImpl: async () => {
      const next = responses.shift();
      assert.ok(next, 'unexpected extra fetch call');
      return next;
    },
    sleepImpl: async () => {},
    maxPolls: 3,
    pollIntervalMs: 1,
  });

  assert.equal(url, 'https://s3.samsara.com/video.mp4');
});

test('tryRetrieveSpeedingVideo returns null when retrieval request fails', async () => {
  const url = await tryRetrieveSpeedingVideo({
    asset: { id: '281474999386026' },
    startMs: '2026-05-28T17:07:48.000Z',
    endMs: '2026-05-28T17:08:30.004Z',
  }, {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }),
  });

  assert.equal(url, null);
});

test('tryRetrieveSpeedingVideo returns null when poll times out', async () => {
  const responses = [
    {
      ok: true,
      text: async () => JSON.stringify({ data: { retrievalId: 'r1' } }),
    },
    {
      ok: true,
      text: async () => JSON.stringify({ data: { media: [] } }),
    },
    {
      ok: true,
      text: async () => JSON.stringify({ data: { media: [] } }),
    },
  ];

  const url = await tryRetrieveSpeedingVideo({
    asset: { id: '281474999386026' },
    startMs: '2026-05-28T17:07:48.000Z',
    endMs: '2026-05-28T17:08:30.004Z',
  }, {
    fetchImpl: async () => {
      const next = responses.shift();
      assert.ok(next, 'unexpected extra fetch call');
      return next;
    },
    sleepImpl: async () => {},
    maxPolls: 2,
    pollIntervalMs: 1,
  });

  assert.equal(url, null);
});
