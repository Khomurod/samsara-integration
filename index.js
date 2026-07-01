/**
 * index.js
 * Entry point for the Samsara Telegram Bot (Polling Architecture).
 *
 * Credentials are loaded from environment variables.
 * Keep secrets out of source files and store them in your secret manager.
 */

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const coordinator = require('./src/pollCoordinator');
const store = require('./src/store');
const { determineTargetGroup } = require('./src/routing');
const { resolveDriverCaption } = require('./src/driverAlertMessageAi');
const { sendDriverGroupAlert } = require('./src/driverGroupDelivery');
const {
    isDriverMembershipAccessError,
    appendDriverMissingNote,
    shouldRetryDelivery,
} = require('./src/deliveryWarnings');

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_VIDEO_BYTES = parseInt(process.env.SAMSARA_MAX_VIDEO_BYTES || '0', 10);
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true'; // For Telegram itself, if hosted
const PUBLIC_URL = (process.env.PUBLIC_WEBHOOK_URL || '').replace(/\/$/, '');
const SELF_URL = process.env.RENDER_EXTERNAL_URL || PUBLIC_URL;

if (!TOKEN) {
    console.error('[Samsara] FATAL: TELEGRAM_BOT_TOKEN is required.');
    process.exit(78); // EX_CONFIG
}

// Prevent a nightmare dual-polling configuration: if this process were
// started with the same BOT_TOKEN as the main Telegraf bot, both would
// race for getUpdates(), constantly stealing the long-poll from each
// other. Exit with code 78 (EX_CONFIG) so the parent knows not to restart.
const resolvedMainBotToken = String(process.env.BOT_TOKEN || '').trim();
if (resolvedMainBotToken && resolvedMainBotToken === TOKEN) {
    console.error(
        '[Samsara] FATAL: Samsara TELEGRAM_BOT_TOKEN equals the main feedback BOT_TOKEN. '
        + 'This would cause getUpdates() polling conflicts. Use distinct bots.',
    );
    process.exit(78); // EX_CONFIG — permanent configuration error, do not restart
}

// ?? Express App (Health checks & optionally Telegram Webhook only) ????????????
const app = express();
app.use(express.json());
let httpServer = null;

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// ?? Broadcast helper ??????????????????????????????????????????????????????????
const { parseTrustedVideoUrl } = require('./src/videoUrl');

async function downloadVideo(videoUrl) {
    // Before touching the network, parse the URL and enforce an allow-list
    // of Samsara/CloudFront hostnames. Previously we did a substring check
    // which was spoofable (e.g. https://evil.test/?x=api.samsara.com).
    const parsed = parseTrustedVideoUrl(videoUrl);
    const host = parsed.hostname.toLowerCase();

    const fetchHeaders = {};
    const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
    // Samsara media URLs are pre-signed CloudFront CDN URLs that embed auth in query params
    // (Signature=, Key-Pair-Id=, Expires=). Adding an Authorization header to a pre-signed
    // URL causes CloudFront/S3 to return HTTP 400 "conflicting auth methods".
    // Only add the header for direct Samsara REST API endpoints.
    const isPreSigned = /[?&](Signature|X-Amz-Signature|AWSAccessKeyId|Key-Pair-Id)=/i.test(parsed.search);
    if (SAMSARA_API_KEY && !isPreSigned && host === 'api.samsara.com') {
        fetchHeaders['Authorization'] = `Bearer ${SAMSARA_API_KEY}`;
    }
    const response = await fetch(parsed.toString(), { 
        headers: fetchHeaders,
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
        if (response.body && typeof response.body.resume === 'function') {
            response.body.resume();
        } else if (response.body && typeof response.body.cancel === 'function') {
            response.body.cancel();
        }
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    
    const resolvedMax = MAX_VIDEO_BYTES > 0 ? MAX_VIDEO_BYTES : 25 * 1024 * 1024;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > resolvedMax) {
        if (response.body && typeof response.body.resume === 'function') {
            response.body.resume();
        } else if (response.body && typeof response.body.cancel === 'function') {
            response.body.cancel();
        }
        throw new Error(`Video exceeds max size (${contentLength} bytes > ${resolvedMax} bytes)`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('video') && !contentType.includes('octet-stream')) {
        console.warn(`[Bot] Unexpected content-type "${contentType}" ? may not be a direct video link`);
    }
    
    const reader = response.body.getReader();
    const chunks = [];
    let downloadedBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            downloadedBytes += value.length;
            if (downloadedBytes > resolvedMax) {
                reader.cancel();
                throw new Error(`Video exceeds max size after download (${downloadedBytes} bytes > ${resolvedMax} bytes)`);
            }
            chunks.push(Buffer.from(value));
        }
    }
    
    const buffer = Buffer.concat(chunks);
    console.log(`[Bot] Downloaded ${(buffer.length / 1024).toFixed(1)} KB from ${videoUrl}`);
    return buffer;
}

// Ensure the queue in poller.js knows how to send messages
async function broadcast(alertData) {
    const videoCache = new Map();
    const getVideoBuffer = async (url) => {
        if (!url) return null;
        if (!videoCache.has(url)) {
            const promise = downloadVideo(url).catch((err) => {
                videoCache.delete(url);
                throw err;
            });
            videoCache.set(url, promise);
        }
        return videoCache.get(url);
    };

    const subscribers = await store.getAll();
    
    // Always include the hardcoded group ID for "Samsara Notifications"
    const forcedId = process.env.HARDCODED_GROUP_ID || "-5192934125";
    if (!subscribers.map(String).includes(String(forcedId))) {
        subscribers.push(String(forcedId));
    }

    const text = typeof alertData === 'string' ? alertData : alertData.text;
    const videoUrl = typeof alertData === 'string' ? null : alertData.videoUrl;
    const inwardVideoUrl = typeof alertData === 'string' ? null : alertData.inwardVideoUrl;
    const eventId = typeof alertData === 'string' ? null : alertData.samsaraEventId;
    const alertObj = typeof alertData === 'string' ? {} : alertData;

    let notificationsStatus = 'skip';
    let driverStatus = 'skip';
    const sentNotificationMessages = [];

    // 1) Send notification first with @wenzesambot.
    if (subscribers.length === 0) {
        console.warn('[Bot] No subscribers to broadcast to.');
        notificationsStatus = 'skip';
    } else {
        console.log(`[Bot] Broadcasting to ${subscribers.length} subscriber(s)...`);
        let notificationsOk = 0;
        let notificationsFail = 0;
        let forcedDelivered = false;

        for (const chatId of subscribers) {
            try {
                if (videoUrl && inwardVideoUrl) {
                    console.log(`[Bot] Dual camera detected, sending media group to ${chatId}`);
                    try {
                        const [forwardBuf, inwardBuf] = await Promise.all([
                            getVideoBuffer(videoUrl),
                            getVideoBuffer(inwardVideoUrl),
                        ]);
                        const mediaMessages = await bot.sendMediaGroup(chatId, [
                            { type: 'video', media: 'attach://forward', caption: text, parse_mode: 'HTML' },
                            { type: 'video', media: 'attach://inward' },
                        ], {}, {
                            forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
                            inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
                        });
                        if (Array.isArray(mediaMessages) && mediaMessages[0]?.message_id) {
                            sentNotificationMessages.push({
                                chatId,
                                messageId: mediaMessages[0].message_id,
                                type: 'caption',
                            });
                        }
                        console.log(`[Bot] Successfully sent dual-camera media group to ${chatId}`);
                        notificationsOk += 1;
                        if (String(chatId) === String(forcedId)) forcedDelivered = true;
                        continue;
                    } catch (dualErr) {
                        console.error('[Bot] Dual camera send failed, trying single video fallback:', dualErr.message);
                    }
                }

                if (videoUrl) {
                    console.log(`[Bot] Fetching single video for ${chatId} from: ${videoUrl}`);
                    try {
                        const buffer = await getVideoBuffer(videoUrl);
                        const sentVideo = await bot.sendVideo(chatId, buffer, {
                            caption: text,
                            parse_mode: 'HTML',
                        }, {
                            filename: 'event.mp4',
                            contentType: 'video/mp4',
                        });
                        if (sentVideo?.message_id) {
                            sentNotificationMessages.push({
                                chatId,
                                messageId: sentVideo.message_id,
                                type: 'caption',
                            });
                        }
                        console.log(`[Bot] Successfully sent video to ${chatId}`);
                        notificationsOk += 1;
                        if (String(chatId) === String(forcedId)) forcedDelivered = true;
                        continue;
                    } catch (videoErr) {
                        console.error('[Bot] Video send failed, falling back to text:', videoErr.message);
                    }
                }

                const sentMessage = await bot.sendMessage(chatId, text, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                });
                if (sentMessage?.message_id) {
                    sentNotificationMessages.push({
                        chatId,
                        messageId: sentMessage.message_id,
                        type: 'text',
                    });
                }
                console.log(`[Bot] Successfully sent text alert to ${chatId}`);
                notificationsOk += 1;
                if (String(chatId) === String(forcedId)) forcedDelivered = true;
            } catch (err) {
                notificationsFail += 1;
                console.error(`[Bot] Failed to send to ${chatId}:`, err.message);
                if (err.response?.body?.error_code === 403) {
                    console.log(`[Bot] Removing blocked user ${chatId}`);
                    store.remove(chatId);
                }
            }
        }

        notificationsStatus = forcedDelivered ? 'ok' : (notificationsFail > 0 || notificationsOk > 0 ? 'fail' : 'skip');
    }

    // 2) Then try forwarding to driver group with @wenzefeedback_bot.
    const MANAGEMENT_GROUP_ID = process.env.MANAGEMENT_GROUP_ID || process.env.EMPLOYEE_GROUP_ID;
    const target = await determineTargetGroup(
        alertObj,
        store.findGroupByUnit.bind(store),
        MANAGEMENT_GROUP_ID,
    );
    const targetDriverGroupId = target.targetGroupId;
    const unitLabel = target.unitNumber || 'unknown';

    if (target.matchReason.startsWith('fallback')) {
        console.warn(`[Bot] Unmapped vehicle ${target.vehicleId || 'unknown'} unit ${unitLabel} - no driver group mapped, skipping driver forward`);
    } else {
        console.log(`[Bot] Routed vehicle ${target.vehicleId || 'unknown'} unit ${target.unitNumber} to ${target.groupName || targetDriverGroupId} (${targetDriverGroupId}) via ${target.matchReason}`);
    }

    let driverCaption = text;
    if (targetDriverGroupId && driverBot && !target.matchReason.startsWith('fallback')) {
        try {
            driverCaption = await resolveDriverCaption(alertObj, text);
        } catch (aiErr) {
            console.error('[Bot] Driver caption AI failed, using standard text:', aiErr.message);
            driverCaption = text;
        }
    }

    let driverMembershipAccessError = false;
    if (targetDriverGroupId && driverBot) {
        console.log(`[Bot] Forwarding alert for Unit #${unitLabel} to group ${targetDriverGroupId}...`);
        driverStatus = 'fail';
        try {
            await sendDriverGroupAlert(driverBot, targetDriverGroupId, {
                caption: driverCaption,
                videoUrl,
                inwardVideoUrl,
                getVideoBuffer,
            });
            driverStatus = 'ok';
            console.log(`[Bot] Successfully forwarded to Driver Group ${targetDriverGroupId}`);
        } catch (err) {
            driverMembershipAccessError = isDriverMembershipAccessError(err);
            console.error(`[Bot] Forwarding failed to ${targetDriverGroupId}:`, err.message);
        }
    }

    if (driverMembershipAccessError && notificationsStatus === 'ok') {
        const notedText = appendDriverMissingNote(text);
        for (const sent of sentNotificationMessages) {
            try {
                if (sent.type === 'text') {
                    await bot.editMessageText(notedText, {
                        chat_id: sent.chatId,
                        message_id: sent.messageId,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                    });
                } else {
                    await bot.editMessageCaption(notedText, {
                        chat_id: sent.chatId,
                        message_id: sent.messageId,
                        parse_mode: 'HTML',
                    });
                }
            } catch (noteErr) {
                console.error(`[Bot] Failed to append driver warning note for ${sent.chatId}:`, noteErr.message);
            }
        }
    }

    console.log(
        `[Bot] Broadcast complete event=${eventId || 'unknown'} notifications=${notificationsStatus} driver=${driverStatus} unit=${unitLabel}`,
    );

    videoCache.clear();

    if (shouldRetryDelivery(notificationsStatus)) {
        throw new Error(`Notification delivery failed for event ${eventId || 'unknown'}`);
    }
}


// ?? Telegram Bot Setup ????????????????????????????????????????????????????????
let bot;
let driverBot;

if (USE_WEBHOOK) {
    bot = new TelegramBot(TOKEN, { polling: false });
    const telegramWebhookPath = `/telegram-webhook/${TOKEN}`;
    app.post(telegramWebhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
} else {
    bot = new TelegramBot(TOKEN, { polling: true });
}

// Initialize Driver Bot (Main / feedback bot token ? send-only)
const MAIN_BOT_TOKEN = resolvedMainBotToken;
if (MAIN_BOT_TOKEN) {
    console.log('[Bot] Initializing driverBot with main BOT_TOKEN');
    driverBot = new TelegramBot(MAIN_BOT_TOKEN, { polling: false });
}

const poller = require('./src/poller');
const speedingPoller = require('./src/speedingPoller');
poller.setBroadcastFn(broadcast);
speedingPoller.setBroadcastFn(broadcast);

// ?? Bot Commands ??????????????????????????????????????????????????????????????
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name || 'there';
    const added = await store.add(chatId);
    bot.sendMessage(chatId,
        added
            ? `? *Welcome, ${firstName}!*\n\nYou are now subscribed to *Samsara fleet alerts*.\nWhenever an alert fires, I'll send it here instantly.\n\nUse /help to see all commands.`
            : `?? Hey ${firstName}! You're already subscribed.\nUse /help to see all commands.`,
        { parse_mode: 'Markdown' }
    );
    console.log(`[Bot] /start from chatId=${chatId} (${msg.from?.username || 'unknown'})`);
});

bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    const removed = await store.remove(chatId);
    bot.sendMessage(chatId,
        removed
            ? `?? *You have been unsubscribed.*\n\nSend /start at any time to re-subscribe.`
            : `?? You are not currently subscribed.\nSend /start to subscribe.`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const subscribed = store.has(chatId);
    bot.sendMessage(chatId,
        subscribed
            ? `? *You are subscribed* to Samsara alerts.\n_Total subscribers: ${store.count()}_`
            : `?? *You are not subscribed.*\nSend /start to subscribe.\n_Total subscribers: ${store.count()}_`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `?? *Samsara Alert Bot ? Commands*\n\n` +
        `/start ? Subscribe to Samsara alerts\n` +
        `/stop ? Unsubscribe from alerts\n` +
        `/status ? Check your subscription status\n` +
        `/help ? Show this help message`,
        { parse_mode: 'Markdown' }
    );
});

// ?? Start Server ??????????????????????????????????????????????????????????????
async function start() {
    await store.init();
    const samsaraDb = require('./src/db');
    await samsaraDb.initPgDb();
    await new Promise((resolve) => {
        httpServer = app.listen(PORT, resolve);
    });

    console.log('');
    console.log('????????????????????????????????????????????????');
    console.log('?      Samsara ? Telegram Bot (Polling Mode)   ?');
    console.log('????????????????????????????????????????????????');
    console.log(`? Express server listening on port ${PORT} (Health checks)`);
    console.log(`?? Subscribers loaded: ${store.count()}`);

    if (USE_WEBHOOK && SELF_URL) {
        const telegramWebhookUrl = `${SELF_URL}/telegram-webhook/${TOKEN}`;
        try {
            await bot.setWebHook(telegramWebhookUrl);
            console.log(`? Telegram webhook set: ${telegramWebhookUrl}`);
        } catch (err) {
            console.error('[Bot] Failed to set Telegram webhook:', err.message);
        }
        console.log(`? Telegram bot is online (webhook mode)`);

        // Keep-alive
        const https = require('https');
        const http = require('http');
        setInterval(() => {
            const url = `${SELF_URL}/health`;
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                console.log(`[KeepAlive] Pinged ${url} ? ${res.statusCode}`);
            }).on('error', (err) => {
                console.warn(`[KeepAlive] Ping failed: ${err.message}`);
            });
        }, 14 * 60 * 1000);

    } else {
        console.log(`? Telegram bot is online (long-polling mode)`);
    }

    console.log('');
    console.log('?? Bot is ready! Send /start to @wenzesambot on Telegram');
    console.log('');

    // Start coordinated polling
    coordinator.start();
}

start().catch((err) => {
    console.error('[App] Fatal startup error:', err.message);
    process.exit(1);
});

let isShuttingDown = false;
async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[App] Shutting down (${signal})...`);
    coordinator.stop();
    if (!USE_WEBHOOK) {
        try {
            await bot.stopPolling();
        } catch (err) {
            console.warn('[App] Failed to stop Telegram polling:', err.message);
        }
    }
    if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
        httpServer = null;
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('[App] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[App] Rejection:', reason));


