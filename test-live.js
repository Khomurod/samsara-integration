/**
 * test-live.js
 * Fetches the latest safety event from Samsara API and shows what the Telegram
 * message would look like. Does NOT send to Telegram.
 *
 * Usage:
 *   node test-live.js <SAMSARA_API_KEY>
 *   -- or --
 *   set SAMSARA_API_KEY=your_key && node test-live.js
 */

const { formatAlert } = require('./src/formatter');

const API_KEY = process.argv[2] || process.env.SAMSARA_API_KEY;

if (!API_KEY) {
    console.error('ERROR: Provide Samsara API key as argument: node test-live.js <API_KEY>');
    process.exit(1);
}

async function main() {
    // ── Step 1: Fetch latest safety event from Samsara API ─────────────────
    const endTime   = new Date().toISOString();
    const startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // last 7 days

    const params = new URLSearchParams({
        startTime,
        endTime,
        includeDriver: 'true',
        limit: '1',
    });

    const url = `https://api.samsara.com/fleet/safety-events?${params}`;
    console.log(`\n[Test] Fetching latest safety event from:\n  ${url}\n`);

    const apiRes = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
        },
    });

    if (!apiRes.ok) {
        const body = await apiRes.text();
        console.error(`[Test] API error ${apiRes.status}: ${body}`);
        process.exit(1);
    }

    const json = await apiRes.json();
    const events = json.data || [];

    if (events.length === 0) {
        console.log('[Test] No safety events found in the last 7 days.');
        process.exit(0);
    }

    const event = events[0];
    console.log('[Test] Raw API event response:\n', JSON.stringify(event, null, 2));

    // ── Step 2: Simulate what webhook.js does — build a webhook-style payload ─
    // and merge the enriched API data into it to simulate what happens at runtime.
    const happenedAtTime = event.time || event.happenedAtTime || new Date().toISOString();
    const vehicleName = event.asset?.name || event.vehicle?.name || 'Unknown Unit';
    const vehicleId   = event.asset?.id   || event.vehicle?.id   || null;

    // Build a minimal webhook-style payload (like Samsara would send)
    const webhookPayload = {
        eventType: 'AlertIncident',
        eventTime: happenedAtTime,
        data: {
            happenedAtTime,
            incidentUrl: event.incidentUrl || null,
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

    // Merge enriched data (mirrors mergeEnrichedData in webhook.js)
    const condition  = webhookPayload.data.conditions[0];
    const details    = condition.details;

    // Event type
    const behaviorLabel =
        event.behaviorLabels?.[0]?.label ||
        event.behaviorLabel ||
        event.type ||
        null;
    if (behaviorLabel) webhookPayload._enrichedEventType = behaviorLabel;

    // Video
    const mediaItems = event.media || [];
    const forwardUrl = mediaItems.find(m => m.input === 'dashcamRoadFacing')?.url
        || event.downloadForwardVideoUrl || event.mediaUrl || null;
    const inwardUrl  = mediaItems.find(m => m.input === 'dashcamDriverFacing')?.url
        || event.downloadInwardVideoUrl || null;

    if (forwardUrl) {
        details.harshEvent.mediaUrl = forwardUrl;
        webhookPayload._enrichedVideoUrl = forwardUrl;
    }
    if (inwardUrl) {
        webhookPayload._enrichedVideoUrlInward = inwardUrl;
    }

    // Location
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

    // Speed
    const speedKph = event.speedingMetadata?.maxSpeedKilometersPerHour ?? null;
    const limitKph = event.speedingMetadata?.postedSpeedLimitKilometersPerHour ?? null;
    if (speedKph != null) {
        details.speed = {
            currentSpeedKilometersPerHour:   speedKph,
            thresholdSpeedKilometersPerHour: limitKph,
        };
    }

    // Severity
    if (event.severity) {
        details.safetyEvent = { severity: event.severity };
    }

    // Driver
    if (event.driver?.name && !details.harshEvent.driver) {
        details.harshEvent.driver = { name: event.driver.name, id: event.driver.id };
    }

    // ── Step 3: Run through the formatter ────────────────────────────────────
    const result = formatAlert(webhookPayload);

    console.log('\n═══════════════════════════════════════════════');
    console.log('  TELEGRAM MESSAGE TEXT (as would be sent):');
    console.log('═══════════════════════════════════════════════');
    console.log(result.text);
    console.log('═══════════════════════════════════════════════');
    console.log(`\nForward video URL : ${result.videoUrl   || 'none'}`);
    console.log(`Inward  video URL : ${result.inwardVideoUrl || 'none'}`);
    console.log('\n[Test] Done. No messages were sent to Telegram.');
}

main().catch(err => {
    console.error('[Test] Unexpected error:', err);
    process.exit(1);
});
