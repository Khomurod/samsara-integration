'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHealthReport, sanitizeErrorMessage } = require('../src/healthReport');

const MIN = 60_000;

// A fully-healthy baseline input the individual tests tweak.
function baseInput(overrides = {}) {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  return {
    now,
    uptimeSeconds: 3600,
    coordinatorRunning: true,
    staleThresholdMs: 5 * MIN,
    startupGraceMs: 2 * MIN,
    safety: {
      lastSuccessAt: now - 20_000,
      lastPollEndTime: '2026-07-28T11:59:40.000Z',
      lastApiError: null,
      queueSize: 0,
      droppedAlerts: 0,
    },
    speeding: {
      enabled: true,
      lastSuccessAt: now - 25_000,
      lastPollEndTime: '2026-07-28T11:59:35.000Z',
      lastApiError: null,
      queueSize: 0,
      droppedAlerts: 0,
    },
    ...overrides,
  };
}

test('healthy: both pollers succeeded recently -> 200 ok', () => {
  const { statusCode, body } = buildHealthReport(baseInput());
  assert.equal(statusCode, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.healthy, true);
  assert.equal(body.coordinatorRunning, true);
  assert.equal(body.pollers.safety.stale, false);
  assert.equal(body.pollers.speeding.stale, false);
  // backward-compatible fields preserved
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.timestamp, 'string');
  // age reported in seconds
  assert.equal(body.pollers.safety.ageSeconds, 20);
});

test('stale: last safety success older than threshold -> 503 unhealthy', () => {
  const input = baseInput();
  input.safety.lastSuccessAt = input.now - 10 * MIN; // older than 5 min threshold
  const { statusCode, body } = buildHealthReport(input);
  assert.equal(statusCode, 503);
  assert.equal(body.status, 'unhealthy');
  assert.equal(body.healthy, false);
  assert.equal(body.pollers.safety.stale, true);
  assert.equal(body.pollers.speeding.stale, false);
});

test('never-started within startup grace -> 200 starting', () => {
  const input = baseInput({
    uptimeSeconds: 30, // 30s uptime, grace is 120s
    safety: { lastSuccessAt: null, lastPollEndTime: null, lastApiError: null, queueSize: 0, droppedAlerts: 0 },
    speeding: { enabled: true, lastSuccessAt: null, lastPollEndTime: null, lastApiError: null, queueSize: 0, droppedAlerts: 0 },
  });
  const { statusCode, body } = buildHealthReport(input);
  assert.equal(statusCode, 200);
  assert.equal(body.status, 'starting');
  assert.equal(body.healthy, true);
  assert.equal(body.pollers.safety.stale, false);
  assert.equal(body.pollers.safety.ageSeconds, null);
});

test('never-started beyond startup grace -> 503 unhealthy', () => {
  const input = baseInput({
    uptimeSeconds: 600, // beyond 120s grace, yet no success recorded
    safety: { lastSuccessAt: null, lastPollEndTime: null, lastApiError: null, queueSize: 0, droppedAlerts: 0 },
    speeding: { enabled: true, lastSuccessAt: null, lastPollEndTime: null, lastApiError: null, queueSize: 0, droppedAlerts: 0 },
  });
  const { statusCode, body } = buildHealthReport(input);
  assert.equal(statusCode, 503);
  assert.equal(body.status, 'unhealthy');
  assert.equal(body.pollers.safety.stale, true);
  assert.equal(body.pollers.speeding.stale, true);
});

test('coordinator stopped -> 503 unhealthy even with a recent success', () => {
  const input = baseInput({ coordinatorRunning: false });
  const { statusCode, body } = buildHealthReport(input);
  assert.equal(statusCode, 503);
  assert.equal(body.status, 'unhealthy');
  assert.equal(body.coordinatorRunning, false);
});

test('api-error is reported and sanitized but does not by itself force unhealthy', () => {
  const input = baseInput();
  input.safety.lastApiError = {
    code: 401,
    message: 'HTTP 401: Authorization: Bearer samsara_api_SECRETVALUE123456 was rejected',
    at: '2026-07-28T11:59:00.000Z',
  };
  const { statusCode, body } = buildHealthReport(input);
  // Recent success still present -> not stale -> healthy.
  assert.equal(statusCode, 200);
  assert.equal(body.pollers.safety.lastError.code, 401);
  assert.match(body.pollers.safety.lastError.message, /HTTP 401/);
  assert.doesNotMatch(body.pollers.safety.lastError.message, /samsara_api_SECRETVALUE123456/);
  assert.doesNotMatch(body.pollers.safety.lastError.message, /Bearer\s+samsara/);
});

test('disabled speeding poller never counts as stale', () => {
  const input = baseInput({
    speeding: { enabled: false, lastSuccessAt: null, lastPollEndTime: null, lastApiError: null, queueSize: 0, droppedAlerts: 0 },
  });
  const { statusCode, body } = buildHealthReport(input);
  assert.equal(statusCode, 200);
  assert.equal(body.pollers.speeding.enabled, false);
  assert.equal(body.pollers.speeding.stale, false);
});

test('wiring: poller/speedingPoller/coordinator expose the shape buildHealthReport consumes', () => {
  const poller = require('../src/poller');
  const speedingPoller = require('../src/speedingPoller');
  const coordinator = require('../src/pollCoordinator');

  assert.equal(typeof poller.getStatus, 'function');
  assert.equal(typeof speedingPoller.getStatus, 'function');
  assert.equal(typeof coordinator.isRunning, 'function');
  assert.equal(coordinator.isRunning(), false); // not started in tests

  const safety = poller.getStatus();
  const speeding = speedingPoller.getStatus();
  for (const snap of [safety, speeding]) {
    assert.ok('lastSuccessAt' in snap);
    assert.ok('lastApiError' in snap);
    assert.equal(typeof snap.queueSize, 'number');
    assert.equal(typeof snap.droppedAlerts, 'number');
  }
  assert.equal(typeof speeding.enabled, 'boolean');

  // Fresh process: nothing has polled yet -> "never started". Within grace it is
  // 200/starting; past grace it is 503/unhealthy. Coordinator is not running here,
  // so the report must be unhealthy regardless.
  const report = buildHealthReport({
    now: Date.parse('2026-07-28T12:00:00.000Z'),
    uptimeSeconds: 10,
    coordinatorRunning: coordinator.isRunning(),
    staleThresholdMs: 5 * MIN,
    startupGraceMs: 2 * MIN,
    safety,
    speeding,
  });
  assert.equal(report.statusCode, 503);
  assert.equal(report.body.coordinatorRunning, false);
});

test('sanitizeErrorMessage scrubs tokens, telegram tokens and query secrets', () => {
  assert.equal(sanitizeErrorMessage(null), null);
  assert.doesNotMatch(sanitizeErrorMessage('Bearer samsara_api_abcdEFGH1234'), /samsara_api_abcdEFGH1234/);
  assert.doesNotMatch(
    sanitizeErrorMessage('conflict for token 7955098141:AAETM0NoXQabGLJT6HW8IarBGxf6hZmt2Ys'),
    /7955098141:AAETM0NoXQabGLJT6HW8IarBGxf6hZmt2Ys/,
  );
  assert.doesNotMatch(sanitizeErrorMessage('failed https://x.test/media?apikey=SEKRET&x=1'), /SEKRET/);
  // Truncation cap.
  assert.ok(sanitizeErrorMessage('x'.repeat(5000)).length <= 300);
});
