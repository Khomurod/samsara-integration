# Running on the Hostinger VPS (Coolify)

The hub (`bot-backend`) runs on a Hostinger VPS (KVM 2: 2 vCPU, 8 GB RAM)
under Coolify. This service can run there too, as a **second application in
the same Coolify project** — its own container, its own memory limit, never
the hub's process. Until it is moved it runs on Render's free plan, which
sleeps after 15 minutes without a request and polls nothing while asleep.

This page is the runbook for the move. It is written so the drivers, the
managers and the Samsara Notifications group notice nothing: at no moment do
two copies run at once, and the copy that takes over has already proved, on
the VPS, everything it needs.

## Why the move cannot lose or duplicate anything

- **The state that decides what is sent is in the shared database.** The poll
  watermark (`samsara_poll_state`), the processed events
  (`samsara_processed_events`), the per-target delivery ledger, the
  video-recovery queue and the safety-event record.
- **One thing may not be:** the Samsara bot's subscriber list (chats that sent
  it `/start`). With `UPSTASH_REDIS_REST_URL` / `_TOKEN` set it is in Upstash
  and both hosts share it. Without them it is a file on the Render instance,
  which Render already empties on every restart and sleep — and which does not
  come across. The "Samsara Notifications" group is not on that list; it is
  always sent to. The preflight's `subscribers` line says which case applies
  (see step 2).
- **A new copy re-reads the last two hours** from the stored watermark and
  skips every event already processed. Events that arrive during the switch
  are picked up by the first poll — a few minutes late, never lost, never
  twice.
- **Telegram keeps the Samsara bot's updates** (`/start`, `/stop`) until
  someone polls; the new copy receives them.

What can go wrong is two copies at once (Telegram's 409 Conflict on the bot,
and two pollers racing to post) — the steps below never allow it — and the
VPS's IPv6 route, which black-holes large request bodies to Telegram. The
build pins IPv4 for every Telegram call (`src/telegramNetwork.js`), and the
standby preflight proves the upload path before the switch.

## 1. Create the application (standby)

Coolify → the hub's project → **New Resource → Application**:

| Setting | Value |
|---|---|
| Source | GitHub `Khomurod/samsara-integration`, branch `main` |
| Build pack | **Dockerfile** (the repository root `Dockerfile`) |
| Ports exposed | `3000` |
| Domain | optional. Without one the service is still fine (it polls; nothing calls in). With one (e.g. `samsara.<the hub's domain>`) `/health` can be checked from outside. |
| Health check | path `/health`, port `3000` |
| Resource limits | memory **768 MB** (the service runs in 512 MB on Render; the limit keeps a leak from ever touching the hub) |
| Persistent storage | a volume mounted at **`/app/data`** (local fallbacks: cursor file, and the subscriber list when Upstash is not configured) |
| Auto deploy | on |

### Environment

**Copy the Render service's environment WHOLE** (Render → `samsara-poller` →
Environment), then change exactly these:

| Variable | Value |
|---|---|
| `SAMSARA_STANDBY` | `true` — add it |
| `RENDER_EXTERNAL_URL` | do not copy |
| `USE_WEBHOOK` | leave unset (the service long-polls) |
| `PORT` | leave unset (the image says `3000`) |

What must come across unchanged: `SAMSARA_BOT_TOKEN` (or `TELEGRAM_BOT_TOKEN`),
`BOT_TOKEN`, `DATABASE_URL`, `INTEGRATION_SECRET_KEY` **if it is set — it must
equal the hub's**, `SAMSARA_API_KEY`, `HARDCODED_GROUP_ID`,
`MANAGEMENT_GROUP_ID`, `EMPLOYEE_GROUP_ID`, `GROQ_API_KEY`, `GEMINI_API_KEY`,
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, `NODE_OPTIONS`, and
anything else that is there.

Deploy.

### What standby does

Nothing anyone can see (`src/standby.js`): no Telegram polling, no Samsara
polling, no posts, no video recovery, no heartbeat to the hub, no schema setup
(the shared database is only read), and a webhook update, should one arrive,
is acknowledged and dropped. It runs a
**preflight** once, read-only, and reports it on `/health` (always HTTP 200 in
standby) and in the log:

| Check | Proves |
|---|---|
| `database` | the shared database answers |
| `driverGroupSwitch` | the hub's migration 0090 is there |
| `samsaraSettings` | the Samsara key resolves — `key=database` when it was saved in Wenze's Settings → Samsara (a `key=environment` there means `INTEGRATION_SECRET_KEY` differs from the hub's) |
| `samsaraApi` | Samsara answers with that key (one vehicle is read) |
| `notificationBot` | the Samsara bot's token works and it can see the Samsara Notifications group |
| `driverBot` | the main bot's token works |
| `telegramUpload` | a 256 KB request body was fully sent over the pinned IPv4 path and Telegram answered `200 ok` after it (sent to `getMe`, so nothing is posted). An answer before the body, a 401 or silence fails it |
| `subscribers` | where the bot's subscriber list lives: `Upstash` (shared — nothing to do), `Upstash … startup read FAILED` (fix `UPSTASH_*` and redeploy before switching) or `local file` (see step 2). Informational; never blocks ready |
| `ffmpeg` | the music overlay can run |

**Ready means every line is ✓** (`"ready": true` on `/health`). Leave it in
standby for as long as you like; Render keeps working meanwhile.

## 2. Switch (a quiet hour, about five minutes)

0. **If the `subscribers` line says `local file`**, Render's list does not
   come across, and **adding Upstash does not bring it across either**:
   - A host with Upstash configured loads the Upstash list at startup and
     replaces its local list with it (`store.init()`), even when the Upstash
     list is empty.
   - Adding the variables to Render redeploys it, which empties its local file
     anyway.

   Either way, a chat that subscribed with `/start` since Render's last
   restart sends `/start` once more after the switch. Adding Upstash
   (`UPSTASH_REDIS_REST_URL` / `_TOKEN`) to BOTH hosts first changes only what
   happens from then on: the chats that subscribe again land in the shared
   list, and that list survives restarts, this switch and a rollback.
   Nothing else depends on that list.
1. **Render → `samsara-poller` → Suspend.** Suspend, do not delete: it is the
   rollback.
2. **Coolify → the application → Environment → `SAMSARA_STANDBY` = `false`
   → Redeploy.**
3. Within a minute or two the first poll catches up the events of the gap.

## 3. Check (the first hour)

- Coolify logs: `Telegram bot is online (long-polling mode)`, no `409`
  anywhere, `[Samsara] ✓ … can access notifications group`, and
  `[VideoRecovery] Settings: source=database key=database`.
- `/health`: `healthy: true`, the safety poller's `lastSuccessAt` minutes old
  at most.
- Wenze → System Health: "Samsara safety events reaching Wenze" is green.
- Wenze → Driver Groups: a group switched off reads "Not posted here" — the
  heartbeat from this build arrived.
- The next real alert reaches the Samsara Notifications group and the driver
  group, **with its video**.
- Coolify: the container stays well under its memory limit.

## Rollback (two minutes, nothing lost)

Coolify → **Stop** the application, then Render → **Resume**. The state that
decides what is sent is in the database, so Render continues where the VPS
stopped. (Without Upstash the subscriber list is a per-host file, so Render
resumes with an empty one, as after any restart, and a chat that subscribed
on the VPS sends `/start` again. With Upstash both hosts read the same list.)
Keep Render suspended
for one to two weeks before deleting it.

## Afterwards

- Delete the Render service, and any uptime pinger aimed at its URL.
- bot-backend's docs say where this service runs (APP_BRIEF §2,
  `docs/architecture/samsara-separation.md`,
  `docs/deployment/hostinger-coolify.md`): update them in the same week.
