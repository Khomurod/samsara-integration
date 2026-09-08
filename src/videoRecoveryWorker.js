/**
 * videoRecoveryWorker.js
 *
 * Works the durable missing-video recovery jobs.
 *
 * THE SHAPE OF ONE RECOVERY, and why it is in this order:
 *
 *   1. The alert already went out, immediately, text-only. Nothing here can
 *      change that, and nothing here is allowed to delay it.
 *   2. After the admin-configured initial delay (5 minutes by default) the
 *      event is RE-READ. Most clips have finished uploading by then, and
 *      re-reading is far cheaper than asking a truck to produce footage.
 *   3. Only if that still has nothing do we ask Samsara to RETRIEVE the
 *      footage — once. The retrieval id is persisted, so every later check
 *      polls THAT request instead of queueing another for the same seconds of
 *      video.
 *   4. Once footage exists it is folded into the messages that already carry
 *      this event's text, each keeping its own caption, and the driver group's
 *      copy still goes through the music overlay.
 *   5. The job ends in a state that says what happened: completed, no_video,
 *      or failed with the last error. Nothing is abandoned silently.
 *
 * EVERY TICK IS ISOLATED. The worker has its own interval, claims its own rows
 * and swallows its own failures, so a Samsara outage or a Telegram error during
 * recovery cannot touch safety-event polling — which is the one thing that must
 * never stop.
 */

const {
  buildRetrievalWindow,
  requestVideoRetrieval,
  fetchRetrievalMediaUrls,
  listCameraMediaUrls,
} = require('./cameraMediaRetrieval');
const { refetchVideoUrlsViaFleetWindow } = require('./safetyEventMedia');
const { runVideoBackfill } = require('./videoBackfill');

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_BATCH = 3;

function hasUrls(urls) {
  return Boolean(urls && (urls.forwardUrl || urls.inwardUrl));
}

function secondsFromNow(seconds) {
  return new Date(Date.now() + Math.max(1, Number(seconds) || 0) * 1000);
}

/**
 * @param {object} deps
 * @param {object} deps.store          createVideoRecoveryStore(...)
 * @param {object} deps.settings       createSamsaraSettingsStore(...)
 * @param {(kind: string) => object} deps.resolveBot   'notification' | 'driver'
 * @param {() => Function} deps.makeGetVideoBuffer     fresh per-recovery downloader
 * @param {Function} [deps.prepareDriverVideo]         driver-group music overlay
 * @param {Function} [deps.refetchEventUrls]           injected for tests
 * @param {Console} [deps.log]
 */
function createVideoRecoveryWorker({
  store,
  settings,
  resolveBot,
  makeGetVideoBuffer,
  prepareDriverVideo = null,
  refetchEventUrls = refetchVideoUrlsViaFleetWindow,
  tickMs = DEFAULT_TICK_MS,
  batchSize = DEFAULT_BATCH,
  log = console,
} = {}) {
  let timer = null;
  let running = false;
  let ticking = false;
  let lastTickAt = null;
  let lastError = null;

  /** Re-read the safety event itself — the cheap path that usually wins. */
  async function tryEventRefetch(job, cfg) {
    try {
      const urls = await refetchEventUrls(job.samsara_event_id, job.raw_event, cfg.apiKey, cfg.apiBase);
      return { forwardUrl: urls?.forwardUrl || null, inwardUrl: urls?.inwardUrl || null };
    } catch (err) {
      log.warn?.(`[VideoRecovery] event ${job.samsara_event_id}: re-read failed: ${err.message}`);
      return { forwardUrl: null, inwardUrl: null, error: err.message };
    }
  }

  /**
   * Check the retrieval this job already owns, then the plain media listing.
   *
   * The listing runs even before any retrieval has been requested — it is one
   * cheap read, and a clip the camera uploaded on its own shows up there. That
   * is what keeps a truck from being asked to produce footage Samsara already
   * has, which matters most for speeding events: their ids do not appear in the
   * /fleet/safety-events window the step above re-reads.
   */
  async function tryRetrievalCheck(job, cfg) {
    const stored = job.retrieval_start_time && job.retrieval_end_time
      ? {
        vehicleId: job.vehicle_id,
        startTime: new Date(job.retrieval_start_time).toISOString(),
        endTime: new Date(job.retrieval_end_time).toISOString(),
      }
      : null;
    const window = stored || buildRetrievalWindow(job.raw_event, {
      beforeSeconds: cfg.videoRetrievalWindowBeforeSeconds,
      afterSeconds: cfg.videoRetrievalWindowAfterSeconds,
    }) || { vehicleId: null, startTime: null, endTime: null };
    // EACH LOOKUP CATCHES ITS OWN. A shared try meant a throw from the
    // retrieval-status call — an expired or unknown id answers 404 — skipped
    // the listing entirely, so a clip that WAS sitting in the camera's media
    // would be missed on every attempt and the job would end as `no_video`
    // with the fallback this module documents never having run.
    let error = null;

    if (job.retrieval_id) {
      try {
        const byId = await fetchRetrievalMediaUrls({
          retrievalId: job.retrieval_id, apiKey: cfg.apiKey, baseUrl: cfg.apiBase,
        });
        if (hasUrls(byId)) return byId;
      } catch (err) {
        error = err.message;
        log.warn?.(
          `[VideoRecovery] event ${job.samsara_event_id}: retrieval ${job.retrieval_id} `
          + `could not be read (${err.message}); falling back to the media listing`,
        );
      }
    }

    if (window.vehicleId && window.startTime && window.endTime) {
      try {
        const listed = await listCameraMediaUrls({ ...window, apiKey: cfg.apiKey, baseUrl: cfg.apiBase });
        if (hasUrls(listed)) return listed;
      } catch (err) {
        error = err.message;
        log.warn?.(`[VideoRecovery] event ${job.samsara_event_id}: media listing failed: ${err.message}`);
      }
    }

    return { forwardUrl: null, inwardUrl: null, error };
  }

  /**
   * Ask for footage — ONCE per event.
   *
   * `requested` is the answer to "must we never ask again?", and it is NOT the
   * same question as "did we get a retrieval id". A request Samsara accepted
   * without naming one, and a request whose outcome we cannot know (a timeout,
   * a reset — it may well have landed), both mean stop asking. Only a refusal
   * WITH a status is proof it did not land, and only that is worth re-asking.
   */
  async function startRetrieval(job, cfg) {
    const window = buildRetrievalWindow(job.raw_event, {
      beforeSeconds: cfg.videoRetrievalWindowBeforeSeconds,
      afterSeconds: cfg.videoRetrievalWindowAfterSeconds,
    });
    if (!window) {
      return { error: 'the event carries no vehicle id or usable timestamp' };
    }
    try {
      const requested = await requestVideoRetrieval({
        ...window, apiKey: cfg.apiKey, baseUrl: cfg.apiBase,
      });
      log.log?.(
        `[VideoRecovery] event ${job.samsara_event_id}: requested ${window.durationSeconds}s of footage `
        + `(${requested.retrievalId ? `retrieval ${requested.retrievalId}` : 'no retrieval id returned'})`,
      );
      return { window, requested: true, retrievalId: requested.retrievalId, urls: requested.urls };
    } catch (err) {
      const refused = typeof err.status === 'number';
      if (!refused) {
        log.warn?.(
          `[VideoRecovery] event ${job.samsara_event_id}: the retrieval request did not complete `
          + `(${err.message}). It may have reached Samsara, so it will not be sent again — `
          + 'later checks poll the camera media listing instead.',
        );
      }
      return { window, requested: !refused, error: err.message };
    }
  }

  /**
   * Fold the video into every message still waiting for it.
   *
   * The targets that succeed are removed from the job, so a partial failure
   * retries only where the video is still missing — a group that already
   * received it can never get a second copy.
   */
  async function deliverVideo(job, urls) {
    const targets = Array.isArray(job.targets) ? job.targets : [];
    if (!targets.length) {
      return { posted: 0, attempted: 0, failedTargets: [] };
    }
    const getVideoBuffer = typeof makeGetVideoBuffer === 'function' ? makeGetVideoBuffer() : null;
    if (!getVideoBuffer) {
      return { posted: 0, attempted: 0, failedTargets: targets, error: 'no video downloader available' };
    }
    return runVideoBackfill({
      sentMessages: targets,
      videoUrls: urls,
      resolveBot,
      getVideoBuffer,
      prepareDriverVideo,
      isSpeeding: job.is_speeding === true,
      eventId: job.samsara_event_id,
      log,
    });
  }

  /**
   * Record a terminal state, and say plainly when that did not stick.
   *
   * The store swallows database errors, so an unchecked `finish()` let the
   * worker report a completed recovery while the row stayed open with all of
   * its original targets — and once the claim went stale, every destination
   * got the video a second time. The caller acts on the answer.
   */
  async function finishJob(job, patch) {
    const row = await store.finish(job.id, patch);
    if (!row) {
      log.error?.(
        `[VideoRecovery] event ${job.samsara_event_id}: the video was handled but recording `
        + `'${patch.status}' FAILED. The job stays open and will be retried once its claim goes `
        + 'stale — check the database before that happens.',
      );
    }
    return Boolean(row);
  }

  /** Advance ONE job by one step. Never throws. */
  async function processJob(job, cfg) {
    const attempts = Number(job.attempts) || 0;
    const budgetSpent = attempts + 1 >= Number(cfg.videoRecoveryMaxAttempts);

    // Nothing left to deliver. This is the resume path after a terminal write
    // that did not land: the targets were cleared in the same statement as the
    // status, so an empty list means every destination already has its video
    // and the only thing outstanding is saying so. Finishing here costs no
    // Samsara call and, crucially, re-sends nothing.
    if (!(Array.isArray(job.targets) ? job.targets : []).length) {
      await finishJob(job, { status: 'completed' });
      return 'completed';
    }

    // Step 1 — is the clip simply there now? Always worth asking first: it is
    // one cheap read and it is how most events resolve.
    let urls = await tryEventRefetch(job, cfg);
    let stepError = urls.error || null;

    // Step 2 — a retrieval we already own, or whatever the camera has uploaded.
    if (!hasUrls(urls)) {
      const checked = await tryRetrievalCheck(job, cfg);
      stepError = checked.error || stepError;
      if (hasUrls(checked)) urls = checked;
    }

    // Step 3 — nothing yet, and nobody has asked for footage: ask, once.
    //
    // `retrieval_requested_at` is the guard, not `retrieval_id`: a request that
    // Samsara accepted without naming an id, or one whose outcome is unknown,
    // must stop us asking again just as firmly. Guarding on the id alone meant
    // every later attempt issued another POST for the same seconds of video.
    const alreadyAsked = Boolean(job.retrieval_id || job.retrieval_requested_at);
    if (!hasUrls(urls) && !alreadyAsked && cfg.videoRetrievalEnabled) {
      const started = await startRetrieval(job, cfg);
      stepError = started.error || stepError;
      if (hasUrls(started.urls)) {
        urls = started.urls;
      } else if (started.window && !budgetSpent) {
        await store.reschedule(job.id, {
          status: 'pending_retrieval',
          nextCheckAt: secondsFromNow(cfg.videoRecoveryRetryIntervalSeconds),
          lastError: started.error || null,
          retrievalId: started.retrievalId,
          retrievalRequested: started.requested,
          retrievalStartTime: started.window.startTime,
          retrievalEndTime: started.window.endTime,
        });
        return 'pending_retrieval';
      }
      // Out of attempts: fall through to step 5 and end the job. This branch
      // used to return unconditionally, so a job whose retrieval kept failing
      // never reached the budget check and rescheduled itself forever.
    }

    // Step 4 — footage exists: fold it into the waiting messages.
    //
    // Every write below carries the surviving targets in the SAME statement as
    // the status. That is what makes "these destinations already have their
    // video" durable at the instant the job's state changes: the two cannot
    // land separately, so a retry can never re-send where a send succeeded.
    if (hasUrls(urls)) {
      const result = await deliverVideo(job, urls);
      const remaining = result.failedTargets || [];

      if (!remaining.length) {
        await finishJob(job, { status: 'completed', targets: [] });
        log.log?.(
          `[VideoRecovery] event ${job.samsara_event_id}: video folded into `
          + `${result.posted} message(s); recovery complete`,
        );
        return 'completed';
      }

      if (budgetSpent) {
        await finishJob(job, {
          status: 'failed',
          targets: remaining,
          lastError: `video found but ${remaining.length} destination(s) could not be updated`,
        });
        return 'failed';
      }

      await store.reschedule(job.id, {
        status: 'video_available',
        targets: remaining,
        nextCheckAt: secondsFromNow(cfg.videoRecoveryRetryIntervalSeconds),
        lastError: result.error || `${remaining.length} destination(s) not yet updated`,
      });
      return 'video_available';
    }

    // Step 5 — still nothing. Give up loudly, or wait a measured interval.
    if (budgetSpent) {
      await finishJob(job, {
        status: 'no_video',
        lastError: stepError || 'Samsara never produced a clip for this event',
      });
      log.log?.(`[VideoRecovery] event ${job.samsara_event_id}: gave up after ${attempts + 1} check(s)`);
      return 'no_video';
    }

    await store.reschedule(job.id, {
      status: job.retrieval_id ? 'pending_retrieval' : 'pending_recheck',
      nextCheckAt: secondsFromNow(cfg.videoRecoveryRetryIntervalSeconds),
      lastError: stepError,
    });
    return job.retrieval_id ? 'pending_retrieval' : 'pending_recheck';
  }

  /**
   * One pass: claim what is due and advance it.
   *
   * Returns a small summary so a test can drive the worker without timers.
   */
  async function tick({ now = new Date() } = {}) {
    if (ticking) return { skipped: true };
    ticking = true;
    lastTickAt = Date.now();
    try {
      const cfg = await settings.load();
      // A disabled integration or a missing key means "leave the jobs alone",
      // not "throw them away" — they resume the moment it is turned back on.
      if (!cfg.videoRecoveryEnabled || !cfg.enabled || !cfg.apiKey) {
        return { skipped: true, reason: !cfg.apiKey ? 'no-api-key' : 'disabled' };
      }

      const jobs = await store.claimDueJobs({ limit: batchSize, now });
      const outcomes = [];
      for (const job of jobs) {
        try {
          outcomes.push({ eventId: job.samsara_event_id, outcome: await processJob(job, cfg) });
        } catch (err) {
          // A job that threw must not stay claimed forever, and must not take
          // the tick — or the poller — down with it.
          lastError = { message: err.message, at: new Date().toISOString() };
          log.error?.(`[VideoRecovery] event ${job.samsara_event_id}: recovery step threw: ${err.message}`);
          await store.reschedule(job.id, {
            status: job.status,
            nextCheckAt: secondsFromNow(cfg.videoRecoveryRetryIntervalSeconds),
            lastError: err.message,
          });
          outcomes.push({ eventId: job.samsara_event_id, outcome: 'error' });
        }
      }
      return { claimed: jobs.length, outcomes };
    } catch (err) {
      lastError = { message: err.message, at: new Date().toISOString() };
      log.error?.(`[VideoRecovery] tick failed: ${err.message}`);
      return { error: err.message };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    log.log?.(`[VideoRecovery] Worker started (every ${Math.round(tickMs / 1000)}s).`);
    timer = setInterval(() => { void tick(); }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
    // One pass at boot so a job that came due while the process was down is
    // picked up immediately rather than after a full interval.
    void tick();
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** Read-only snapshot for /health. Contains no secrets. */
  function getStatus() {
    return { running, lastTickAt, lastError };
  }

  return { start, stop, tick, getStatus, _forTest: { processJob } };
}

/**
 * Turn a just-delivered, video-less alert into a durable recovery job.
 *
 * Called by the delivery layer AFTER the alert has actually reached Telegram,
 * so the job's targets are the real message ids to fold the video into. It is
 * idempotent by construction — the event id is UNIQUE — so a re-delivered or
 * re-driven event adds nothing and, crucially, never produces a second Samsara
 * retrieval request for the same footage.
 *
 * Returns what happened so the caller can log it; it never throws, because a
 * recovery that cannot be recorded must not fail an alert that was already
 * delivered.
 *
 * @param {object} params
 * @param {object} params.store     createVideoRecoveryStore(...)
 * @param {object} params.settings  createSamsaraSettingsStore(...)
 * @param {object} params.alertData the formatted alert (carries `videoBackfill`)
 * @param {object} params.result    what deliverEvent() returned
 */
async function enqueueVideoRecovery({ store, settings, alertData, result, log = console }) {
  const backfill = alertData && typeof alertData === 'object' ? alertData.videoBackfill : null;
  if (!backfill?.eventId) return { enqueued: false, reason: 'no-backfill-descriptor' };
  if (!result?.sentMessages?.length) return { enqueued: false, reason: 'nothing-was-sent' };

  let cfg;
  try {
    cfg = await settings.load();
  } catch {
    return { enqueued: false, reason: 'settings-unavailable' };
  }
  if (!cfg.videoRecoveryEnabled) return { enqueued: false, reason: 'disabled' };

  const rawEvent = backfill.rawEvent || null;
  // An explicit delayMs (a test, or a caller with its own timing) wins;
  // otherwise the admin-configured initial delay decides.
  const delaySeconds = Number.isFinite(backfill.delayMs)
    ? Math.max(1, Math.round(backfill.delayMs / 1000))
    : cfg.videoRecoveryInitialDelaySeconds;

  const eventTimeRaw = rawEvent?.time || rawEvent?.happenedAtTime || rawEvent?.createdAtTime || null;
  const eventTimeMs = eventTimeRaw ? Date.parse(String(eventTimeRaw)) : NaN;

  const outcome = await store.enqueue({
    eventId: backfill.eventId,
    vehicleId: rawEvent?.asset?.id || rawEvent?.vehicle?.id || alertData.vehicleId || null,
    eventTime: Number.isFinite(eventTimeMs) ? new Date(eventTimeMs) : null,
    isSpeeding: alertData.isSpeeding === true,
    rawEvent,
    targets: result.sentMessages,
    nextCheckAt: secondsFromNow(delaySeconds),
  });

  if (outcome.created) {
    log.log?.(
      `[VideoRecovery] event ${backfill.eventId}: alert delivered without video; `
      + `re-checking in ${delaySeconds}s (${result.sentMessages.length} message(s) waiting)`,
    );
    return { enqueued: true, delaySeconds };
  }
  return { enqueued: false, reason: outcome.job ? 'already-queued' : 'store-unavailable' };
}

module.exports = {
  createVideoRecoveryWorker,
  enqueueVideoRecovery,
  DEFAULT_TICK_MS,
  DEFAULT_BATCH,
};
