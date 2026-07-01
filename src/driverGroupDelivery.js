/**
 * Send a safety alert to a driver Telegram group with video → text fallbacks.
 */
async function sendDriverGroupAlert(driverBot, groupId, {
    caption,
    videoUrl,
    inwardVideoUrl,
    getVideoBuffer,
    log = console,
}) {
    let sent = false;

    if (videoUrl && inwardVideoUrl) {
        try {
            const [forwardBuf, inwardBuf] = await Promise.all([
                getVideoBuffer(videoUrl),
                getVideoBuffer(inwardVideoUrl),
            ]);
            await driverBot.sendMediaGroup(groupId, [
                { type: 'video', media: 'attach://forward', caption, parse_mode: 'HTML' },
                { type: 'video', media: 'attach://inward' },
            ], {}, {
                forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
            });
            sent = true;
        } catch (dualErr) {
            log.error(`[Bot] Driver dual camera send failed — trying single video fallback:`, dualErr.message);
        }
    }

    if (!sent && videoUrl) {
        try {
            const buffer = await getVideoBuffer(videoUrl);
            await driverBot.sendVideo(groupId, buffer, {
                caption,
                parse_mode: 'HTML',
            }, {
                filename: 'event.mp4',
                contentType: 'video/mp4',
            });
            sent = true;
        } catch (videoErr) {
            log.error(`[Bot] Driver video send failed — falling back to text:`, videoErr.message);
        }
    }

    if (!sent) {
        await driverBot.sendMessage(groupId, caption, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        });
    }

    return true;
}

module.exports = {
    sendDriverGroupAlert,
};
