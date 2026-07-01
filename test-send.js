/**
 * test-send.js
 * Starts up the bot using long-polling temporarily so the user can send
 * a message to get their Chat ID, and then instantly broadcasts the mock
 * "Following Distance" event payload for format verification.
 */

const TelegramBot = require('node-telegram-bot-api');
const { formatAlert } = require('./src/formatter');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN || '';
if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
}

const bot = new TelegramBot(token, { polling: true });

// Simulated raw API response from Samsara for the user's uploaded event
const mockApiEvent = {
    "time": "2026-03-12T12:44:00Z", // 7:44 AM CDT
    "asset": {
        "id": "12345",
        "name": "2908 NIKE AUGUSTE"
    },
    "behaviorLabels": [
        { "label": "FollowingDistance" }
    ],
    "safetyEventType": "Following Distance",
    "speedingMetadata": null,
    "speedKilometersPerHour": 105.0, // approx 65 mph
    "speedLimitKilometersPerHour": 105.0,
    "severity": "moderate",
    "media": [
        {
            "input": "MEDIA_INPUT_PRIMARY", // Forward facing
            "url": "https://samsara.com/sample-video-url-forward.mp4"
        }
    ],
    "location": {
        "latitude": 30.2672,
        "longitude": -97.7431,
        "address": {
            "streetAddress": "I-35 Highway",
            "city": "Austin",
            "state": "TX"
        }
    },
    "driver": {
        "id": "999",
        "name": "John Doe" // Guessed driver name
    }
};

function transformApiEventToWebhookShape(event) {
    const happenedAtTime = event.time || new Date().toISOString();
    const vehicleName = event.asset?.name || 'Unknown Unit';

    const webhookPayload = {
        eventType: 'AlertIncident',
        eventTime: happenedAtTime,
        data: {
            happenedAtTime,
            incidentUrl: "https://cloud.samsara.com/o/123/fleet/safety/events/123",
            conditions: [{
                description: 'A safety event occurred',
                details: {
                    harshEvent: {
                        vehicle: { id: "12345", name: vehicleName },
                    }
                }
            }]
        }
    };

    const condition = webhookPayload.data.conditions[0];
    const details = condition.details;

    const behaviorLabel = event.behaviorLabels?.[0]?.label || event.safetyEventType || null;
    if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

    const mediaItems = event.media || [];
    const forwardUrl = mediaItems.find(m => m.input === 'MEDIA_INPUT_PRIMARY')?.url || null;

    if (forwardUrl) {
        details.harshEvent.mediaUrl = forwardUrl;
        webhookPayload._enrichedVideoUrl = forwardUrl;
    }

    const loc = event.location || null;
    if (loc?.latitude != null) {
        const addr = loc.address;
        const formatted = addr
            ? [addr.streetAddress, addr.city, addr.state].filter(Boolean).join(', ')
            : null;
        details.harshEvent.location = {
            latitude: loc.latitude,
            longitude: loc.longitude,
            formattedLocation: formatted,
        };
    }

    const speedKph = event.speedKilometersPerHour ?? null;
    if (speedKph != null) {
        details.speed = {
            currentSpeedKilometersPerHour: speedKph,
        };
    }

    if (event.severity) {
        details.safetyEvent = { severity: event.severity };
    }

    if (event.driver?.name) {
        details.harshEvent.driver = { name: event.driver.name, id: event.driver.id };
    }

    return webhookPayload;
}

console.log("Connecting to Telegram...");

// The webhook must be deleted for local long-polling to work
bot.deleteWebHook().then(() => {
    console.log("\n========================================================");
    console.log("✅ Ready! Please send /start or /test to @wenzesambot on Telegram.");
    console.log("========================================================\n");
});

bot.onText(/\/(start|test|ping)/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`\n[Telegram] Received command from chat ID: ${chatId}. Processing...`);
    
    try {
        console.log("[Telegram] Formatting event payload...");
        const mappedPayload = transformApiEventToWebhookShape(mockApiEvent);
        const result = formatAlert(mappedPayload);

        console.log("[Telegram] Sending text payload...");
        await bot.sendMessage(chatId, result.text, { 
            parse_mode: 'HTML', 
            disable_web_page_preview: true 
        });

        if (result.videoUrl) {
            console.log("[Telegram] Sending video payload...");
            await bot.sendMessage(chatId, "🎥 Sending video attachment...");
            // Just sending the URL as text since the mock URL is a dummy URL that Telegram can't locally download
            await bot.sendMessage(chatId, result.videoUrl);
        }
        
        console.log("\n✅ MESSAGE SUCCESSFULLY SENT TO YOUR PHONE!");
        console.log("Exiting test script...");
        process.exit(0);
        
    } catch (err) {
        console.error("\n❌ Failed to send:", err.message);
        process.exit(1);
    }
});
