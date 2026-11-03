/**
 * telegramNetwork.js
 *
 * Every Telegram call this service makes goes out over IPv4.
 *
 * WHY. On the Hostinger VPS that runs the hub (and that this service is moving
 * to), the IPv6 route to api.telegram.org black-holes multi-packet request
 * bodies: getUpdates and sendMessage go through, but sendVideo stalls until it
 * times out. bot-backend met it first and pins IPv4 the same way
 * (services/telegramAgent.js there). On Render it changes nothing — IPv4 works
 * there too — so the same build runs on either host.
 *
 * node-telegram-bot-api merges `options.request` into EVERY request it makes —
 * API calls, multipart uploads (sendVideo, sendMediaGroup) and file downloads —
 * so one agent here covers all of them.
 *
 * `preferIpv4()` makes every OTHER lookup in the process (the Samsara API, the
 * CDN the dashcam clips come from, the AI providers, Upstash) try the IPv4
 * address first. It only reorders DNS answers; it overrides nothing a person
 * configured.
 */
const https = require('https');
const dns = require('dns');

const telegramIpv4Agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  family: 4,
});

/** Options for `new TelegramBot(token, …)`, with the IPv4 agent added. */
function telegramBotOptions(options = {}) {
  return {
    ...options,
    request: { ...(options.request || {}), agent: telegramIpv4Agent },
  };
}

/** Prefer IPv4 for every other connection this process opens. */
function preferIpv4() {
  if (typeof dns.setDefaultResultOrder !== 'function') return false;
  dns.setDefaultResultOrder('ipv4first');
  return true;
}

module.exports = { telegramIpv4Agent, telegramBotOptions, preferIpv4 };
