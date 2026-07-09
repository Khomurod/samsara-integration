/**
 * Send a safety alert to a driver Telegram group with video → text fallbacks.
 *
 * Returns metadata about the message that was actually sent so the caller can
 * later reply to it (e.g. to attach the dashcam video once it becomes
 * available): `{ messageId, type }` where type is 'caption' (a video message)
 * or 'text' (a plain text fallback).
 *
 * DRIVER-GROUP MUSIC OVERLAY: an optional `prepareVideo(buffer, { role, ... })`
 * transform may be supplied. When present it is applied to the driver-group
 * video bytes BEFORE sending (e.g. to embed background music into speeding-event
 * clips). It must never throw and must return a valid video Buffer — on any
 * problem it returns the original bytes so the driver group still gets the clip.
 * This is BRANCH B only; the notifications-group path (broadcastDelivery's
 * sendNotificationToTarget) does NOT use it and is never affected.
 *
 * TELEGRAM SIZE GUARD: bot video uploads over 50 MB are always rejected by
 * api.telegram.org, so oversized buffers are never uploaded — we skip straight
 * to the text fallback (with a short note) instead of burning time on a doomed
 * multi-MB upload. The overlay service already compresses oversized outputs;
 * this guard is the last line of defence.
 */
const TELEGRAM_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_TOO_LARGE_NOTE = '\n\n⚠️ The dashcam video for this event is too large to deliver via Telegram.';

function isTooLargeForTelegram(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length > TELEGRAM_MAX_VIDEO_BYTES;
}

async function sendDriverGroupAlert(driverBot, groupId, {
    caption,
    videoUrl,
    inwardVideoUrl,
    getVideoBuffer,
    prepareVideo = null,
    videoContext = {},
    log = console,
}) {
    // Apply the optional music overlay to a driver-group video buffer. Defensive:
    // prepareVideo is expected to swallow its own errors, but we guard anyway so
    // a bug there can never drop the video.
    const applyMusic = async (buffer, role) => {
        if (!buffer || typeof prepareVideo !== 'function') return buffer;
        try {
            const out = await prepareVideo(buffer, { ...videoContext, role });
            return Buffer.isBuffer(out) && out.length > 0 ? out : buffer;
        } catch (err) {
            log.error?.(`[Bot] Driver music overlay failed (${err.message}); using original video.`);
            return buffer;
        }
    };

    let videoTooLarge = false;

    if (videoUrl && inwardVideoUrl) {
        try {
            const [forwardBuf, inwardBuf] = await Promise.all([
                getVideoBuffer(videoUrl),
                getVideoBuffer(inwardVideoUrl),
            ]);
            // Only the forward/road camera gets music; inward stays original to
            // avoid two overlapping music tracks in the same media group.
            const forwardOut = await applyMusic(forwardBuf, 'forward');
            if (isTooLargeForTelegram(forwardOut) || isTooLargeForTelegram(inwardBuf)) {
                // Only give up on video entirely when the FORWARD clip is the
                // oversized one; an oversized inward clip still lets the single
                // (forward-only) fallback below succeed.
                videoTooLarge = isTooLargeForTelegram(forwardOut);
                throw new Error(`video exceeds telegram 50MB limit (forward=${forwardOut.length}B inward=${inwardBuf.length}B) — skipping media-group upload`);
            }
            const mediaMessages = await driverBot.sendMediaGroup(groupId, [
                { type: 'video', media: 'attach://forward', caption, parse_mode: 'HTML' },
                { type: 'video', media: 'attach://inward' },
            ], {}, {
                forward: { value: forwardOut, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
            });
            const messageId = Array.isArray(mediaMessages) ? mediaMessages[0]?.message_id : undefined;
            return { messageId, type: 'caption' };
        } catch (dualErr) {
            log.error(`[Bot] Driver dual camera send failed — trying single video fallback:`, dualErr.message);
        }
    }

    if (videoUrl && !videoTooLarge) {
        try {
            const buffer = await getVideoBuffer(videoUrl);
            const outBuffer = await applyMusic(buffer, 'single');
            if (isTooLargeForTelegram(outBuffer)) {
                videoTooLarge = true;
                throw new Error(`video exceeds telegram 50MB limit (${outBuffer.length}B) — skipping upload`);
            }
            const sentVideo = await driverBot.sendVideo(groupId, outBuffer, {
                caption,
                parse_mode: 'HTML',
            }, {
                filename: 'event.mp4',
                contentType: 'video/mp4',
            });
            return { messageId: sentVideo?.message_id, type: 'caption' };
        } catch (videoErr) {
            log.error(`[Bot] Driver video send failed — falling back to text:`, videoErr.message);
        }
    }

    const textBody = videoTooLarge ? `${caption}${VIDEO_TOO_LARGE_NOTE}` : caption;
    const sentMessage = await driverBot.sendMessage(groupId, textBody, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    });
    return { messageId: sentMessage?.message_id, type: 'text' };
}

module.exports = {
    sendDriverGroupAlert,
};
