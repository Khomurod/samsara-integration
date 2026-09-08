# Module Map — `samsara-integration` (Samsara Safety Alert Service)

> **Purpose.** This is the **Safety Module** of the Wenze operations platform,
> deliberately split into its own Render service because its Samsara polling
> caused memory pressure / OOM kills when it lived inside the main `bot-backend`.
> It cooperates with the main hub **only** through the shared Postgres `groups`
> table and shared Telegram bot tokens — there is no in-process link.
>
> This document records where each responsibility lives. It does **not** change
> any code.
>
> **Operational settings live in the admin panel, not in Render.** The Samsara
> API key, whether missing-video recovery runs, the initial re-check delay, the
> retry behaviour and the video size cap are read from the `samsara_settings`
> row that `bot-backend`'s Settings → Samsara writes, over the database the two
> services already share. Every environment variable this service ever read is
> still honoured as a per-value fallback, so a deployment that changes nothing
> behaves exactly as before.

## Guiding principles (do not violate)

1. **No duplicate safety alerts** and **no duplicate video sends** — enforced by
   a Postgres-backed idempotency ledger (see below). Never weaken it.
2. **Reliability over novelty.** A failed send is retried on the next poll; an
   already-delivered target is never re-sent when a sibling target fails.
3. **Memory safety.** The two pollers run strictly sequentially; queues, seen-ID
   sets, and video buffers are bounded; heap is capped at
   `--max-old-space-size=400`. Do not remove these guards.
4. **Untrusted text is fenced** before any AI call; **video URLs** are checked
   against a hostname allow-list before download.
5. **AI is optional** — Groq→Gemini→plain-text fallback; an AI failure never
   blocks or crashes delivery.

## Runtime shape

```
index.js ── Express (/health) + notification bot + send-only driverBot + pollCoordinator
  └── src/
       ├── Polling      poller.js · speedingPoller.js · pollCoordinator.js
       ├── Delivery     broadcastDelivery.js · driverGroupDelivery.js · routing.js
       │                deliveryTracker.js · deliveryWarnings.js
       ├── Video        safetyEventMedia.js · videoBackfill.js · videoRetryDelivery.js
       │                cameraMediaRetrieval.js · videoUrl.js
       ├── Recovery     videoRecoveryStore.js · videoRecoveryWorker.js
       ├── Settings     samsaraSettings.js · sharedIntegrationCrypto.js
       ├── AI           driverAlertMessageAi.js · geminiClient.js · groqClient.js
       └── Shared       db.js · store.js · formatter.js · geocoder.js
Shares: Postgres `groups` table + Telegram tokens with bot-backend
```

`index.js`: prefers `SAMSARA_BOT_TOKEN` (falls back to legacy
`TELEGRAM_BOT_TOKEN`); **exits 78 (EX_CONFIG)** if no token or if the Samsara
token equals the main `BOT_TOKEN` (which would cause a dual-`getUpdates`
conflict). Runs `store.init()` + `samsaraDb.initPgDb()`, verifies the
notification bot can see the notifications group, wires all collaborators into
`deliverEvent()`, starts coordinated polling, and shuts down gracefully on
SIGINT/SIGTERM.

## Responsibilities → files

### Polling
| File | Responsibility |
|---|---|
| `src/poller.js` | Polls `/fleet/safety-events` (cursor + time-window watermark); dedupes; formats; enqueues at 2s spacing. |
| `src/speedingPoller.js` | Separate `/safety-events/stream` poller for speeding labels; isolated cursor/dedup state (`speed:`-namespaced IDs). It no longer carries its own copy of the camera-retrieval calls — that was a second implementation of `cameraMediaRetrieval.js` that could not survive a restart. |
| `src/pollCoordinator.js` | Runs the two pollers **sequentially** (safety → 15s → speeding → 15s → repeat) so they never run concurrently. |

### Delivery / routing
| File | Responsibility |
|---|---|
| `src/broadcastDelivery.js` | `deliverEvent()`: idempotent fan-out to subscribers + notifications group + matched driver group; consults/records the ledger; only re-throws on transient failure. |
| `src/driverGroupDelivery.js` | Sends to a driver group with dual-camera → single-video → text fallback. |
| `src/routing.js` | Unit-number extraction + name-hint matching → target driver group or `fallback-*` reason. |
| `src/deliveryTracker.js` | Thin ledger wrapper + `classifyTelegramError()` (permanent vs transient). |
| `src/deliveryWarnings.js` | Appends a "driver bot not in group" note to notification messages. |

### Video handling
| File | Responsibility |
|---|---|
| `src/safetyEventMedia.js` | Extracts forward/inward dashcam URLs; merges detail responses; refetches via fleet time-window. |
| `src/videoBackfill.js` | Folds a recovered video into alerts already sent (send video, delete original text) and reports which targets it could NOT reach. Owns HOW, not WHEN. |
| `src/videoRetryDelivery.js` | Immediate send + attach the recovery descriptor. Nothing else: the camera calls moved to `cameraMediaRetrieval.js` and the pacing to the durable worker. |
| `src/cameraMediaRetrieval.js` | The Samsara camera calls, one round trip each: `buildRetrievalWindow` (never zero-length), `requestVideoRetrieval` (returns the retrieval id), `fetchRetrievalMediaUrls`, `listCameraMediaUrls`. |
| `src/videoUrl.js` | `parseTrustedVideoUrl()`: hostname allow-list guarding every video fetch. |

### Missing-video recovery (durable)
| File | Responsibility |
|---|---|
| `src/videoRecoveryStore.js` | The `samsara_video_recovery_jobs` table: idempotent `enqueue` (UNIQUE event id + `ON CONFLICT DO NOTHING`), exclusive `claimDueJobs` (`FOR UPDATE SKIP LOCKED` + reclaimable stale lock), and `reschedule`/`finish`, which write the surviving `targets` in the SAME statement as the status so the two can never land separately. |
| `src/videoRecoveryWorker.js` | Its own interval, independent of the poll coordinator. Re-read → check an existing retrieval / the media listing → request retrieval ONCE → fold the video in → end in a state that says what happened. `enqueueVideoRecovery()` creates the job after delivery. |

### Settings
| File | Responsibility |
|---|---|
| `src/samsaraSettings.js` | Reads `samsara_settings` (written by the admin panel) over the shared database, with the environment as a per-value fallback. One shared, briefly-cached store for the whole process. |
| `src/sharedIntegrationCrypto.js` | The AES-256-GCM envelope this service and `bot-backend` both open, keyed from a secret both already hold. Mirrored file — keep the two identical. |

### AI
| File | Responsibility |
|---|---|
| `src/driverAlertMessageAi.js` | Builds the driver-caption prompt; `resolveDriverCaption()` orchestrates Groq→Gemini→plain text; skips AI for crashes/fallback routes. |
| `src/groqClient.js` | Groq chat-completions with model fallback chain + retry-after backoff + auth-error detection. |
| `src/geminiClient.js` | Gemini `generateContent` with model chain + retry/backoff. |

### Shared infrastructure
| File | Responsibility |
|---|---|
| `src/db.js` | Postgres pool + cursor storage; processed-events dedupe table; poll watermark; per-target delivery ledger; `findGroupByUnit`. |
| `src/store.js` | Subscriber storage (Upstash Redis or local JSON fallback) + `findGroupByUnit()` with name-hint resolution against `groups`. |
| `src/formatter.js` | Raw Samsara payload → human-readable HTML Telegram message. |
| `src/geocoder.js` | Reverse-geocode lat/lon → "City, State" (BigDataCloud) when Samsara omits an address. |

## Idempotency — three layers (do not weaken)

1. **Event-level dedupe:** in-memory `SEEN_IDS` / `PENDING_DELIVERY_IDS` +
   durable Postgres `samsara_processed_events`. An event is marked processed
   **only after a clean delivery**, so a failed send is retried next poll.
2. **Per-target delivery ledger (the core "never duplicate" guarantee):**
   `samsara_event_deliveries (event_id, target_chat_id, status)` with
   `status ∈ {delivered, permanent}`. Any settled target is skipped before
   sending; a `delivered` record is never downgraded; permanent failures are
   recorded and **swallowed** so an already-delivered driver group is never
   re-sent when a sibling target fails (the fix for the production duplicate bug).
3. **Video recovery de-dupe:** `samsara_video_recovery_jobs.samsara_event_id` is
   UNIQUE and `enqueue` is `ON CONFLICT DO NOTHING`, so one event can never hold
   two recoveries — and therefore never produce two Samsara retrieval requests.
   This replaced an in-memory `inFlight` set, which also meant a redeploy inside
   the wait window silently dropped every pending video.

> Redis (`@upstash/redis`) is used **only** for subscriber persistence, not for
> dedupe — dedupe is Postgres-backed.

## Retry / backoff
- **Event retry:** delivery failure → not marked processed → re-picked next
  coordinated poll.
- **Per-target:** only transient failures re-throw; permanent are recorded.
- **Missing-video recovery:** admin-configured (`samsara_settings`) — initial
  re-check delay (default **5 minutes**), retry interval (default 5 minutes) and
  attempt budget (default 12). The old 30s…180s clamp is gone: it silently
  overrode the operator's chosen delay. Only a 5-second floor remains, so a
  mis-set value cannot become a tight loop. The wait is durable, so a long one
  costs nothing.
- **AI:** both clients honor `retry-after` on 429/5xx then advance the model chain.

## Memory / OOM safeguards
- Heap cap `NODE_OPTIONS=--max-old-space-size=400` (render.yaml).
- Pollers run strictly sequentially (`pollCoordinator`) + per-poll overlap guard.
- Bounded queues (`MAX_ALERT_QUEUE` 100/200) and seen-ID sets (500/1000);
  speeding processed-ID list capped via `.slice(-5000)`.
- Video downloads capped by size (admin-configurable, default 25 MB) via `content-length` + a
  streaming byte counter that cancels mid-download; buffers cleared in `finally`.

## AI safety
- The model only receives **structured extracted fields** (event label, driver
  first name, unit number) — never the raw payload.
- Output is re-fenced by `parseDriverMessageResponse` (strips code fences,
  rejects <40 chars, truncates to 900); system prompt allows `<b>/<i>` only.
- Any thrown AI error falls back to the standard text (`broadcastDelivery.js`).

## Event → driver group routing & the notifications group
1. Extract the **unit number** from the vehicle name; none → `fallback-no-unit`,
   driver forward skipped.
2. Look up `groups` where `group_type='driver' AND active=TRUE` and the name
   contains the unit.
3. Disambiguate duplicates by **name hints** (driver + vehicle name).
4. No mapped group → `fallback-unmapped`, driver forward skipped (never sent to
   a wrong group). Matched → forwarded with an AI-friendly caption.

The **"Samsara Notifications" group** is a fixed chat (`HARDCODED_GROUP_ID`) and
is always included so every event lands there regardless of routing.
`verifyNotificationBotAccess()` self-checks membership at startup.

## Tests (`npm test` → `node --test --test-concurrency=1 tests/*.test.js`, 71 tests)
`samsaraIdempotentDelivery` · `samsaraBroadcastDelivery` · `samsaraRouting` ·
`samsaraDriverAlertMessageAi` · `samsaraVideoBackfill` · `samsaraVideoRetryDelivery` ·
`samsaraSpeedingPoller` · `safetyEventMedia` · `samsaraVideoUrl`.
(Root `test-*.js` are manual live/mock scripts, **not** part of `npm test`.)

## Deployment
Render `render.yaml`: one `web` service `samsara-poller`
(`buildCommand: npm install`, `startCommand: node index.js`,
`healthCheckPath: /health`). Key env: `SAMSARA_BOT_TOKEN`/`TELEGRAM_BOT_TOKEN`,
`BOT_TOKEN` (must match the hub), `SAMSARA_API_KEY`, `DATABASE_URL` (must equal
the hub's), `MANAGEMENT_GROUP_ID`, `EMPLOYEE_GROUP_ID`, `HARDCODED_GROUP_ID`,
`GROQ_API_KEY`, `GEMINI_API_KEY`, `UPSTASH_REDIS_REST_URL`/`_TOKEN`,
`NODE_OPTIONS=--max-old-space-size=400`.

## Risks & "Do NOT touch yet"
| Area | Risk | Guidance |
|---|---|---|
| Idempotency ledger (`db.js`, `broadcastDelivery.js`) | Weakening it re-introduces duplicate safety alerts. | Keep the `delivered/permanent` states, the skip-if-settled check, and swallow-permanent behavior. |
| `pollCoordinator` / bounded sets | Removing them risks OOM (the reason for the split). | Keep sequential polling, heap cap, and queue/set caps. |
| Shared `groups` table | Schema changes affect **both** repos. | Coordinate any `groups` change with `bot-backend`. |
| Token separation | Sharing `BOT_TOKEN` breaks polling on both bots. | Keep the Samsara token distinct; keep the exit-78 guard. |
| `videoUrl.js` allow-list | Loosening it enables SSRF via crafted URLs. | Keep the hostname allow-list. |
