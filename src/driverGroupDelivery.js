/**
 * Send a safety alert to a driver Telegram group with video → text fallbacks.
 *
 * Returns metadata about the message that was actually sent so the caller can
 * later reply to it (e.g. to attach the dashcam video once it becomes
 * available): `{ messageId, type }` where type is 'caption' (a video message)
 * or 'text' (a plain text fallback).
 */
async function sendDriverGroupAlert(driverBot, groupId, {
    caption,
    videoUrl,
    inwardVideoUrl,
    getVideoBuffer,
    log = console,
}) {
    if (videoUrl && inwardVideoUrl) {
        try {
            const [forwardBuf, inwardBuf] = await Promise.all([
                getVideoBuffer(videoUrl),
                getVideoBuffer(inwardVideoUrl),
            ]);
            const mediaMessages = await driverBot.sendMediaGroup(groupId, [
                { type: 'video', media: 'attach://forward', caption, parse_mode: 'HTML' },
                { type: 'video', media: 'attach://inward' },
            ], {}, {
                forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
            });
            const messageId = Array.isArray(mediaMessages) ? mediaMessages[0]?.message_id : undefined;
            return { messageId, type: 'caption' };
        } catch (dualErr) {
            log.error(`[Bot] Driver dual camera send failed — trying single video fallback:`, dualErr.message);
        }
    }

    if (videoUrl) {
        try {
            const buffer = await getVideoBuffer(videoUrl);
            const sentVideo = await driverBot.sendVideo(groupId, buffer, {
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

    const sentMessage = await driverBot.sendMessage(groupId, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    });
    return { messageId: sentMessage?.message_id, type: 'text' };
}

module.exports = {
    sendDriverGroupAlert,
};
