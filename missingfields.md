# Implementation Plan: Speed & Severity Fields

This document outlines the technical approach for populating the "Speed" and "Severity" fields in individual safety alerts within the Samsara-Telegram bot.

## 1. Speed Field (Current: N/A)

### Problem
The `GET /fleet/safety-events` endpoint provides the event details but does not include the vehicle's speed at the time of the event for all types (e.g., harsh braking, crash).

### Solution: Secondary API Lookup
To populate this field, the bot must perform an asynchronous secondary lookup when a new event is detected.

1.  **Extract Context**: Capture `vehicleId` and `happenedAtTime` from the safety event payload.
2.  **Call Vehicle Stats API**: Request the `gps` stat from `GET /fleet/vehicles/stats/history`.
    *   **Params**: `startTime` and `endTime` should be a narrow window (e.g., +/- 10 seconds) centered on the event timestamp.
3.  **Process Result**: Parse the `speedMilesPerHour` from the response and update the `details.speed` object before it reaches the formatter.

### Implementation Difficulty: Moderate (4/10)
Requires updating `src/poller.js` to handle non-blocking asynchronous fetching and ensuring the Telegram broadcast waits for this data to return.

---

## 2. Severity Field (Current: N/A)

### Problem
Samsara categorizes safety events internally but often only exposes raw telematics data (G-Force) for harsh events instead of a qualitative "Severity" label.

### Solution A: Dashboard Link Fallback
For AI-driven events (like Distracted Driving), the severity is occasionally present in `details.safetyEvent.severity`. 

### Solution B: Custom G-Force Mapping (Recommended)
We can implement a mapping table in `src/formatter.js` that translates the "Intensity" (G-Force) into a human-readable severity label.

*   **Logic Example**:
    *   `Intensity < 0.4`: Minor
    *   `0.4 <= Intensity < 0.6`: Moderate
    *   `Intensity >= 0.6`: Severe / Critical

### Implementation Difficulty: Very Easy (1/10)
Requires adding a helper function and a few `if/else` statements to the formatting logic.

---

## Technical Summary
*   **Total Implementation Time**: ~1.5 - 2 Hours.
*   **Risk**: Low. All changes are additive and won't disrupt the existing polling or filtering logic.
*   **APIs Required**: `fleet/safety-events` (existing) + `fleet/vehicles/stats/history` (new lookup plugin).
