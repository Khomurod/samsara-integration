/**
 * Every Telegram call goes out over IPv4 (src/telegramNetwork.js).
 *
 * The VPS this service runs on black-holes large request bodies over IPv6, so
 * a sendVideo that picks the AAAA record stalls. node-telegram-bot-api merges
 * `options.request` into every request it makes, uploads included — these
 * tests pin that the agent reaches it, that the caller's options survive, and
 * that the library really hands our agent to the request it builds.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');

const { telegramIpv4Agent, telegramBotOptions, preferIpv4 } = require('../src/telegramNetwork');

test('the Telegram agent is IPv4-only and keeps connections alive', () => {
  assert.equal(telegramIpv4Agent.options.family, 4);
  assert.equal(telegramIpv4Agent.keepAlive, true);
});

test('bot options keep what the caller set and add the IPv4 agent', () => {
  const opts = telegramBotOptions({ polling: false, request: { timeout: 1000 } });
  assert.equal(opts.polling, false);
  assert.equal(opts.request.timeout, 1000);
  assert.equal(opts.request.agent, telegramIpv4Agent);
  assert.equal(telegramBotOptions().request.agent, telegramIpv4Agent);
});

test('the bot library hands our agent to the HTTP layer for every call, uploads included', async () => {
  // Capture what node-telegram-bot-api passes to its HTTP client, by stubbing
  // that client before loading a fresh copy of the library.
  const clientPath = require.resolve('@cypress/request-promise', { paths: [require.resolve('node-telegram-bot-api')] });
  const libDir = require.resolve('node-telegram-bot-api').replace(/index\.js$/, '');
  const saved = require.cache[clientPath];
  const seen = [];
  require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true,
    exports: (options) => {
      seen.push({ url: String(options.url).replace(/bot[^/]+/, 'bot***'), agent: options.agent, multipart: Boolean(options.formData) });
      return Promise.resolve({ body: JSON.stringify({ ok: true, result: { message_id: 1, username: 'b' } }) });
    },
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(libDir)) delete require.cache[key];
  try {
    const FreshBot = require('node-telegram-bot-api');
    const bot = new FreshBot('123:abc', telegramBotOptions({ polling: false }));
    await bot.getMe();
    await bot.sendVideo('-1', Buffer.from('video'), {}, { filename: 'a.mp4', contentType: 'video/mp4' });
    await bot.sendMessage('-1', 'hi');
    assert.deepEqual(seen.map((s) => s.url.split('/').pop()), ['getMe', 'sendVideo', 'sendMessage']);
    assert.equal(seen[1].multipart, true, 'the upload is the multipart request the black hole breaks');
    assert.ok(seen.every((s) => s.agent === telegramIpv4Agent), 'every call, the upload included, uses the IPv4 agent');
  } finally {
    if (saved) require.cache[clientPath] = saved; else delete require.cache[clientPath];
    for (const key of Object.keys(require.cache)) if (key.startsWith(libDir)) delete require.cache[key];
  }
});

test('every other lookup prefers IPv4', () => {
  assert.equal(preferIpv4(), true);
  if (typeof dns.getDefaultResultOrder === 'function') {
    assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
  }
});
