/**
 * formatter.js
 * Converts raw Samsara webhook payloads into clean, human-readable
 * Telegram messages with emojis for quick scanning.
 *
 * Handles Samsara "AlertIncident" payloads where data is nested in:
 *   data.conditions[].details.{speed|harshEvent|geofence|...}
 */

// ── Emoji map ─────────────────────────────────────────────────────────────────
const CONDITION_EMOJIS = {
    'vehicle speed': '🚨',
    'harsh event': '⚠️',
    'harsh braking': '⚠️',
    'harsh acceleration': '⚠️',
    'harsh turn': '⚠️',
    'collision': '💥',
    'speeding': '🚨',
    'geofence': '📍',
    'geofence entry': '📍',
    'geofence exit': '📍',
    'driver distraction': '👁️',
    'drowsiness': '😴',
    'seatbelt': '🪑',
    'mobile usage': '📱',
    'hos violation': '📋',
    'engine fault': '🔧',
    'maintenance': '🔧',
    'fuel': '⛽',
    'tire pressure': '🛞',
    'gateway unplugged': '🔌',
    'camera disconnected': '📷',
    'dash cam disconnected': '📷',
    default: '🔔',
};

function getEmoji(description) {
    if (!description) return CONDITION_EMOJIS.default;
    const lower = description.toLowerCase();
    for (const [key, emoji] of Object.entries(CONDITION_EMOJIS)) {
        if (key !== 'default' && lower.includes(key)) return emoji;
    }
    return CONDITION_EMOJIS.default;
}

// ── Time formatting ───────────────────────────────────────────────────────────
function formatTime(ts) {
    if (!ts) return null;
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return null;
        
        // Month DD, YYYY
        const datePart = d.toLocaleString('en-US', {
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            timeZone: 'America/Chicago'
        });

        // HH:mm
        const timePart = d.toLocaleString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'America/Chicago'
        });

        // Timezone
        let tz = 'CST'; // Default to CST for the user's fleet
        
        return `${datePart} | ${timePart} ${tz}`;
    } catch {
        return ts;
    }
}

// ── Speed conversion ──────────────────────────────────────────────────────────
function kphToMph(kph) {
    return Math.round(kph * 0.621371);
}

// ── Extract vehicle info from condition details ───────────────────────────────
function extractVehicle(details) {
    // Vehicle can be at different paths depending on condition type
    for (const key of Object.keys(details)) {
        const inner = details[key];
        if (inner && typeof inner === 'object') {
            if (inner.vehicle?.name) return inner.vehicle;
            if (inner.asset?.name) return inner.asset;
        }
    }
    return null;
}

// ── Extract driver info from condition details ────────────────────────────────
function extractDriver(details) {
    for (const key of Object.keys(details)) {
        const inner = details[key];
        if (inner && typeof inner === 'object') {
            if (inner.driver?.name) return inner.driver;
        }
    }
    return null;
}

// ── Extract the SPECIFIC event type from details ──────────────────────────────
// Samsara often sends a generic description like "A safety event occurred".
// The real event type is buried inside the details object under typed keys.
function extractSpecificEventType(details) {
    if (!details || typeof details !== 'object') return null;

    // Safety event (camera/AI) — e.g. distracted driving, drowsiness, etc.
    if (details.safetyEvent) {
        const se = details.safetyEvent;
        // Try multiple fields where Samsara might put the specific type
        return se.safetyEventType
            || se.behaviorLabel
            || se.triggerType
            || se.type
            || se.label
            || se.name
            || 'Safety Event';
    }

    // Harsh event — e.g. harsh braking, harsh turn, harsh acceleration
    if (details.harshEvent) {
        return details.harshEvent.harshEventType || 'Harsh Event';
    }

    // Speed — speeding alert
    if (details.speed) {
        return 'Speeding';
    }

    // Geofence — entry or exit
    if (details.geofence) {
        const action = details.geofence.action || '';
        const gfName = details.geofence.geofence?.name || '';
        if (action && gfName) return `Geofence ${action}: ${gfName}`;
        if (action) return `Geofence ${action}`;
        return 'Geofence Alert';
    }

    // HOS violation
    if (details.hosViolation) {
        return details.hosViolation.violationType || 'HOS Violation';
    }

    // Engine fault
    if (details.engineFault || details.dtcFault) {
        const ef = details.engineFault || details.dtcFault;
        return ef.faultDescription || ef.faultCode || 'Engine Fault';
    }

    // Fuel
    if (details.fuelLevel || details.fuel) {
        return 'Low Fuel Level';
    }

    // Tire pressure
    if (details.tirePressure) {
        return 'Tire Pressure Alert';
    }

    // Gateway / device unplugged
    if (details.gatewayUnplugged || details.deviceUnplugged) {
        return 'Gateway Unplugged';
    }

    // Camera disconnected
    if (details.cameraDisconnected || details.dashCamDisconnected) {
        return 'Camera Disconnected';
    }

    // Collision
    if (details.collision) {
        return 'Collision Detected';
    }

    // Seatbelt
    if (details.seatbelt) {
        return 'Seatbelt Violation';
    }

    // Mobile usage
    if (details.mobileUsage || details.cellPhoneUsage) {
        return 'Mobile Phone Usage';
    }

    // Scan all detail values for any "type" or "label" field as a last resort
    for (const key of Object.keys(details)) {
        const inner = details[key];
        if (inner && typeof inner === 'object') {
            if (inner.type) return prettify(inner.type);
            if (inner.label) return prettify(inner.label);
            if (inner.name) return prettify(inner.name);
            if (inner.eventType) return prettify(inner.eventType);
            if (inner.triggerType) return prettify(inner.triggerType);
        }
    }

    return null;
}

// Make camelCase / SCREAMING_CASE readable: "harshBraking" → "Harsh Braking"
function prettify(str) {
    if (!str) return str;
    return str
        .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
        .replace(/_/g, ' ')                     // snake_case → snake case
        .replace(/\b\w/g, (c) => c.toUpperCase()); // capitalize words
}

// ── Build speed details ───────────────────────────────────────────────────────
function formatSpeedDetails(speedData) {
    if (!speedData) return [];
    const lines = [];
    if (speedData.currentSpeedKilometersPerHour != null) {
        const mph = kphToMph(speedData.currentSpeedKilometersPerHour);
        const kph = Math.round(speedData.currentSpeedKilometersPerHour);
        lines.push(`*Speed:* ${mph} mph (${kph} km/h)`);
    }
    if (speedData.thresholdSpeedKilometersPerHour != null) {
        const limitMph = kphToMph(speedData.thresholdSpeedKilometersPerHour);
        const limitKph = Math.round(speedData.thresholdSpeedKilometersPerHour);
        lines.push(`*Limit:* ${limitMph} mph (${limitKph} km/h)`);
    }
    if (speedData.currentSpeedKilometersPerHour && speedData.thresholdSpeedKilometersPerHour) {
        const overBy = kphToMph(speedData.currentSpeedKilometersPerHour - speedData.thresholdSpeedKilometersPerHour);
        if (overBy > 0) lines.push(`*Over by:* ${overBy} mph`);
    }
    return lines;
}

// ── Build safety event details ────────────────────────────────────────────────
function formatSafetyEventDetails(safetyData) {
    if (!safetyData) return [];
    const lines = [];
    if (safetyData.safetyEventType) lines.push(`*Event Type:* ${prettify(safetyData.safetyEventType)}`);
    if (safetyData.behaviorLabel) lines.push(`*Behavior:* ${prettify(safetyData.behaviorLabel)}`);
    if (safetyData.severity) lines.push(`*Severity:* ${prettify(safetyData.severity)}`);
    if (safetyData.maxGForce) lines.push(`*Max G-Force:* ${safetyData.maxGForce}`);
    if (safetyData.coachingState) lines.push(`*Coaching:* ${prettify(safetyData.coachingState)}`);
    if (safetyData.mediaUrl) lines.push(`🎥 [View Video](${safetyData.mediaUrl})`);
    return lines;
}

// ── Main formatter ────────────────────────────────────────────────────────────
function formatAlert(payload) {
    try {
        // ── Ping / Test event ─────────────────────────────────────────────
        if (payload.eventType === 'Ping' || payload.event?.text === 'Ping') {
            return {
                text: `🏓 *Samsara Webhook Test*\n\n✅ Connection successful! Your Telegram bot is correctly receiving Samsara alerts.\n\n_Webhook ID: ${payload.webhookId || 'N/A'}_`,
                videoUrl: null,
                isCrash: false,
            };
        }

        // ── AlertIncident (main payload from Samsara alerts) ──────────────
        if (payload.eventType === 'AlertIncident' && payload.data) {
            const { data, eventTime } = payload;
            const conditions = data.conditions || [];
            const time = data.happenedAtTime || eventTime || data.updatedAtTime;

            const firstCondition = conditions[0] || {};
            const genericDescription = firstCondition.description || 'Alert';
            const details = firstCondition.details || {};

            const specificType = payload._enrichedEventType || extractSpecificEventType(details);
            const isGeneric = /safety event|alert occurred|event occurred|harsh event|speeding/i.test(genericDescription);
            const description = (specificType && isGeneric) ? specificType : genericDescription;

            const isCrash = /crash|collision/i.test(description);
            const isSpeeding = /speed/i.test(description);
            const header = isCrash ? '🚨 CRASH 🚨' : (isSpeeding ? '🚨 SPEEDING 🚨' : `🚨 ${description.toUpperCase()} 🚨`);

            const vehicle = extractVehicle(details);
            const driver = extractDriver(details);

            let vehicleName = vehicle?.name || 'Unknown Unit';
            let driverName = driver?.name;
            
            // Fallback: Samsara often puts "1014 JOHN DOE" in vehicle.name.
            // Only parse driver from vehicle name if we have a REAL vehicle (not our fallback).
            if (!driverName && vehicle?.name && vehicle.name.includes(' ')) {
                driverName = vehicle.name.substring(vehicle.name.indexOf(' ') + 1);
            }
            if (!driverName) {
                driverName = 'Unknown Driver';
            }

            // Create hashtags
            const driverTag = `#${driverName.replace(/[^a-zA-Z0-9]/g, '')}`;
            // Typically unit name is like "2908 NIKE AUGUSTE", extract first part
            const unitParts = vehicleName.split(' ');
            const unitNumber = unitParts[0];
            const unitTag = `#Unit_${unitNumber}`;

            const formattedTime = formatTime(time) || 'Unknown Time';

            // Details Extraction
            let speedMph = 'N/A';
            if (details.speed?.currentSpeedKilometersPerHour != null) {
                speedMph = `${(details.speed.currentSpeedKilometersPerHour * 0.621371).toFixed(2)} MPH`;
                if (details.speed.thresholdSpeedKilometersPerHour) {
                    const limit = (details.speed.thresholdSpeedKilometersPerHour * 0.621371).toFixed(1);
                    speedMph += ` (LIMIT ${limit} MPH)`;
                }
            } else if (details.harshEvent) {
                // Harsh events rarely have exact speed in the top level details, but we put N/A if it's missing
                speedMph = 'N/A';
            }

            let severity = 'N/A';
            if (details.safetyEvent?.severity) {
                severity = details.safetyEvent.severity;
            } else {
                // _enrichedBehaviorType (e.g. "FollowingDistanceModerate") contains the severity
                // keyword; fall back to _enrichedEventType if the type field wasn't available.
                const typeLabel = (payload._enrichedBehaviorType || payload._enrichedEventType || '').toLowerCase();
                if (typeLabel.includes('severe') || typeLabel.includes('critical')) severity = 'critical';
                else if (typeLabel.includes('moderate')) severity = 'moderate';
                else if (typeLabel.includes('minor') || typeLabel.includes('low')) severity = 'minor';
            }

            let intensity = '0';
            if (details.harshEvent?.gForce != null) intensity = details.harshEvent.gForce;
            else if (isCrash) intensity = '0'; // Default for crash if missing

            // Location
            let locationStr = "Unknown Location";
            if (details.location) {
                const lat = details.location.latitude;
                const lon = details.location.longitude;
                const address = details.location.formattedLocation || details.location.heading || `${lat}, ${lon}`;
                locationStr = `${address} (https://maps.google.com/?q=${lat},${lon})`;
            } else if (details.harshEvent?.location) {
                 const lat = details.harshEvent.location.latitude;
                 const lon = details.harshEvent.location.longitude;
                 const address = details.harshEvent.location.formattedLocation || `${lat}, ${lon}`;
                 locationStr = `${address} (https://maps.google.com/?q=${lat},${lon})`;
            }

            // ── Video URL — deep search across ALL known Samsara event detail shapes ──
            // Samsara puts mediaUrl in different places depending on event type.
            // We try every known location before giving up.
            let videoUrl = null;

            // 1. Safety events (camera AI events: distracted driving, following distance, etc.)
            if (details.safetyEvent?.mediaUrl) {
                videoUrl = details.safetyEvent.mediaUrl;
            }
            // 2. Harsh events (braking, acceleration, turn) — mediaUrl or videoUrl may be present
            else if (details.harshEvent?.mediaUrl) {
                videoUrl = details.harshEvent.mediaUrl;
            }
            else if (details.harshEvent?.videoUrl) {
                videoUrl = details.harshEvent.videoUrl;
            }
            // 3. Collision events
            else if (details.collision?.mediaUrl) {
                videoUrl = details.collision.mediaUrl;
            }
            else if (details.collision?.videoUrl) {
                videoUrl = details.collision.videoUrl;
            }
            // 4. Generic scan — walk every top-level detail key looking for mediaUrl / videoUrl
            if (!videoUrl) {
                for (const key of Object.keys(details)) {
                    const inner = details[key];
                    if (inner && typeof inner === 'object') {
                        if (inner.mediaUrl)  { videoUrl = inner.mediaUrl;  break; }
                        if (inner.videoUrl)  { videoUrl = inner.videoUrl;  break; }
                        // Also check one level deeper (e.g. safetyEvent.media.url)
                        if (inner.media?.url) { videoUrl = inner.media.url; break; }
                    }
                }
            }
            // 5. Top-level payload fields (some Samsara events include these at root)
            if (!videoUrl) {
                videoUrl =
                    payload._enrichedVideoUrl ||
                    payload.mediaUrl ||
                    payload.videoUrl ||
                    null;
            }

            // Standardize fields (always show as per user request)
            const displaySpeed = speedMph !== 'N/A' ? speedMph : 'N/A';
            const displaySeverity = severity !== 'N/A' ? severity.toLowerCase() : 'N/A';
            const displayIntensity = (intensity !== '0' && intensity !== 'N/A') ? intensity : '0';

            // Build exact text format requested
            let text = `<b>${header}</b>\n\n`;
            text += `<b>Driver:</b> ${driverTag} (Wenze Investments LLC #${unitNumber})\n`;
            text += `<b>Local Time:</b> ${formattedTime}\n`;
            text += `<b>Speed:</b> ${displaySpeed}\n`;
            text += `<b>Severity:</b> ${displaySeverity}\n`;
            text += `<b>Intensity:</b> ${displayIntensity}\n`;

            if (locationStr !== 'Unknown Location') {
                const mapsUrl = locationStr.match(/https:.*?(?=\))/)?.[0] || '#';
                const addressText = locationStr.split(' (http')[0];
                text += `<b>Location:</b> ${addressText} (<a href="${mapsUrl}">Google Maps</a>)\n`;
            }
            
            // Add a dashboard link if provided in payload so user can get the missing real-time data
            const incidentUrl = data.incidentUrl || payload.incidentUrl || null;
            if (incidentUrl) {
                text += `\n🔗 <a href="${incidentUrl}">View in Samsara Dashboard</a>\n`;
            }

            const eventTag = isCrash ? '#crash' : (isSpeeding ? '#speeding' : `#${description.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`);
            text += `\n${eventTag} ${unitTag}`;

            const inwardVideoUrl = payload._enrichedVideoUrlInward || null;

            return { text, videoUrl, inwardVideoUrl, isCrash, eventLabel: description };
        }

        // ── Generic fallback ────────────
        if (payload.eventType && payload.data) {
            const { eventType } = payload;
            return {
                text: `🔔 *Samsara Notification:*\nUnmapped event type: ${eventType}`,
                videoUrl: null,
                isCrash: false,
            };
        }

        return {
            text: `🔔 *Samsara Notification:*\nReceived an unrecognized alert payload.`,
            videoUrl: null,
            isCrash: false,
        };

    } catch (err) {
        console.error('[Formatter] Error formatting payload:', err.message);
        return {
            text: `🔔 *Samsara Alert*\nReceived an alert (formatting error: ${err.message})`,
            videoUrl: null,
            isCrash: false,
        };
    }
}

module.exports = { formatAlert };
