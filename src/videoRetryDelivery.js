/**
 * videoRetryDelivery.js
 *
 * The alert side of "the dashcam clip is not ready yet", and nothing else.
 *
 * **The alert is never held back for video.** `enqueueFormattedAlert` queues it
 * immediately — text-only when there is no clip — and attaches a `videoBackfill`
 * descriptor. The delivery layer reads that AFTER the messages have actually
 * been sent and turns it into a DURABLE recovery job
 * (`src/videoRecoveryWorker.js` → `src/videoRecoveryStore.js`), so the wait
 * survives a restart or a redeploy.
 *
 * This module used to also own the Samsara camera calls and an "ask and wait"
 * flow. Both are gone: the calls live in `./cameraMediaRetrieval.js` (one round
 * trip each), and the pacing belongs to the durable worker — a sleep loop
 * inside an HTTP helper is exactly what could not be resumed after a restart.
 */
const {
  isVideoRecoveryEnabledInEnv,
  envInitialDelayMs,
  DEFAULT_INITIAL_DELAY_MS,
  MIN_INITIAL_DELAY_MS,
} = require('./samsaraSettings');

/**
 * Whether the ENVIRONMENT alone would enable recovery.
 *
 * It is NOT consulted on the alert path any more, and deliberately so: it used
 * to veto, which meant a deployment carrying SAMSARA_VIDEO_RETRY_ENABLED=false
 * could silently defeat an administrator who had just switched recovery ON in
 * the panel — the same silent-override shape the nullable settings columns
 * exist to prevent. The single decision point is now
 * `cfg.videoRecoveryEnabled`, which already falls back to this value when
 * nothing is saved. Exported for the settings reader and its tests.
 */
const isVideoRetryEnabled = isVideoRecoveryEnabledInEnv;

/** The environment's initial re-check delay, in ms. The database wins over it. */
const getVideoRetryDelayMs = envInitialDelayMs;

/**
 * Queue a formatted alert for IMMEDIATE delivery.
 *
 * @param {object} formattedAlert
 * @param {object} rawEvent   carried on the descriptor so a recovery can resume
 *                            without re-reading Samsara's list
 * @param {Function} queueAlert
 * @param {{delayMs?: number}} [options]  an explicit initial delay, overriding
 *                            the admin-configured one (tests, and a caller with
 *                            its own timing)
 */
function enqueueFormattedAlert(formattedAlert, rawEvent, queueAlert, options = {}) {
  if (!formattedAlert) return;

  const eventId = rawEvent?.id || null;
  if (eventId) {
    formattedAlert.samsaraEventId = eventId;
  }

  // The descriptor is attached whenever a clip is missing; whether a recovery
  // is actually created is decided by `enqueueVideoRecovery`, which can await
  // the settings. Deciding it here would mean deciding it from the environment
  // alone, because this runs while the alert is being formatted.
  const hasVideo = Boolean(formattedAlert.videoUrl || formattedAlert.inwardVideoUrl);
  if (!hasVideo && eventId) {
    formattedAlert.videoBackfill = {
      eventId,
      rawEvent,
      delayMs: options.delayMs,
    };
  }

  queueAlert(formattedAlert);
}

module.exports = {
  isVideoRetryEnabled,
  getVideoRetryDelayMs,
  enqueueFormattedAlert,
  DEFAULT_DELAY_MS: DEFAULT_INITIAL_DELAY_MS,
  MIN_DELAY_MS: MIN_INITIAL_DELAY_MS,
};
