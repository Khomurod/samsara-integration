/**
 * videoBackfill.js
 *
 * When a Samsara safety event is delivered immediately but the dashcam video
 * was not yet available, this module comes back a short while later, resolves
 * the video (refetch the event → if still missing, trigger Samsara's media
 * retrieval/generation and poll for it), and folds the video INTO the original
 * alert message — in the Samsara notifications group, every subscriber, and the
 * matched driver group. The end state is a single clean notification that
 * carries the original event text plus the video, not two separate messages.
 *
 * How the "fold-in" works: Telegram cannot convert a text-only message into a
 * media message in place (`editMessageMedia` only works on messages that
 * already contain media). So we do the cleanest supported equivalent — send a
 * new video message whose caption is the ORIGINAL notification text, then delete
 * the original text-only message. The video is sent first and the delete second,
 * so a failed send never loses the alert and a failed delete never loses the
 * video.
 *
 * All collaborators are injected so the flow is unit-testable with no real
 * network or Telegram calls.
 */

const {
  runVideoRetrievalFlow,
  getVideoRetryDelayMs,
} = require('./videoRetryDelivery');
const { refetchVideoUrlsViaFleetWindow } = require('./safetyEventMedia');

// In-memory guard: event ids currently scheduled or running a backfill. Keeps a
// single event from being backfilled twice (e.g. if delivery is retried). Timers
// are in-memory anyway, so this set does not need to survive restarts.
const inFlight = new Set();

function isVideoBackfillEnabled() {
  // Reuse the existing retry toggle so operators have a single switch.
  return process.env.SAMSARA_VIDEO_RETRY_ENABLED !== 'false';
}

/**
 * Resolve dashcam video URLs for an event: refetch the safety event first
 * (video often finishes uploading a minute later); if still absent, trigger the
 * media retrieval/generation flow and poll for the produced clip.
 */
async function resolveEventVideoUrls({
  eventId,
  rawEvent,
  apiKey,
  baseUrl,
  refetchFn,
  retrievalFn,
  log = console,
}) {
  const doRefetch = refetchFn
    || (() => refetchVideoUrlsViaFleetWindow(eventId, rawEvent, apiKey, baseUrl));
  const doRetrieval = retrievalFn || (() => runVideoRetrievalFlow(rawEvent, { apiKey, baseUrl }));

  try {
    let urls = await doRefetch();
    if (urls?.forwardUrl || urls?.inwardUrl) {
      log.log?.(`[VideoBackfill] event ${eventId}: video found on refetch`);
      return { forwardUrl: urls.forwardUrl || null, inwardUrl: urls.inwardUrl || null };
    }

    log.log?.(`[VideoBackfill] event ${eventId}: no video on refetch, requesting retrieval/generation`);
    urls = await doRetrieval();
    if (urls?.forwardUrl || urls?.inwardUrl) {
      log.log?.(`[VideoBackfill] event ${eventId}: video found after retrieval`);
      return { forwardUrl: urls.forwardUrl || null, inwardUrl: urls.inwardUrl || null };
    }
  } catch (err) {
    log.warn?.(`[VideoBackfill] event ${eventId}: video resolve failed: ${err.message}`);
  }

  return { forwardUrl: null, inwardUrl: null };
}

// Telegram media captions are capped at 1024 chars (vs 4096 for a text message).
// The standard safety-event notification is well under this, but guard anyway so
// an unusually long text never causes Telegram to reject the whole video send.
const TELEGRAM_CAPTION_LIMIT = 1024;

function fitCaption(caption, log = console) {
  if (typeof caption !== 'string' || caption.length <= TELEGRAM_CAPTION_LIMIT) {
    return caption;
  }
  log.warn?.(
    `[VideoBackfill] caption of ${caption.length} chars exceeds Telegram's `
    + `${TELEGRAM_CAPTION_LIMIT}-char media caption limit; truncating for the video message`,
  );
  return `${caption.slice(0, TELEGRAM_CAPTION_LIMIT - 1)}…`;
}

/**
 * Fold the resolved video into a single previously-sent, text-only alert:
 * send a new video message whose caption is the ORIGINAL notification text,
 * then delete the original text message so the group is left with one clean
 * notification (text + video).
 *
 * Ordering is deliberate — the video is sent FIRST; only on success do we delete
 * the original. So a failed video send leaves the original text alert untouched
 * (no data loss, no duplicate video), and a failed delete still leaves the video
 * delivered (worst case a stray text message, which is logged). Falls through
 * dual-camera → single video. Returns whether the video was posted.
 */
async function replaceMessageWithVideo(bot, chatId, originalMessageId, {
  videoUrl,
  inwardVideoUrl,
  getVideoBuffer,
  caption,
  // Optional driver-group-only music overlay (see driverGroupDelivery). No-op
  // when absent — used only for driver-group backfill sends.
  prepareVideo = null,
  videoContext = {},
  log = console,
}) {
  const cap = fitCaption(caption, log);
  let sent = false;

  const applyMusic = async (buffer, role) => {
    if (!buffer || typeof prepareVideo !== 'function') return buffer;
    try {
      const out = await prepareVideo(buffer, { ...videoContext, role });
      return Buffer.isBuffer(out) && out.length > 0 ? out : buffer;
    } catch (err) {
      log.error?.(`[VideoBackfill] music overlay failed in ${chatId} (${err.message}); using original video.`);
      return buffer;
    }
  };

  if (videoUrl && inwardVideoUrl) {
    try {
      const [forwardBuf, inwardBuf] = await Promise.all([
        getVideoBuffer(videoUrl),
        getVideoBuffer(inwardVideoUrl),
      ]);
      const forwardOut = await applyMusic(forwardBuf, 'forward');
      await bot.sendMediaGroup(chatId, [
        { type: 'video', media: 'attach://forward', caption: cap, parse_mode: 'HTML' },
        { type: 'video', media: 'attach://inward' },
      ], {}, {
        forward: { value: forwardOut, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
        inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
      });
      sent = true;
    } catch (dualErr) {
      log.error?.(`[VideoBackfill] dual-camera replace in ${chatId} failed, trying single: ${dualErr.message}`);
    }
  }

  if (!sent && (videoUrl || inwardVideoUrl)) {
    const singleUrl = videoUrl || inwardVideoUrl;
    try {
      const buffer = await getVideoBuffer(singleUrl);
      const outBuffer = await applyMusic(buffer, 'single');
      await bot.sendVideo(chatId, outBuffer, {
        caption: cap,
        parse_mode: 'HTML',
      }, {
        filename: 'event.mp4',
        contentType: 'video/mp4',
      });
      sent = true;
    } catch (videoErr) {
      log.error?.(`[VideoBackfill] single-video replace in ${chatId} failed: ${videoErr.message}`);
    }
  }

  if (!sent) return false;

  // Video delivered as a new message carrying the original text as its caption.
  // Remove the original text-only alert so the group keeps a single message.
  if (originalMessageId != null && typeof bot.deleteMessage === 'function') {
    try {
      await bot.deleteMessage(chatId, originalMessageId);
      log.log?.(`[VideoBackfill] replaced original message ${originalMessageId} in ${chatId} with a video notification`);
    } catch (delErr) {
      log.warn?.(
        `[VideoBackfill] video posted to ${chatId} but deleting original message `
        + `${originalMessageId} failed: ${delErr.message}`,
      );
    }
  }

  return true;
}

/**
 * Fold the resolved video into every recorded alert message, using the bot
 * appropriate to each target (notification bot vs. driver bot). Each message is
 * replaced with a video that keeps that target's own original caption text.
 */
async function runVideoBackfill({
  sentMessages,
  videoUrls,
  resolveBot,
  getVideoBuffer,
  caption,
  // Driver-group-only music overlay (applied ONLY to refs with botKind==='driver').
  prepareDriverVideo = null,
  isSpeeding = false,
  eventId = null,
  log = console,
}) {
  if (!videoUrls || (!videoUrls.forwardUrl && !videoUrls.inwardUrl)) {
    return { posted: 0, attempted: 0 };
  }

  let posted = 0;
  let attempted = 0;
  for (const ref of sentMessages || []) {
    const bot = typeof resolveBot === 'function' ? resolveBot(ref.botKind) : null;
    if (!bot) continue;
    attempted += 1;
    // The music overlay is applied ONLY to the driver-group copy. Notification-
    // group / subscriber backfills always get the original video.
    const isDriver = ref.botKind === 'driver';
    try {
      const ok = await replaceMessageWithVideo(bot, ref.chatId, ref.messageId, {
        videoUrl: videoUrls.forwardUrl,
        inwardVideoUrl: videoUrls.inwardUrl,
        getVideoBuffer,
        // Prefer the exact text that was sent to THIS target; fall back to the
        // generic caption only if a ref somehow carries none.
        caption: ref.caption || caption,
        prepareVideo: isDriver ? prepareDriverVideo : null,
        videoContext: isDriver
          ? { isSpeeding, eventId, groupId: ref.chatId, source: 'backfill' }
          : {},
        log,
      });
      if (ok) posted += 1;
    } catch (err) {
      log.error?.(`[VideoBackfill] replace in ${ref.chatId} threw: ${err.message}`);
    }
  }
  return { posted, attempted };
}

// Fallback caption only — the backfill normally reuses each target's original
// notification text (carried on the sentMessages refs). This is used solely if a
// ref somehow arrives without its caption, so the video is never sent uncaptioned.
const DEFAULT_BACKFILL_CAPTION = '🎥 <b>Event video is now available.</b>';

/**
 * Schedule the video backfill: after a delay, resolve the video and fold it into
 * the original alert messages (send video with the original text as caption, then
 * delete the original text message). Returns true if a backfill was scheduled.
 */
function scheduleVideoBackfill({
  eventId,
  rawEvent,
  sentMessages,
  apiKey,
  baseUrl,
  resolveBot,
  makeGetVideoBuffer,
  caption = DEFAULT_BACKFILL_CAPTION,
  delayMs,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  refetchFn,
  retrievalFn,
  // Driver-group-only music overlay + speeding flag, threaded to runVideoBackfill.
  prepareDriverVideo = null,
  isSpeeding = false,
  log = console,
}) {
  if (!eventId) return false;
  if (!Array.isArray(sentMessages) || sentMessages.length === 0) return false;
  if (inFlight.has(eventId)) {
    log.log?.(`[VideoBackfill] event ${eventId}: backfill already in flight, skipping duplicate`);
    return false;
  }
  inFlight.add(eventId);

  const waitMs = Number.isFinite(delayMs) ? delayMs : getVideoRetryDelayMs();
  log.log?.(
    `[VideoBackfill] event ${eventId}: scheduling video backfill in ${Math.round(waitMs / 1000)}s `
    + `for ${sentMessages.length} sent message(s)`,
  );

  setTimer(async () => {
    try {
      const urls = await resolveEventVideoUrls({
        eventId, rawEvent, apiKey, baseUrl, refetchFn, retrievalFn, log,
      });
      if (!urls.forwardUrl && !urls.inwardUrl) {
        log.log?.(`[VideoBackfill] event ${eventId}: video never became available; leaving text alerts as-is`);
        return;
      }
      log.log?.(`[VideoBackfill] event ${eventId}: video available, folding into ${sentMessages.length} original message(s)`);
      const getVideoBuffer = typeof makeGetVideoBuffer === 'function' ? makeGetVideoBuffer() : null;
      if (!getVideoBuffer) {
        log.warn?.(`[VideoBackfill] event ${eventId}: no video downloader available, cannot post backfill`);
        return;
      }
      const res = await runVideoBackfill({
        sentMessages, videoUrls: urls, resolveBot, getVideoBuffer, caption,
        prepareDriverVideo, isSpeeding, eventId, log,
      });
      log.log?.(`[VideoBackfill] event ${eventId}: folded video into ${res.posted}/${res.attempted} target message(s)`);
    } catch (err) {
      log.warn?.(`[VideoBackfill] event ${eventId}: backfill flow failed: ${err.message}`);
    } finally {
      inFlight.delete(eventId);
    }
  }, waitMs);

  return true;
}

module.exports = {
  isVideoBackfillEnabled,
  resolveEventVideoUrls,
  replaceMessageWithVideo,
  runVideoBackfill,
  scheduleVideoBackfill,
  fitCaption,
  DEFAULT_BACKFILL_CAPTION,
  TELEGRAM_CAPTION_LIMIT,
  _forTest: { inFlight },
};
