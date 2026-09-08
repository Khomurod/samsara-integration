# Pre-Deploy Checklist — `samsara-integration` (Safety Alert Service)

> **What this is.** A safety checklist to run **before every deployment** of the
> Samsara safety-alert service. This service delivers real dashcam safety alerts
> to drivers and management, so the two things that must never break are:
> **(1) no duplicate safety alerts / videos**, and **(2) no lost safety event**.
>
> **How to read it.** Left = plain-English What/Why; right = How to check.
> **[AUTO]** = automated test/command · **[MANUAL]** = human/staging ·
> **[PROD]** = confirm on the live service after deploy.
>
> **Golden rule:** if you cannot verify something locally, mark it
> **“needs staging/production verification.”** Never fake a result.

---

## A. General checks
| # | What / Why | How to check |
|---|---|---|
| A1 | App starts successfully. | **[AUTO]** `npm test` passes; **[PROD]** logs show pollers + bot started. |
| A2 | No crash loop. | **[PROD]** one stable Render instance; no repeated restarts. |
| A3 | No missing env vars. | **[MANUAL]** compare Render env to `.env.example` / `render.yaml` (esp. tokens, `DATABASE_URL`, `SAMSARA_API_KEY`). **No new variable is required by the settings/recovery work** — the admin panel is the primary home and the environment stays a fallback. |
| A3a | The Samsara key the panel saved is readable HERE. | **[PROD]** startup logs `[VideoRecovery] Settings: source=database key=database …`. `key=environment` with a key saved in the panel means this service could not decrypt it — re-save it in Settings → Samsara, or set the same `INTEGRATION_SECRET_KEY` on both services. |
| A4 | Database connection works. | **[PROD]** `GET /health` returns 200; `initPgDb()` succeeded in logs. |
| A5 | Notification bot connects **and** can see the notifications group. | **[PROD]** `verifyNotificationBotAccess()` logs ✓ for `HARDCODED_GROUP_ID`. |
| A6 | Token separation intact. | **[AUTO/PROD]** Samsara token ≠ main `BOT_TOKEN` (else exit 78). |
| A7 | Logs show no critical errors. | **[PROD]** no unhandled crashes; Samsara API auth OK. |

## B. Idempotency & delivery (the core guarantees)
| # | What / Why | How to check |
|---|---|---|
| B1 | **No duplicate safety alerts.** | **[AUTO]** `samsaraIdempotentDelivery.test.js` (deliver-once; re-run sends to nobody). |
| B2 | **No duplicate video sends.** | **[AUTO]** `samsaraVideoBackfill.test.js` (replace-then-delete) + `samsaraVideoRecovery.test.js` (a re-delivered event adds no second recovery). |
| B2a | **No duplicate Samsara retrieval requests.** | **[AUTO]** `samsaraVideoRecoveryWorker.test.js` (a job holding a retrieval id polls it instead of creating another) + `samsaraVideoRecoveryStore.test.js` (`ON CONFLICT DO NOTHING` on a UNIQUE event id). |
| B2b | **Pending video recoveries survive a redeploy.** | **[AUTO]** `samsaraVideoRecoveryWorker.test.js` (a fresh worker resumes from the store); **[PROD]** startup logs `[VideoRecovery] Queue on boot: N recovery job(s) still open`. |
| B3 | Already-delivered target not re-sent when a sibling fails. | **[AUTO]** `samsaraIdempotentDelivery.test.js` (permanent recorded & swallowed). |
| B4 | Transient failure is retried; succeeded targets are not re-sent. | **[AUTO]** same suite (429 retried). |
| B5 | Blocked/403 subscriber is skipped, not retried forever. | **[AUTO]** same suite. |

## C. Samsara safety event flow
| # | What / Why | How to check |
|---|---|---|
| C1 | Safety event received. | **[PROD]** poller logs show fetched events. |
| C2 | Notification goes to the Samsara Notifications group. | **[PROD]** group receives every event. |
| C3 | Notification goes to the correct driver group. | **[AUTO]** `samsaraRouting.test.js`; **[MANUAL]** spot-check. |
| C4 | Event **without** immediate video handled (text-first). | **[AUTO]** `samsaraBroadcastDelivery.test.js`. |
| C5 | Event **with later** video handled (backfill). | **[AUTO]** `samsaraVideoBackfill.test.js`. |
| C6 | Event with **no** video does not crash or duplicate. | **[AUTO]** `samsaraVideoRetryDelivery.test.js`. |
| C7 | Video URL host allow-list enforced (SSRF guard). | **[AUTO]** `samsaraVideoUrl.test.js`. |
| C8 | Speeding poller works independently. | **[AUTO]** `samsaraSpeedingPoller.test.js`. |
| C9 | Media/URL extraction correct. | **[AUTO]** `safetyEventMedia.test.js`. |

## D. Memory / stability (the reason this service was split out)
| # | What / Why | How to check |
|---|---|---|
| D1 | Heap cap present. | **[MANUAL]** `NODE_OPTIONS=--max-old-space-size=400` in render.yaml. |
| D2 | Pollers run sequentially, not concurrently. | **[MANUAL]** `pollCoordinator.js` single-timer chain intact. |
| D3 | Queues / seen-ID sets bounded. | **[MANUAL]** `MAX_ALERT_QUEUE`, `MAX_SEEN_IDS`, `.slice(-5000)` intact. |
| D4 | Video download size cap intact. | **[MANUAL]** `downloadVideo()` byte-counter + `content-length` cap present. |
| D5 | No memory growth over time. | **[PROD]** watch Render memory graph after deploy. |

## E. AI safety
| # | What / Why | How to check |
|---|---|---|
| E1 | Untrusted text fenced; only structured fields sent to AI. | **[AUTO]** `samsaraDriverAlertMessageAi.test.js` (prompt build, fence-strip). |
| E2 | Groq → Gemini → plain-text fallback works. | **[AUTO]** same suite; **[MANUAL]** remove a key to confirm fallback. |
| E3 | AI failure never blocks delivery. | **[AUTO]** delivery falls back to text on AI error. |

## F. External API failure resilience
| Dependency fails | Expected | How to check |
|---|---|---|
| Samsara API | Logged; retried next poll; no event lost. | **[AUTO]** poller commit-after-success (`samsaraBroadcastDelivery.test.js`). |
| Telegram | Transient retried; permanent recorded, not re-sent. | **[AUTO]** `samsaraIdempotentDelivery.test.js`. |
| Geocoder (BigDataCloud) | Tolerated (address omitted), no crash. | **[AUTO]** geocoder-400 tolerance test. |
| AI provider | Fallback chain → plain text. | **[AUTO]** `samsaraDriverAlertMessageAi.test.js`. |
| Redis (Upstash) | Falls back to local JSON subscriber store. | **[MANUAL]** confirm `store.js` fallback path. |
| Database | Startup fails loudly; dedupe relies on Postgres — must be available. | **[PROD]** `/health`; confirm `DATABASE_URL`. |

## G. Deployment (run in order)
1. ☐ **[AUTO]** `node --test --test-concurrency=1 tests/*.test.js` → all pass (currently 71).
2. ☐ **[AUTO]** Lint/typecheck: *none configured* — N/A.
3. ☐ **[AUTO]** Build: *no build step* (plain Node) — N/A.
4. ☐ **[MANUAL]** No schema migration is owned here; the `groups` table is owned by `bot-backend`. If a `groups` change is needed, coordinate with that repo first.
5. ☐ **[MANUAL]** Confirm env vars match `render.yaml` / `.env.example`; `DATABASE_URL` and `BOT_TOKEN` **match the hub**.
6. ☐ **[MANUAL]** Confirm the production branch.
7. ☐ **[MANUAL]** Commit with a clear message; push.
8. ☐ **[MANUAL]** Merge only after tests pass + review.
9. ☐ **[PROD]** Watch logs ≥5 min — no crash loop, memory stable.
10. ☐ **[PROD]** Confirm the notification bot is alive and in the notifications group.
11. ☐ **[PROD]** Confirm a real safety event flows end-to-end (or a recent one did).

## Quick automated gate
```bash
# From samsara-integration/
node --test --test-concurrency=1 tests/*.test.js
```
Green here covers B*, C3–C9, E*, and the automated rows of F. The **[MANUAL]** /
**[PROD]** items (memory, live tokens, real event flow) still need a human check.
