/**
 * videoBackfill.js
 *
 * When a Samsara safety event is delivered immediately but the dashcam video
 * was not yet available, this module comes back a short while later, resolves
 * the video (refetch the event → if still missing, trigger Samsara's media
 * retrieval/generation and poll for it), and posts the video as a REPLY to each
 * original alert message — in the Samsara notifications group, every subscriber,
 * and the matched driver group.
 *
 * Why a reply instead of an in-place edit? Telegram cannot convert a text-only
 * message into a video message (`editMessageMedia` only works on messages that
 * already contain media). Replying to the original alert threads the video
 * directly under it, which is the reliable way to "add the video" after the
 * fact.
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

/**
 * Post the resolved video as a reply to a single previously-sent alert message.
 * Falls through dual-camera → single video, and returns whether anything was
 * sent. A pure text fallback is intentionally NOT sent here — if the video
 * cannot be delivered we simply leave the original text alert untouched.
 */
async function postVideoReply(bot, chatId, replyToMessageId, {
  videoUrl,
  inwardVideoUrl,
  getVideoBuffer,
  caption,
  log = console,
}) {
  const replyOpts = replyToMessageId ? { reply_to_message_id: replyToMessageId } : {};

  if (videoUrl && inwardVideoUrl) {
    try {
      const [forwardBuf, inwardBuf] = await Promise.all([
        getVideoBuffer(videoUrl),
        getVideoBuffer(inwardVideoUrl),
      ]);
      await bot.sendMediaGroup(chatId, [
        { type: 'video', media: 'attach://forward', caption, parse_mode: 'HTML' },
        { type: 'video', media: 'attach://inward' },
      ], replyOpts, {
        forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
        inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
      });
      return true;
    } catch (dualErr) {
      log.error?.(`[VideoBackfill] dual-camera reply to ${chatId} failed, trying single: ${dualErr.message}`);
    }
  }

  if (videoUrl || inwardVideoUrl) {
    const singleUrl = videoUrl || inwardVideoUrl;
    try {
      const buffer = await getVideoBuffer(singleUrl);
      await bot.sendVideo(chatId, buffer, {
        caption,
        parse_mode: 'HTML',
        ...replyOpts,
      }, {
        filename: 'event.mp4',
        contentType: 'video/mp4',
      });
      return true;
    } catch (videoErr) {
      log.error?.(`[VideoBackfill] single-video reply to ${chatId} failed: ${videoErr.message}`);
    }
  }

  return false;
}

/**
 * Post the resolved video as a reply to every recorded alert message, using the
 * bot appropriate to each target (notification bot vs. driver bot).
 */
async function runVideoBackfill({
  sentMessages,
  videoUrls,
  resolveBot,
  getVideoBuffer,
  caption,
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
    try {
      const ok = await postVideoReply(bot, ref.chatId, ref.messageId, {
        videoUrl: videoUrls.forwardUrl,
        inwardVideoUrl: videoUrls.inwardUrl,
        getVideoBuffer,
        caption,
        log,
      });
      if (ok) posted += 1;
    } catch (err) {
      log.error?.(`[VideoBackfill] reply to ${ref.chatId} threw: ${err.message}`);
    }
  }
  return { posted, attempted };
}

const DEFAULT_BACKFILL_CAPTION = '🎥 <b>Event video is now available.</b>';

/**
 * Schedule the video backfill: after a delay, resolve the video and reply to the
 * original alert messages with it. Returns true if a backfill was scheduled.
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
        log.log?.(`[VideoBackfill] event ${eventId}: still no video after backfill; leaving text alerts as-is`);
        return;
      }
      const getVideoBuffer = typeof makeGetVideoBuffer === 'function' ? makeGetVideoBuffer() : null;
      if (!getVideoBuffer) {
        log.warn?.(`[VideoBackfill] event ${eventId}: no video downloader available, cannot post backfill`);
        return;
      }
      const res = await runVideoBackfill({ sentMessages, videoUrls: urls, resolveBot, getVideoBuffer, caption, log });
      log.log?.(`[VideoBackfill] event ${eventId}: posted video to ${res.posted}/${res.attempted} target(s)`);
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
  postVideoReply,
  runVideoBackfill,
  scheduleVideoBackfill,
  DEFAULT_BACKFILL_CAPTION,
  _forTest: { inFlight },
};
