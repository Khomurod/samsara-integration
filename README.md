# Samsara → Telegram Alert Bot

A Node.js bot that **polls the Samsara API** for fleet safety events every 15 seconds and instantly forwards them to subscribed **Telegram** users with clean, formatted messages including video attachments.

---

## How It Works

```
Samsara Fleet Safety Event occurs
          │
          ▼
GET /fleet/safety-events  (every 15 seconds)
          │
          ▼
  Transform + Format event (poller.js → formatter.js)
          │
          ▼
  Rate-limited queue (2s between messages)
          │
          ▼
Telegram Bot → All Subscribed Users
     (text + video attachment)
```

The bot **actively polls** the Samsara API — no Samsara webhooks, no missed events.
Because polling uses cursor-based pagination saved to disk, the bot picks up every
event that occurred even if it was offline or restarting.

---

## File Structure

```
Samsara-Integration/
├── index.js              ← Entry point (Express health endpoint, Telegram bot, startup)
├── .env                  ← Secrets & config
├── .gitignore
├── package.json
├── recommendation.md     ← Architecture decision record (polling vs webhooks)
├── test-live.js          ← Preview formatting with a real Samsara event (no send)
├── test-mock.js          ← Preview formatting with a mocked event (no send)
├── test-poller.js        ← Test cursor persistence and API connectivity
├── test-send.js          ← Send a mock alert to Telegram for format verification
├── test-send-live.js     ← Send the latest real event to Telegram for verification
├── data/                 ← Auto-created, gitignored
│   ├── cursor.db         ← SQLite: pagination cursor (survives restarts)
│   └── subscribers.json  ← Local JSON fallback for subscriber store
└── src/
    ├── poller.js     ← Samsara API polling, event transform, Telegram queue
    ├── formatter.js  ← Converts raw Samsara event → HTML Telegram message
    ├── store.js      ← Subscriber persistence (Upstash Redis or local JSON)
    └── db.js         ← Cursor persistence (SQLite WAL or JSON fallback)
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure `.env`
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
SAMSARA_API_KEY=your_samsara_api_key
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

### 3. Start the bot
```bash
npm start
```

### 4. Subscribe on Telegram
- Search for **@wenzesambot** on Telegram
- Send `/start` → you're subscribed to all Samsara alerts

---

## Telegram Bot Commands

| Command   | Description                        |
|-----------|------------------------------------|
| `/start`  | Subscribe to Samsara alerts        |
| `/stop`   | Unsubscribe from alerts            |
| `/status` | Check your subscription status     |
| `/help`   | Show all commands                  |

---

## Samsara Dashboard Setup

No webhook configuration needed in Samsara. The bot reads directly from the
Samsara API — just provide a valid API key with at minimum **Read** access to
**Safety Events**. No alert configurations or webhook URLs are required.

---

## Environment Variables

| Variable                    | Required | Description                                                        |
|-----------------------------|----------|--------------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`        | ✅       | Telegram bot token from BotFather                                   |
| `SAMSARA_API_KEY`           | ✅       | Samsara API key — used for polling `GET /fleet/safety-events`       |
| `UPSTASH_REDIS_REST_URL`    | ⚠️       | Upstash Redis URL — required for subscriber persistence across restarts |
| `UPSTASH_REDIS_REST_TOKEN`  | ⚠️       | Upstash Redis token                                                 |
| `USE_WEBHOOK`               | ❌       | Set to `true` to use Telegram webhook mode instead of long-polling  |
| `PUBLIC_WEBHOOK_URL`        | ❌       | Your public HTTPS URL (needed if `USE_WEBHOOK=true`)                |
| `RENDER_EXTERNAL_URL`       | ❌       | Auto-set by Render, used as fallback for the webhook URL            |
| `PORT` / `WEBHOOK_PORT`     | ❌       | Express server port (default: `3000`)                               |

> **Without Upstash Redis**, subscribers are stored in `data/subscribers.json` on the
> local filesystem. On Render, this file is lost on every deploy/restart. Set up Redis
> for production to prevent subscribers from being wiped.

---

## Samsara API Rate Limits

Samsara enforces a global limit of **5 requests/second** per API key and returns
`HTTP 429` if exceeded (with a `Retry-After` header). This bot polls once every
**15 seconds** (4 req/min, ~5,760 req/day) — well within all documented limits.
The polling interval can be adjusted in `index.js` (`poller.start(15000)`).

The bot handles `429` and other HTTP errors gracefully: errors are logged and the
next poll simply runs on the next tick without crashing or retrying in a tight loop.

---

## Testing

| Script              | What it does                                                     |
|---------------------|------------------------------------------------------------------|
| `node test-mock.js` | Renders a mock event and prints the Telegram message text        |
| `node test-live.js` | Fetches the latest real Samsara event and previews formatting    |
| `node test-poller.js` | Tests cursor DB read/write and API connectivity                |
| `node test-send.js` | Sends a mock alert to Telegram (requires a subscriber)          |
| `node test-send-live.js` | Sends the latest real event to Telegram                   |

---

## Running as its OWN separate repository / Render service

This folder is fully self-contained and is designed to be lifted out of the
main `bot-backend` repo into its own GitHub repository and run as its own
Render web service. It no longer imports anything from the main app.

**How the two services still talk to each other after the split** — they do
NOT call each other directly. They cooperate through two shared things:

1. **The same PostgreSQL database (`DATABASE_URL`).** This service reads the
   `groups` table (managed by the main app's admin panel) to find which driver
   Telegram group belongs to each truck unit number. That is how a safety
   video reaches the correct drivers group.
2. **The same Telegram bot tokens.** `BOT_TOKEN` (the main feedback bot) posts
   the video + friendly caption into the driver group; `TELEGRAM_BOT_TOKEN`
   (the Samsara bot) sends the Samsara notification group / subscribers.

So as long as this service is given the **same `DATABASE_URL` and same
`BOT_TOKEN`** as the main hub, every feature keeps working exactly as before.

### Deploy steps (summary)

1. Copy the **contents** of this folder to the root of a new GitHub repo.
2. On Render: **New → Blueprint**, pick that repo. It reads `render.yaml`.
3. Fill in the environment variables (see `.env.example`). Use the SAME
   `DATABASE_URL` and `BOT_TOKEN` as the main hub.
4. Deploy. The `/health` endpoint confirms it is running.

A full plain-language, button-by-button walkthrough lives in
`SAMSARA-SEPARATION-GUIDE.md` at the root of the main repo.

---

## ⚠️ Credentials Notice

> A local `.env` file may exist for development convenience. It is now listed in
> `.gitignore` so it will **not** be committed to the new repository.
> **Before deploying, rotate the Telegram bot tokens and Samsara API key** if
> they were ever committed anywhere. Inject secrets via environment variables
> only — never paste real secrets into a public repo.

---

## License

Private — internal use only.
