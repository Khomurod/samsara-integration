# Samsara Safety Event Architecture: Webhooks vs. Polling

Based on your requirement to ensure **every single safety event** (such as a "Following Distance" occurrence) is caught and sent to your Telegram bot without being filtered out by Samsara's invisible cooldowns or minimum thresholds, I highly recommend transitioning the bot from a **Webhook (Push)** architecture to an **API Polling (Pull)** architecture.

This document details the differences, benefits, and steps required for this architectural shift.

---

## 1. Executive Summary

- **Current Architecture (Webhooks):** Samsara is in control. The bot sits idly and waits for Samsara to send an explicitly triggered "Alert Incident." Because Samsara filters events (preventing duplicate alerts, enforcing severity thresholds, or dismissing items automatically), some raw events visible in the Safety Inbox will never trigger an alert, and therefore, the bot will never know they happened.
- **Proposed Architecture (API Polling):** The bot takes control. Every 15 seconds, the bot asks the Samsara API, *"Give me all the raw safety events that occurred since I last asked you."* The bot then processes and sends everything it finds directly to you via Telegram.

Alternative considered: We explored configuring the Alerts in the Samsara dashboard to trigger on every event, but discovered this is not possible because Samsara inherently filters events before they graduate to "Alert Incidents." Polling raw data bypasses this entire alert system.

---

## 2. Technical Breakdown: Polling Architecture

Instead of receiving POST requests from Samsara, the bot will run an internal clock (`setInterval` or `node-cron`) that reaches out to the `GET /fleet/safety-events` (or `v2/safety-events/stream`) endpoints.

### The Mechanism: "Cursor-Based Pagination"

Samsara uses a "bookmark" system called a Cursor to deliver streams of events without dropping data.

1.  **Initial Run:** The bot asks Samsara for safety events. Samsara returns any events that just happened, along with a `nextCursor` value (e.g., `xyz123`).
2.  **Wait 15 Seconds.**
3.  **Subsequent Run:** The bot asks Samsara for safety events, passing `?cursor=xyz123`. Samsara only returns events that occurred *after* `xyz123` was generated. Along with those new events, it provides a new cursor (e.g., `abc987`).
4.  **Repeat indefinitely.**

---

## 3. Advantages of API Polling

### ✅ Complete Fidelity (No Missed Events)
You will see exactly what is in the "Safety Inbox." If an AI camera detects a following distance event, it gets written to Samsara's database. By querying the database directly, we bypass the "Alert Configuration" logic entirely.

### ✅ Immune to Render's Sleep Cycle
Currently, if the Render free tier server falls asleep, it takes ~50 seconds to wake up. By the time it wakes up, Samsara's webhook request may have timed out, causing you to lose the alert permanently.
With polling, if Render goes to sleep and wakes up 20 minutes later, the bot will use its last saved Cursor. It will ask Samsara what it missed over the last 20 minutes, pull down all those events sequentially, and send them to Telegram without losing a single one.

### ✅ Simplified Samsara Dashboard
You no longer need to manage complex "Alert Configurations" in the Samsara dashboard. The bot handles all the filtering and routing based purely on the raw event data.

---

## 4. Challenges & Technical Trade-offs

Moving to this model involves rewriting a significant portion of the application and introduces new technical responsibilities for the bot.

### A. State Management (The "Memory" Problem)
The single biggest challenge with polling is that **the bot must remember its last Cursor**. Because Render occasionally restarts servers during deployments or maintenance, the cursor cannot simply be kept in a JavaScript variable.
-   **Solution:** We must implement persistent storage. The bot must save the cursor to a tiny database (like SQLite, Redis, or a simple managed KV store) every time it updates. When the server restarts, it reads the cursor from the database and resumes exactly where it left off.

### B. Rate Limits
Samsara limits how frequently your API key can make requests to their servers.
-   **Solution:** Checking every 15 seconds results in 5,760 requests per day. The Samsara API generally allows 5 requests per second per IP (up to a daily quota). Polling every 15 seconds is usually well within limits, but it must be explicitly validated against your specific API key's tier and any other integrations you have running simultaneously. We may need to dial the frequency back to 30 or 60 seconds if limits are restrictive.

### C. Traffic Management & Backlogs
If an incident happens causing 50 events to pile up at once (or if the server was offline and resumes), the bot will fetch all 50 events instantly. Telegram has strict limits on how fast you can send messages (typically 20-30 messages per second, but lower limits apply internally in groups).
-   **Solution:** Implement a rate-limited queue inside the bot. Instead of firing 50 Telegram webhooks instantly, it should push the 50 events into a local queue and send one every 2-3 seconds until the queue is empty.

### D. Increased Resource Usage
The bot is no longer idle. It is actively making HTTP requests every 15 seconds, processing JSON, and managing a database connection. This will increase memory and CPU usage on the Render free tier.

---

---

## 6. Project Status: COMPLETED ✅

Everything proposed in this document has been fully implemented, tested, and deployed:

1.  **[DONE] Persistent Storage:** Implemented in `src/db.js` with a zero-dependency JSON fallback to ensure reliability on Render.
2.  **[DONE] Polling Engine:** Built in `src/poller.js`, handling cursor-based pagination and Samsara v2 API nuances (like the `endTime` requirement).
3.  **[DONE] Event Deduplication:** Added a robust ID-based memory shield to prevent any duplicate alerts from reaching your phone.
4.  **[DONE] Telegram Queue:** Implemented a rate-limited transmitter to ensure stable delivery of multiple events or backlogs.
5.  **[DONE] Direct Video Attachments:** Standardized the bot to download and attach real video files directly for a premium experience.

The bot is now running in **Polling Mode**, making it immune to missed webhooks and Render sleep cycles.
