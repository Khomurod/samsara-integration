/**
 * safetyEventVideoSettings.js
 *
 * Read-side of the driver-group music overlay for the Samsara poller.
 *
 * The admin/hub (bot-backend) OWNS these tables and writes them from the admin
 * panel:
 *   - safety_event_video_settings (single row id = 1)
 *   - safety_event_music_assets   (the uploaded music; bytes in BYTEA)
 * This poller only READS them (plus best-effort writes to the
 * safety_event_video_jobs observability ledger). Everything degrades to
 * "disabled / original video" when the tables are missing, the feature is off,
 * or no active music exists — so a fresh DB never breaks delivery.
 *
 * Music BYTEA is cached in memory (keyed by asset id) so we don't re-download a
 * few MB from Postgres on every single event.
 */

const SETTINGS_TTL_MS = 30_000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool  shared Postgres pool (db.getPgPool())
 * @param {Console} [opts.log]
 */
function createSafetyEventVideoStore({ pool, log = console } = {}) {
  let settingsCache = null;
  let settingsExpiresAt = 0;
  // Cached active-music bytes: { id, updatedAt, mimeType, durationSeconds, data }.
  let musicCache = null;
  let warnedNoPool = false;

  function clearCache() {
    settingsCache = null;
    settingsExpiresAt = 0;
    musicCache = null;
  }

  async function readSettingsRow() {
    const res = await pool.query('SELECT * FROM safety_event_video_settings WHERE id = 1');
    return res.rows[0] || null;
  }

  function mapSettings(row) {
    return {
      driverGroupMusicEnabled: row ? row.driver_group_music_enabled === true : false,
      speedingMusicEnabled: row ? row.speeding_music_enabled !== false : true,
      activeMusicAssetId: row?.active_music_asset_id ?? null,
      musicVolume: num(row?.music_volume, 0.35),
      preserveOriginalAudio: row ? row.preserve_original_audio !== false : true,
      fadeInSeconds: num(row?.fade_in_seconds, 0),
      fadeOutSeconds: num(row?.fade_out_seconds, 1.5),
      loopMusicWhenVideoLonger: row ? row.loop_music_when_video_longer !== false : true,
      maxVideoSeconds: num(row?.max_video_seconds, 120),
    };
  }

  async function readActiveMusic(assetId, updatedHint) {
    // Reuse cached bytes when the active asset id is unchanged.
    if (musicCache && musicCache.id === assetId) return musicCache;
    const res = await pool.query(
      `SELECT id, mime_type, duration_seconds, updated_at, file_data
         FROM safety_event_music_assets
        WHERE id = $1 AND is_active = TRUE AND storage_kind = 'db_bytea'`,
      [assetId],
    );
    const row = res.rows[0];
    if (!row || !row.file_data) {
      musicCache = null;
      return null;
    }
    musicCache = {
      id: row.id,
      updatedAt: row.updated_at,
      mimeType: row.mime_type,
      durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
      data: row.file_data, // Buffer
    };
    return musicCache;
  }

  /**
   * Load the effective config + active music. Never throws — returns
   * { enabled:false, reason } on any problem so callers can safely fall back.
   * @returns {Promise<{
   *   enabled:boolean, speedingMusicEnabled:boolean, musicVolume:number,
   *   preserveOriginalAudio:boolean, fadeInSeconds:number, fadeOutSeconds:number,
   *   loopMusicWhenVideoLonger:boolean, maxVideoSeconds:number,
   *   music:{id:number,mimeType:string,durationSeconds:?number,data:Buffer}|null,
   *   reason?:string }>}
   */
  async function loadConfig({ now = Date.now() } = {}) {
    if (!pool) {
      if (!warnedNoPool) {
        log.warn?.('[SafetyVideo] No DATABASE_URL/pool — driver-group music overlay disabled.');
        warnedNoPool = true;
      }
      return { enabled: false, reason: 'no-db' };
    }
    try {
      let settings = settingsCache;
      if (!settings || now >= settingsExpiresAt) {
        settings = mapSettings(await readSettingsRow());
        settingsCache = settings;
        settingsExpiresAt = now + SETTINGS_TTL_MS;
      }

      if (!settings.driverGroupMusicEnabled) {
        return { ...settings, enabled: false, music: null, reason: 'disabled' };
      }
      if (!settings.activeMusicAssetId) {
        return { ...settings, enabled: false, music: null, reason: 'no-active-music' };
      }

      const music = await readActiveMusic(settings.activeMusicAssetId);
      if (!music) {
        return { ...settings, enabled: false, music: null, reason: 'active-music-missing' };
      }
      return { ...settings, enabled: true, music };
    } catch (err) {
      // Missing table / transient DB error → behave as disabled (original video).
      log.warn?.(`[SafetyVideo] loadConfig failed (falling back to original video): ${err.message}`);
      return { enabled: false, reason: 'error' };
    }
  }

  // ── Best-effort job ledger (never blocks / throws into delivery) ────────────

  async function recordJobStart({
    samsaraEventId = null,
    telegramGroupId = null,
    musicAssetId = null,
    videoSource = null,
    videoReference = null,
  } = {}) {
    if (!pool) return null;
    try {
      const res = await pool.query(
        `INSERT INTO safety_event_video_jobs
           (samsara_event_id, telegram_group_id, music_asset_id, status, video_source, video_reference, started_at)
         VALUES ($1,$2,$3,'processing',$4,$5,NOW())
         RETURNING id`,
        [
          samsaraEventId == null ? null : String(samsaraEventId),
          telegramGroupId == null ? null : String(telegramGroupId),
          musicAssetId,
          videoSource,
          videoReference,
        ],
      );
      return res.rows[0]?.id ?? null;
    } catch (err) {
      log.warn?.(`[SafetyVideo] recordJobStart failed: ${err.message}`);
      return null;
    }
  }

  async function finishJob(jobId, { status, errorMessage = null, videoDurationSeconds = null, musicTrimMode = null } = {}) {
    if (!pool || !jobId) return;
    try {
      await pool.query(
        `UPDATE safety_event_video_jobs
            SET status = $2,
                error_message = $3,
                video_duration_seconds = COALESCE($4, video_duration_seconds),
                music_trim_mode = COALESCE($5, music_trim_mode),
                finished_at = NOW()
          WHERE id = $1`,
        [jobId, status, errorMessage, videoDurationSeconds, musicTrimMode],
      );
    } catch (err) {
      log.warn?.(`[SafetyVideo] finishJob failed: ${err.message}`);
    }
  }

  return { loadConfig, clearCache, recordJobStart, finishJob };
}

module.exports = { createSafetyEventVideoStore };
