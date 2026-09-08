/**
 * The fake world for the durable missing-video recovery tests.
 *
 * An in-memory stand-in for src/videoRecoveryStore.js, a settings object, and a
 * Telegram bot that records what it was asked to send and delete — so the
 * worker's DECISIONS are what the tests exercise, with no database, no Samsara
 * and no Telegram. Shared by tests/samsaraVideoRecovery.test.js (enqueue) and
 * tests/samsaraVideoRecoveryWorker.test.js (the tick).
 */
'use strict';

const { createVideoRecoveryWorker } = require('../../src/videoRecoveryWorker');

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

const CONFIG = {
  enabled: true,
  apiKey: 'test-key',
  apiBase: 'https://api.samsara.com',
  videoRecoveryEnabled: true,
  videoRecoveryInitialDelaySeconds: 300,
  videoRetrievalEnabled: true,
  videoRecoveryRetryIntervalSeconds: 300,
  videoRecoveryMaxAttempts: 3,
  videoRetrievalWindowBeforeSeconds: 15,
  videoRetrievalWindowAfterSeconds: 45,
};

const RAW_EVENT = {
  id: 'evt-1',
  asset: { id: 'veh-9' },
  time: '2026-05-29T14:56:32.338Z',
};

/** An in-memory stand-in for src/videoRecoveryStore.js, recording every call. */
function fakeStore(initialJobs = [], { finishFails = false } = {}) {
  const jobs = new Map(initialJobs.map((j) => [j.id, { ...j }]));
  const calls = { enqueue: [], reschedule: [], finish: [] };
  let nextId = jobs.size + 1;
  return {
    calls,
    jobs,
    async enqueue(job) {
      calls.enqueue.push(job);
      const existing = [...jobs.values()].find((j) => j.samsara_event_id === job.eventId);
      if (existing) return { created: false, job: existing };
      const row = {
        id: nextId++,
        samsara_event_id: job.eventId,
        vehicle_id: job.vehicleId,
        event_time: job.eventTime,
        is_speeding: job.isSpeeding,
        raw_event: job.rawEvent,
        targets: job.targets,
        status: 'pending_recheck',
        next_check_at: job.nextCheckAt,
        attempts: 0,
        retrieval_id: null,
      };
      jobs.set(row.id, row);
      return { created: true, job: row };
    },
    async claimDueJobs({ now = new Date() } = {}) {
      return [...jobs.values()].filter(
        (j) => ['pending_recheck', 'pending_retrieval', 'video_available'].includes(j.status)
          && new Date(j.next_check_at) <= now,
      );
    },
    // `targets` rides along in the SAME call as the status, mirroring the real
    // store's single UPDATE — the two must never be able to land separately.
    async reschedule(id, patch) {
      calls.reschedule.push({ id, ...patch });
      const job = jobs.get(id);
      Object.assign(job, {
        status: patch.status,
        next_check_at: patch.nextCheckAt,
        attempts: (job.attempts || 0) + 1,
        last_error: patch.lastError ?? null,
        retrieval_id: patch.retrievalId || job.retrieval_id,
        retrieval_requested_at: (patch.retrievalId || patch.retrievalRequested)
          ? (job.retrieval_requested_at || new Date())
          : job.retrieval_requested_at,
        retrieval_start_time: patch.retrievalStartTime || job.retrieval_start_time,
        retrieval_end_time: patch.retrievalEndTime || job.retrieval_end_time,
        targets: patch.targets == null ? job.targets : patch.targets,
      });
      return job;
    },
    async finish(id, patch) {
      calls.finish.push({ id, ...patch });
      // `finishFails` reproduces the store swallowing a database error: it
      // returns null, and the row stays exactly as it was.
      if (finishFails) return null;
      Object.assign(jobs.get(id), {
        status: patch.status,
        last_error: patch.lastError ?? null,
        targets: patch.targets == null ? jobs.get(id).targets : patch.targets,
      });
      return jobs.get(id);
    },
  };
}

function jobRow(overrides = {}) {
  return {
    id: 1,
    samsara_event_id: 'evt-1',
    vehicle_id: 'veh-9',
    event_time: RAW_EVENT.time,
    is_speeding: false,
    raw_event: RAW_EVENT,
    targets: [{ botKind: 'notification', chatId: '-100111', messageId: 55, caption: 'Harsh braking' }],
    status: 'pending_recheck',
    next_check_at: new Date(Date.now() - 1000),
    attempts: 0,
    retrieval_id: null,
    ...overrides,
  };
}

/** A worker with every collaborator faked. */
function makeWorker({ store, refetch, bots = {}, config = CONFIG, buffers = {}, logErrors = null } = {}) {
  const sent = [];
  const deleted = [];
  const bot = {
    sendVideo: async (chatId, buffer, opts) => {
      if (bots.sendVideoThrows) throw bots.sendVideoThrows;
      sent.push({ chatId, caption: opts.caption });
      return { message_id: 900 };
    },
    sendMediaGroup: async () => { throw new Error('single-camera event'); },
    deleteMessage: async (chatId, messageId) => { deleted.push({ chatId, messageId }); },
  };
  const worker = createVideoRecoveryWorker({
    store,
    settings: { load: async () => config },
    resolveBot: () => bot,
    makeGetVideoBuffer: () => async (url) => buffers[url] || Buffer.from('video-bytes'),
    refetchEventUrls: refetch,
    log: logErrors
      ? { log: () => {}, warn: () => {}, error: (m) => logErrors.push(String(m)) }
      : silentLog,
  });
  return { worker, sent, deleted };
}


/**
 * Stub global fetch for the duration of a test, recording every request.
 * The worker reaches Samsara through cameraMediaRetrieval, which uses the
 * global — so this is where a retrieval request is observed.
 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const entry = { url: String(url), method: options.method || 'GET' };
    if (options.body) { try { entry.body = JSON.parse(options.body); } catch { entry.body = options.body; } }
    requests.push(entry);
    const res = await handler(entry, requests.length);
    return {
      ok: res.ok !== false,
      status: res.status || 200,
      text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {})),
    };
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

module.exports = { silentLog, CONFIG, RAW_EVENT, fakeStore, jobRow, makeWorker, stubFetch };
