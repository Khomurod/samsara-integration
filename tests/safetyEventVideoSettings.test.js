'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSafetyEventVideoStore } = require('../src/safetyEventVideoSettings');

// A tiny fake pg pool that answers the two SELECTs the store makes.
function makePool({ settingsRow, musicRow, failSettings = false }) {
  const counts = { settings: 0, music: 0 };
  return {
    counts,
    async query(sql, params) {
      if (/safety_event_video_settings/.test(sql)) {
        counts.settings += 1;
        if (failSettings) throw new Error('relation "safety_event_video_settings" does not exist');
        return { rows: settingsRow ? [settingsRow] : [] };
      }
      if (/safety_event_music_assets/.test(sql)) {
        counts.music += 1;
        // Honor the id filter so an inactive/missing asset returns nothing.
        return { rows: musicRow && musicRow.id === params[0] ? [musicRow] : [] };
      }
      return { rows: [] };
    },
  };
}

const silent = { warn() {}, log() {}, error() {} };

test('loadConfig returns disabled when the feature is off', async () => {
  const pool = makePool({ settingsRow: { driver_group_music_enabled: false, active_music_asset_id: 1 } });
  const store = createSafetyEventVideoStore({ pool, log: silent });
  const cfg = await store.loadConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'disabled');
});

test('loadConfig returns disabled (no-active-music) when no asset is selected', async () => {
  const pool = makePool({ settingsRow: { driver_group_music_enabled: true, active_music_asset_id: null } });
  const store = createSafetyEventVideoStore({ pool, log: silent });
  const cfg = await store.loadConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no-active-music');
});

test('loadConfig returns enabled + music bytes when configured', async () => {
  const pool = makePool({
    settingsRow: {
      driver_group_music_enabled: true, speeding_music_enabled: true, active_music_asset_id: 5,
      music_volume: '0.4', preserve_original_audio: true, fade_in_seconds: '0', fade_out_seconds: '2',
      loop_music_when_video_longer: true, max_video_seconds: 120,
    },
    musicRow: { id: 5, mime_type: 'audio/mp4', duration_seconds: '171.108', updated_at: 't', file_data: Buffer.from('BYTES') },
  });
  const store = createSafetyEventVideoStore({ pool, log: silent });
  const cfg = await store.loadConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.music.id, 5);
  assert.ok(Buffer.isBuffer(cfg.music.data));
  assert.equal(cfg.musicVolume, 0.4);
  assert.equal(cfg.music.durationSeconds, 171.108);
});

test('loadConfig disables gracefully when the settings table is missing', async () => {
  const pool = makePool({ failSettings: true });
  const store = createSafetyEventVideoStore({ pool, log: silent });
  const cfg = await store.loadConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'error');
});

test('loadConfig disables when there is no DB pool', async () => {
  const store = createSafetyEventVideoStore({ pool: null, log: silent });
  const cfg = await store.loadConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no-db');
});

test('loadConfig caches music bytes across calls (no repeated BYTEA fetch)', async () => {
  const pool = makePool({
    settingsRow: { driver_group_music_enabled: true, active_music_asset_id: 5 },
    musicRow: { id: 5, mime_type: 'audio/mp4', duration_seconds: '10', updated_at: 't', file_data: Buffer.from('B') },
  });
  const store = createSafetyEventVideoStore({ pool, log: silent });
  const t0 = 1_000_000;
  await store.loadConfig({ now: t0 });
  await store.loadConfig({ now: t0 + 1000 }); // within settings TTL
  assert.equal(pool.counts.settings, 1, 'settings fetched once within TTL');
  assert.equal(pool.counts.music, 1, 'music bytes fetched once (cached by asset id)');
});

test('recordJobStart / finishJob never throw when the jobs table is missing', async () => {
  const pool = {
    async query() { throw new Error('relation "safety_event_video_jobs" does not exist'); },
  };
  const store = createSafetyEventVideoStore({ pool, log: silent });
  const id = await store.recordJobStart({ samsaraEventId: 'e1' });
  assert.equal(id, null);
  await store.finishJob(123, { status: 'sent' }); // must not throw
});
