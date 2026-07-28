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
const samsaraDb = require('./src/db');
const { determineTargetGroup } = require('./src/routing');
const { resolveDriverCaption } = require('./src/driverAlertMessageAi');
const { sendDriverGroupAlert } = require('./src/driverGroupDelivery');
const {
    isDriverMembershipAccessError,
    appendDriverMissingNote,
} = require('./src/deliveryWarnings');
const { deliverEvent } = require('./src/broadcastDelivery');
const { createDeliveryTracker, classifyTelegramError } = require('./src/deliveryTracker');
const { scheduleVideoBackfill } = require('./src/videoBackfill');
const { createSafetyEventVideoStore } = require('./src/safetyEventVideoSettings');
const { createDriverVideoProcessor } = require('./src/safetyEventVideoMusicService');
const { buildHealthReport } = require('./src/healthReport');

// /health tuning. A poll that has not succeeded within the stale threshold marks
// the service unhealthy (503) so an uptime monitor / Render health check can spot
// a dead poll coordinator even while the Express server still answers.
const HEALTH_STALE_THRESHOLD_MS = parseInt(process.env.HEALTH_STALE_THRESHOLD_MS || '300000', 10); // 5 min
const HEALTH_STARTUP_GRACE_MS = parseInt(process.env.HEALTH_STARTUP_GRACE_MS || '120000', 10); // 2 min
const SPEEDING_ENABLED = process.env.SAMSARA_SPEEDING_ENABLED !== 'false';

// Durable per-(event, target) delivery ledger — the source of truth for
// "already sent, do not send again".
const deliveryTracker = createDeliveryTracker(samsaraDb);

// DRIVER-GROUP music overlay (Branch B only). Reads settings + active music from
// the SHARED Postgres DB (written by the admin/hub) and embeds music into the
// driver group's speeding-video copy. It NEVER touches the notifications-group
// path and always falls back to the original video on any failure or when
// disabled / ffmpeg is unavailable.
const safetyVideoStore = createSafetyEventVideoStore({ pool: samsaraDb.getPgPool(), log: console });
const driverVideoProcessor = createDriverVideoProcessor({ store: safetyVideoStore, log: console });

// The Samsara notification bot's OWN token (e.g. @wenzesambot). Prefer the
// explicit SAMSARA_BOT_TOKEN when set — this bot is what must be a member of
// the "Samsara Notifications" group. Fall back to TELEGRAM_BOT_TOKEN for
// backward compatibility with older deployments.
const SAMSARA_BOT_TOKEN = String(process.env.SAMSARA_BOT_TOKEN || '').trim();
const LEGACY_TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TOKEN = SAMSARA_BOT_TOKEN || LEGACY_TELEGRAM_BOT_TOKEN;
const TOKEN_SOURCE = SAMSARA_BOT_TOKEN ? 'SAMSARA_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_VIDEO_BYTES = parseInt(process.env.SAMSARA_MAX_VIDEO_BYTES || '0', 10);
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true'; // For Telegram itself, if hosted
const PUBLIC_URL = (process.env.PUBLIC_WEBHOOK_URL || '').replace(/\/$/, '');
const SELF_URL = process.env.RENDER_EXTERNAL_URL || PUBLIC_URL;

if (!TOKEN) {
    console.error('[Samsara] FATAL: SAMSARA_BOT_TOKEN (or legacy TELEGRAM_BOT_TOKEN) is required.');
    process.exit(78); // EX_CONFIG
}
console.log(`[Samsara] Notification bot token loaded from ${TOKEN_SOURCE}.`);

// Prevent a nightmare dual-polling configuration: if this process were
// started with the same BOT_TOKEN as the main Telegraf bot, both would
// race for getUpdates(), constantly stealing the long-poll from each
// other. Exit with code 78 (EX_CONFIG) so the parent knows not to restart.
const resolvedMainBotToken = String(process.env.BOT_TOKEN || '').trim();
if (resolvedMainBotToken && resolvedMainBotToken === TOKEN) {
    console.error(
        '[Samsara] FATAL: Samsara notification bot token equals the main feedback BOT_TOKEN. '
        + 'This would cause getUpdates() polling conflicts. Use distinct bots.',
    );
    process.exit(78); // EX_CONFIG — permanent configuration error, do not restart
}

// ?? Express App (Health checks & optionally Telegram Webhook only) ????????????
const app = express();
app.use(express.json());
let httpServer = null;

app.get('/health', (req, res) => {
    // Lightweight, in-memory only (no DB / network) so an uptime monitor can call
    // it every few minutes safely. Reports real poll liveness, not just that
    // Express is up, and returns 503 when polling has gone stale/stopped.
    try {
        const report = buildHealthReport({
            now: Date.now(),
            uptimeSeconds: process.uptime(),
            coordinatorRunning: typeof coordinator.isRunning === 'function' ? coordinator.isRunning() : false,
            staleThresholdMs: HEALTH_STALE_THRESHOLD_MS,
            startupGraceMs: HEALTH_STARTUP_GRACE_MS,
            safety: typeof poller.getStatus === 'function' ? poller.getStatus() : {},
            speeding: typeof speedingPoller.getStatus === 'function'
                ? speedingPoller.getStatus()
                : { enabled: SPEEDING_ENABLED },
        });
        res.status(report.statusCode).json(report.body);
    } catch (err) {
        // /health must never throw; fall back to the legacy minimal shape.
        res.status(200).json({
            status: 'ok',
            uptime: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
            healthDetailError: err.message,
        });
    }
});

// Plain root — some uptime pingers hit "/". Keep it tiny, auth-free, and 200.
app.get('/', (req, res) => {
    res.json({ service: 'samsara-integration', status: 'ok' });
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

// Ensure the queue in poller.js knows how to send messages.
//
// Delegates the actual per-target, idempotent delivery to deliverEvent() in
// src/broadcastDelivery.js. This function just wires the real collaborators
// (bots, store, video downloader, delivery ledger) and manages the per-call
// video download cache.
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

    const forcedId = process.env.HARDCODED_GROUP_ID || "-5192934125";
    const MANAGEMENT_GROUP_ID = process.env.MANAGEMENT_GROUP_ID || process.env.EMPLOYEE_GROUP_ID;

    let result;
    try {
        result = await deliverEvent(alertData, {
            bot,
            driverBot,
            store,
            determineTargetGroup,
            resolveDriverCaption,
            sendDriverGroupAlert,
            isDriverMembershipAccessError,
            appendDriverMissingNote,
            tracker: deliveryTracker,
            classifyTelegramError,
            forcedId,
            managementGroupId: MANAGEMENT_GROUP_ID,
            getVideoBuffer,
            // Driver-group-only music overlay. Applied inside sendDriverGroupAlert
            // to the driver group's video copy; the notifications group is never
            // routed through this.
            prepareDriverVideo: driverVideoProcessor.prepareDriverVideoBuffer,
            log: console,
        });
    } finally {
        videoCache.clear();
    }

    // The alert was sent immediately. If it went out without video, schedule a
    // backfill: resolve/generate the dashcam video shortly after and post it as
    // a reply under each original alert (notifications group + subscribers +
    // driver group). deliverEvent throws on transient failure, so we only reach
    // here after a clean delivery run.
    const backfill = alertData && typeof alertData === 'object' ? alertData.videoBackfill : null;
    if (backfill && result && !result.hadVideoAtSend && result.sentMessages?.length) {
        scheduleVideoBackfill({
            eventId: backfill.eventId,
            rawEvent: backfill.rawEvent,
            sentMessages: result.sentMessages,
            apiKey: process.env.SAMSARA_API_KEY,
            baseUrl: process.env.SAMSARA_API_BASE || 'https://api.samsara.com',
            resolveBot: (kind) => (kind === 'driver' ? driverBot : bot),
            // Each backfill uses its own short-lived download cache; the video
            // URLs are freshly resolved (pre-signed, time-limited) at backfill time.
            makeGetVideoBuffer: () => {
                const cache = new Map();
                return async (url) => {
                    if (!url) return null;
                    if (!cache.has(url)) {
                        cache.set(url, downloadVideo(url).catch((err) => {
                            cache.delete(url);
                            throw err;
                        }));
                    }
                    return cache.get(url);
                };
            },
            refetchFn: backfill.refetchFn || undefined,
            retrievalFn: backfill.retrievalFn || undefined,
            delayMs: backfill.delayMs,
            // Driver-group-only music overlay for the backfilled video copy.
            prepareDriverVideo: driverVideoProcessor.prepareDriverVideoBuffer,
            isSpeeding: Boolean(alertData && typeof alertData === 'object' && alertData.isSpeeding),
        });
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

    // Best-effort self-check: confirm WHICH bot we are and whether it can
    // actually reach the hardcoded "Samsara Notifications" group. This makes a
    // wrong-token / not-a-member misconfiguration obvious in the logs instead
    // of showing up only as repeated "chat not found" during delivery.
    await verifyNotificationBotAccess();

    // Readiness self-check for the driver-group music overlay (Branch B). Makes
    // "why is there no music?" answerable from the logs alone.
    await logMusicOverlayReadiness();

    // Start coordinated polling
    coordinator.start();
}

/**
 * Log the driver-group music-overlay readiness WITHOUT leaking secrets or signed
 * URLs: DB pool present? settings readable? driver-group music enabled? active
 * music present? ffmpeg available? Every branch degrades to the original video,
 * so this is diagnostics only — it never blocks startup.
 */
async function logMusicOverlayReadiness() {
    const tag = '[SafetyVideo]';
    try {
        const hasPool = Boolean(samsaraDb.getPgPool && samsaraDb.getPgPool());
        console.log(`${tag} Readiness: DATABASE_URL/pool ${hasPool ? 'present' : 'MISSING (overlay disabled)'}.`);

        let ffmpegOk = false;
        try { ffmpegOk = await driverVideoProcessor.ffmpeg.isAvailable(); } catch (_) { ffmpegOk = false; }
        console.log(`${tag} Readiness: ffmpeg ${ffmpegOk ? 'available' : 'NOT available — driver videos will be sent WITHOUT music'} `
            + `(path=${driverVideoProcessor.ffmpeg.ffmpegPath}).`);

        // loadConfig() never throws; it returns { enabled, reason, music, ... }.
        const cfg = await safetyVideoStore.loadConfig();
        if (cfg.enabled) {
            console.log(`${tag} Readiness: driver-group music ENABLED; active music asset id=${cfg.music?.id ?? 'n/a'}`
                + `${cfg.speedingMusicEnabled === false ? ' (speeding overlay OFF)' : ''}.`);
            if (!ffmpegOk) {
                console.warn(`${tag} Readiness: music is configured but ffmpeg is unavailable — install @ffmpeg-installer/ffmpeg `
                    + 'or set FFMPEG_PATH. Until then the driver group receives the original video.');
            }
        } else {
            const why = {
                'no-db': 'no database pool',
                disabled: 'driver_group_music_enabled is FALSE',
                'no-active-music': 'no active_music_asset_id set',
                'active-music-missing': 'active music row/bytes missing',
                error: 'settings read error (table missing or transient)',
            }[cfg.reason] || cfg.reason || 'unknown';
            console.log(`${tag} Readiness: driver-group music overlay is OFF — reason: ${why}.`);
        }
    } catch (err) {
        console.warn(`${tag} Readiness self-check skipped: ${err.message}`);
    }
}

async function verifyNotificationBotAccess() {
    try {
        const me = await bot.getMe();
        console.log(`[Samsara] Notification bot is @${me.username} (id ${me.id}), token from ${TOKEN_SOURCE}.`);
        const forcedId = process.env.HARDCODED_GROUP_ID || '-5192934125';
        try {
            const chat = await bot.getChat(forcedId);
            console.log(`[Samsara] ✓ @${me.username} can access notifications group "${chat.title || forcedId}" (${forcedId}).`);
        } catch (chatErr) {
            console.error(
                `[Samsara] ✗ @${me.username} CANNOT access notifications group ${forcedId}: ${chatErr.message}. `
                + 'Add this bot to that group, or point SAMSARA_BOT_TOKEN at the bot that IS a member. '
                + 'Delivery to the notifications group will be skipped as a permanent failure until fixed.',
            );
        }
    } catch (err) {
        console.warn('[Samsara] Startup bot self-check skipped:', err.message);
    }
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


