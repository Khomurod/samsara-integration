/**
 * Where this service's operational settings come from.
 *
 * The rule that matters most for a deployment: THE ENVIRONMENT IS STILL THE
 * FALLBACK, PER VALUE. The API key currently on Render keeps working with
 * nothing entered in the admin panel and nothing migrated; a saved key wins; a
 * saved key this service cannot decrypt falls back rather than losing Samsara.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSamsaraSettingsStore, envConfig, DEFAULTS } = require('../src/samsaraSettings');
const { encryptShared, fingerprint } = require('../src/sharedIntegrationCrypto');

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

function poolReturning(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => {
    try { return await fn(); }
    finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

test('with no settings row, everything comes from the environment exactly as before', async () => {
  await withEnv({ SAMSARA_API_KEY: 'env-key', SAMSARA_API_BASE: 'https://api.samsara.com' }, async () => {
    const store = createSamsaraSettingsStore({ pool: poolReturning(null), log: silentLog });
    const cfg = await store.load();
    assert.equal(cfg.apiKey, 'env-key');
    assert.equal(cfg.apiKeySource, 'environment');
    assert.equal(cfg.videoRecoveryInitialDelaySeconds, DEFAULTS.videoRecoveryInitialDelaySeconds);
  });
});

test('an unreachable database never stops the service — it falls back', async () => {
  await withEnv({ SAMSARA_API_KEY: 'env-key' }, async () => {
    const store = createSamsaraSettingsStore({
      pool: { query: async () => { throw new Error('relation "samsara_settings" does not exist'); } },
      log: silentLog,
    });
    const cfg = await store.load();
    assert.equal(cfg.apiKey, 'env-key');
    assert.equal(cfg.source, 'environment');
  });
});

test('a saved key replaces the environment one, and the settings row drives recovery', async () => {
  await withEnv({
    SAMSARA_API_KEY: 'env-key',
    DATABASE_URL: 'postgresql://user:pass@host:5432/wenze',
  }, async () => {
    const row = {
      enabled: true,
      api_key_encrypted: encryptShared('panel-key'),
      api_key_fingerprint: fingerprint(),
      api_base: 'https://api.eu.samsara.com',
      speeding_events_enabled: true,
      max_video_megabytes: 40,
      video_recovery_enabled: true,
      video_recovery_initial_delay_seconds: 300,
      video_retrieval_enabled: true,
      video_recovery_retry_interval_seconds: 600,
      video_recovery_max_attempts: 8,
      video_retrieval_window_before_seconds: 20,
      video_retrieval_window_after_seconds: 40,
    };
    const store = createSamsaraSettingsStore({ pool: poolReturning(row), log: silentLog });
    const cfg = await store.load();

    assert.equal(cfg.apiKey, 'panel-key');
    assert.equal(cfg.apiKeySource, 'database');
    assert.equal(cfg.apiBase, 'https://api.eu.samsara.com');
    assert.equal(cfg.videoRecoveryInitialDelaySeconds, 300, 'a 5-minute configuration is accepted');
    assert.equal(cfg.videoRecoveryRetryIntervalSeconds, 600);
    assert.equal(cfg.videoRecoveryMaxAttempts, 8);
    assert.equal(cfg.maxVideoMegabytes, 40);
  });
});

test('a key written under different key material falls back instead of losing Samsara', async () => {
  // Written when DATABASE_URL was one thing, read when it is another: the
  // envelope will not open. Losing the integration over that would be far worse
  // than running on the environment variable that is still deployed.
  const ciphertext = await withEnv(
    { DATABASE_URL: 'postgresql://user:pass@host:5432/wenze' },
    async () => encryptShared('panel-key'),
  );
  await withEnv({
    SAMSARA_API_KEY: 'env-key',
    DATABASE_URL: 'postgresql://other:other@host:5432/other',
  }, async () => {
    const store = createSamsaraSettingsStore({
      pool: poolReturning({ enabled: true, api_key_encrypted: ciphertext, api_key_fingerprint: 'abc123' }),
      log: silentLog,
    });
    const cfg = await store.load();
    assert.equal(cfg.apiKey, 'env-key');
    assert.equal(cfg.apiKeySource, 'environment');
  });
});

test('the environment fallback still reads the switches this service always had', async () => {
  await withEnv({
    SAMSARA_API_KEY: 'env-key',
    SAMSARA_VIDEO_RETRY_ENABLED: 'false',
    SAMSARA_SPEEDING_ENABLED: 'false',
    SAMSARA_MAX_VIDEO_BYTES: String(50 * 1024 * 1024),
  }, async () => {
    const cfg = envConfig();
    assert.equal(cfg.videoRecoveryEnabled, false);
    assert.equal(cfg.speedingEventsEnabled, false);
    assert.equal(cfg.maxVideoMegabytes, 50);
  });
});

test('the describe() line carries no secret', async () => {
  await withEnv({ SAMSARA_API_KEY: 'super-secret-key' }, async () => {
    const store = createSamsaraSettingsStore({ pool: poolReturning(null), log: silentLog });
    const line = await store.describe();
    assert.doesNotMatch(line, /super-secret-key/);
    assert.match(line, /key=environment/);
  });
});

test('the seeded row changes nothing about a running deployment', async () => {
  // The row is created by the migration with every operational column NULL. If
  // those columns carried SQL defaults instead, a deployment's own
  // SAMSARA_MAX_VIDEO_BYTES or SAMSARA_VIDEO_RETRY_DELAY_MS would be silently
  // overwritten the moment the migration ran, before anyone opened the panel.
  await withEnv({
    SAMSARA_API_KEY: 'env-key',
    SAMSARA_MAX_VIDEO_BYTES: String(50 * 1024 * 1024),
    SAMSARA_VIDEO_RETRY_DELAY_MS: '90000',
    SAMSARA_VIDEO_RETRY_ENABLED: 'false',
    SAMSARA_SPEEDING_ENABLED: 'false',
  }, async () => {
    const seeded = {
      id: 1,
      enabled: true,
      api_key_encrypted: null,
      api_base: null,
      speeding_events_enabled: null,
      max_video_megabytes: null,
      video_recovery_enabled: null,
      video_recovery_initial_delay_seconds: null,
      video_retrieval_enabled: null,
      video_recovery_retry_interval_seconds: null,
      video_recovery_max_attempts: null,
      video_retrieval_window_before_seconds: null,
      video_retrieval_window_after_seconds: null,
    };
    const store = createSamsaraSettingsStore({ pool: poolReturning(seeded), log: silentLog });
    const cfg = await store.load();

    assert.equal(cfg.apiKey, 'env-key');
    assert.equal(cfg.maxVideoMegabytes, 50, 'the deployed size cap survives the migration');
    assert.equal(cfg.videoRecoveryInitialDelaySeconds, 90, 'and the deployed delay');
    assert.equal(cfg.videoRecoveryEnabled, false, 'and a deployment that turned recovery off stays off');
    assert.equal(cfg.speedingEventsEnabled, false);

    // The columns with no environment counterpart still get the shipped defaults.
    assert.equal(cfg.videoRecoveryMaxAttempts, DEFAULTS.videoRecoveryMaxAttempts);
    assert.equal(cfg.videoRetrievalWindowAfterSeconds, DEFAULTS.videoRetrievalWindowAfterSeconds);
  });
});

test('a saved value does override the environment — that is the point', async () => {
  await withEnv({
    SAMSARA_API_KEY: 'env-key',
    SAMSARA_MAX_VIDEO_BYTES: String(50 * 1024 * 1024),
    SAMSARA_VIDEO_RETRY_ENABLED: 'false',
  }, async () => {
    const store = createSamsaraSettingsStore({
      pool: poolReturning({
        id: 1, enabled: true, max_video_megabytes: 30, video_recovery_enabled: true,
      }),
      log: silentLog,
    });
    const cfg = await store.load();
    assert.equal(cfg.maxVideoMegabytes, 30);
    assert.equal(cfg.videoRecoveryEnabled, true, 'FALSE in the environment is not a veto on THIS reader');
  });
});

// ── how often the row is read, and what comes back (Supabase egress) ─────────

/** A pool that records every statement it is sent. */
function recordingPool(answer) {
  const statements = [];
  return {
    statements,
    query: async (sql) => {
      statements.push(String(sql));
      return answer();
    },
  };
}

test('the row is re-read every five minutes, not every thirty seconds', async () => {
  const pool = recordingPool(() => ({ rows: [{ enabled: true }] }));
  const store = createSamsaraSettingsStore({ pool, log: silentLog });

  await store.load({ now: 0 });
  await store.load({ now: 30_000 });
  await store.load({ now: 299_999 });
  assert.equal(pool.statements.length, 1,
    'the old 30 s cache read it ~1.65 times a minute, on every poll path');

  await store.load({ now: 300_000 });
  assert.equal(pool.statements.length, 2, 'a change saved in the panel still lands within five minutes');
});

test('a FAILED read is retried after 30 s, and the recovered row is then kept for five minutes', async () => {
  let failing = true;
  const pool = recordingPool(() => {
    if (failing) throw new Error('connection terminated');
    return { rows: [{ enabled: false }] };
  });
  const store = createSamsaraSettingsStore({ pool, log: silentLog });

  assert.equal((await store.load({ now: 0 })).source, 'environment');
  failing = false;
  assert.equal((await store.load({ now: 29_999 })).source, 'environment');

  const recovered = await store.load({ now: 30_000 });
  assert.equal(recovered.source, 'database',
    'a transient error must not hold the environment fallback for five minutes');
  assert.equal(recovered.enabled, false, 'an operator who switched Samsara off is obeyed again');

  await store.load({ now: 30_000 + 299_999 });
  assert.equal(pool.statements.length, 2);
});

test('the row is read BY NAME — exactly the columns mapRow uses, never SELECT *', async () => {
  const pool = recordingPool(() => ({ rows: [] }));
  await createSamsaraSettingsStore({ pool, log: silentLog }).load();
  const sql = pool.statements[0];

  assert.doesNotMatch(sql, /SELECT\s+\*/i);
  assert.match(sql, /FROM samsara_settings WHERE id = 1/);
  const selected = sql.match(/SELECT([\s\S]*?)FROM/i)[1].split(',').map((c) => c.trim()).sort();
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'samsaraSettings.js'), 'utf8');
  const read = [...new Set([...source.matchAll(/\brow\.([a-z_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(selected, read,
    'a column mapRow reads but the query omits is silently undefined, so the environment '
    + 'would quietly win over the admin panel');
});
