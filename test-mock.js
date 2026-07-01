/**
 * test-mock.js
 * Mocks the Samsara API response for the "Following Distance" event 
 * provided by the user in the screenshot to verify Telegram output formatting.
 */

const { formatAlert } = require('./src/formatter');

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

// Mirroring the transformation logic directly from poller.js
function transformApiEventToWebhookShape(event) {
    const happenedAtTime = event.time || event.happenedAtTime || new Date().toISOString();
    const vehicleName = event.asset?.name || event.vehicle?.name || 'Unknown Unit';
    const vehicleId   = event.asset?.id   || event.vehicle?.id   || null;

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
                        vehicle: vehicleId ? { id: vehicleId, name: vehicleName } : undefined,
                    }
                }
            }]
        }
    };

    const condition = webhookPayload.data.conditions[0];
    const details = condition.details;

    const behaviorLabel =
        event.behaviorLabels?.[0]?.label ||
        event.behaviorLabel ||
        event.type ||
        event.safetyEventType ||
        null;
    if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

    const mediaItems = event.media || [];
    const forwardUrl = mediaItems.find(m => m.input === 'MEDIA_INPUT_PRIMARY')?.url 
        || event.mediaUrl || null;
    const inwardUrl  = mediaItems.find(m => m.input === 'MEDIA_INPUT_SECONDARY')?.url 
        || null;

    if (forwardUrl) {
        details.harshEvent.mediaUrl = forwardUrl;
        webhookPayload._enrichedVideoUrl = forwardUrl;
    }
    if (inwardUrl) {
        webhookPayload._enrichedVideoUrlInward = inwardUrl;
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

try {
    const mappedPayload = transformApiEventToWebhookShape(mockApiEvent);
    const result = formatAlert(mappedPayload);

    console.log('\n═══════════════════════════════════════════════');
    console.log('  TELEGRAM MESSAGE TEXT (MOCKED EVENT RESULT):');
    console.log('═══════════════════════════════════════════════\n');
    console.log(result.text);
    console.log('\n═══════════════════════════════════════════════');
    console.log(`Forward video URL : ${result.videoUrl   || 'none'}`);
    console.log(`Inward  video URL : ${result.inwardVideoUrl || 'none'}`);
    console.log('═══════════════════════════════════════════════\n');
} catch (e) {
    console.error("Formatting failed:", e);
}
