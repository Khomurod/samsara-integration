/**
 * safetyEventVideoMusicService.js
 *
 * Embeds background music into the DRIVER-GROUP copy of a speeding-event dashcam
 * video. This is BRANCH B only — the Samsara notifications group is never routed
 * through here and always gets the original, immediate video.
 *
 * Design guarantees:
 *   • The driver group NEVER loses the video because of music processing. Any
 *     error (no ffmpeg, probe fail, encode fail, timeout, oversized video) falls
 *     back to sending the ORIGINAL buffer.
 *   • Output duration always equals the VIDEO duration:
 *       - music longer than video  → music is trimmed (via -t / amix duration).
 *       - music shorter than video → looped to fill (setting) or played once
 *         with a silent tail.
 *   • Original video stream is COPIED (-c:v copy): dimensions/quality preserved,
 *     fast, low CPU, negligible size change. Only audio is (re)encoded to AAC.
 *   • ffmpeg is resolved from FFMPEG_PATH → optional ffmpeg-static package → PATH.
 *
 * ffmpeg is invoked via child_process; the invocation layer is injectable so the
 * pure planning/arg-building logic and the fallback behaviour are unit-testable
 * without a real ffmpeg binary.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const FFMPEG_TIMEOUT_MS = parseInt(process.env.SAFETY_MUSIC_FFMPEG_TIMEOUT_MS || '60000', 10);

function resolveBinary(envVar, staticPkgs, fallback) {
  const fromEnv = String(process.env[envVar] || '').trim();
  if (fromEnv) return fromEnv;
  for (const pkg of staticPkgs) {
    try {
      // Optional peer deps — present only if the operator installed them.
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const resolved = require(pkg);
      const p = typeof resolved === 'string' ? resolved : resolved?.path;
      if (p) return p;
    } catch (_) { /* not installed */ }
  }
  return fallback;
}

function resolveFfmpegPath() {
  return resolveBinary('FFMPEG_PATH', ['ffmpeg-static'], 'ffmpeg');
}
function resolveFfprobePath() {
  return resolveBinary('FFPROBE_PATH', ['@ffprobe-installer/ffprobe', 'ffprobe-static'], 'ffprobe');
}

/**
 * Decide how the music should be fitted to the video.
 * @returns {{mode:'trim'|'loop'|'once', loopMusic:boolean}}
 */
function chooseMusicPlan({ videoDurationSeconds, musicDurationSeconds, loopWhenLonger }) {
  const v = Number(videoDurationSeconds) || 0;
  const m = Number(musicDurationSeconds) || 0;
  if (m <= 0 || v <= 0) {
    // Unknown durations → safest is trim-to-video via -t, no looping.
    return { mode: 'trim', loopMusic: false };
  }
  if (m >= v) return { mode: 'trim', loopMusic: false };   // music covers the whole video
  return loopWhenLonger
    ? { mode: 'loop', loopMusic: true }                    // repeat music to fill
    : { mode: 'once', loopMusic: false };                  // play once, silent tail
}

function round3(n) { return Math.round(Number(n) * 1000) / 1000; }

/**
 * Build the ffmpeg argument vector. Pure + deterministic (unit-tested).
 */
function buildFfmpegArgs({
  videoPath,
  musicPath,
  outPath,
  videoDurationSeconds,
  hasOriginalAudio,
  settings,
  plan,
}) {
  const volume = Math.max(0, Number(settings.musicVolume) || 0);
  const fadeIn = Math.max(0, Number(settings.fadeInSeconds) || 0);
  const fadeOut = Math.max(0, Number(settings.fadeOutSeconds) || 0);
  const dur = round3(videoDurationSeconds);
  const fadeOutStart = round3(Math.max(0, dur - fadeOut));

  // Music-track filter chain (applied to the music input): volume + fades.
  const musicFilters = [`volume=${volume}`];
  if (fadeIn > 0) musicFilters.push(`afade=t=in:st=0:d=${round3(fadeIn)}`);
  if (fadeOut > 0 && dur > 0) musicFilters.push(`afade=t=out:st=${fadeOutStart}:d=${round3(fadeOut)}`);
  const musicFilterStr = musicFilters.join(',');

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  // Input 0 = video.
  args.push('-i', videoPath);
  // Input 1 = music (loop the *input* if we need to fill a longer video).
  if (plan.loopMusic) args.push('-stream_loop', '-1');
  args.push('-i', musicPath);

  const mix = hasOriginalAudio && settings.preserveOriginalAudio === true;
  if (mix) {
    // Mix original audio (full volume) with music underneath. duration=first
    // bounds the mix to the original audio length (= the video length).
    const fc = `[1:a]${musicFilterStr}[bg];`
      + '[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]';
    args.push('-filter_complex', fc, '-map', '0:v:0', '-map', '[aout]');
  } else {
    // Replace audio with music only.
    args.push('-map', '0:v:0', '-map', '1:a:0', '-af', musicFilterStr);
  }

  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k');
  if (dur > 0) args.push('-t', String(dur)); // hard-bound output to video length
  args.push('-movflags', '+faststart', outPath);
  return args;
}

/** Parse an ffmpeg/ffprobe "Duration: HH:MM:SS.xx" line. */
function parseDurationFromStderr(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''));
  if (!m) return null;
  return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}

/**
 * Create an ffmpeg facade. Injectable `spawnFn` (defaults to child_process.spawn)
 * keeps the encode/probe layer swappable in tests.
 */
function makeFfmpeg({
  ffmpegPath = resolveFfmpegPath(),
  ffprobePath = resolveFfprobePath(),
  spawnFn = spawn,
  timeoutMs = FFMPEG_TIMEOUT_MS,
  log = console,
} = {}) {
  let availabilityCache;

  function runProcess(bin, args) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        reject(new Error(`${path.basename(String(bin))} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${path.basename(String(bin))} exited ${code}: ${stderr.slice(0, 500)}`));
      });
    });
  }

  async function isAvailable() {
    if (availabilityCache !== undefined) return availabilityCache;
    try {
      await runProcess(ffmpegPath, ['-hide_banner', '-version']);
      availabilityCache = true;
    } catch (err) {
      log.warn?.(`[SafetyVideo] ffmpeg not available (${ffmpegPath}): ${err.message}. `
        + 'Driver-group videos will be sent WITHOUT music. Set FFMPEG_PATH or install ffmpeg.');
      availabilityCache = false;
    }
    return availabilityCache;
  }

  /** @returns {Promise<{durationSeconds:?number, hasAudio:boolean}>} */
  async function probe(filePath) {
    // Prefer ffprobe (structured JSON), fall back to parsing `ffmpeg -i`.
    try {
      const { stdout } = await runProcess(ffprobePath, [
        '-v', 'error', '-print_format', 'json',
        '-show_entries', 'format=duration:stream=codec_type', filePath,
      ]);
      const json = JSON.parse(stdout || '{}');
      const durationSeconds = json.format?.duration ? Number(json.format.duration) : null;
      const hasAudio = Array.isArray(json.streams)
        && json.streams.some((s) => s.codec_type === 'audio');
      return { durationSeconds, hasAudio };
    } catch (_) {
      try {
        const { stderr } = await runProcess(ffmpegPath, ['-hide_banner', '-i', filePath]);
        return { durationSeconds: parseDurationFromStderr(stderr), hasAudio: /Audio:/.test(stderr) };
      } catch (err) {
        // `ffmpeg -i` exits non-zero (no output file) but still prints the info.
        const durationSeconds = parseDurationFromStderr(err.message);
        return { durationSeconds, hasAudio: /Audio:/.test(err.message) };
      }
    }
  }

  async function run(args) {
    return runProcess(ffmpegPath, args);
  }

  return { isAvailable, probe, run, ffmpegPath, ffprobePath };
}

function makeTempDir(base) {
  const dir = path.join(base || os.tmpdir(), `se-music-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeUnlinkDir(dir, log = console) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn?.(`[SafetyVideo] temp cleanup failed for ${dir}: ${err.message}`);
  }
}

function musicExtFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('aac')) return 'aac';
  return 'm4a'; // audio/mp4, audio/x-m4a, default
}

/**
 * High-level driver-group video processor.
 *
 * @param {object} opts
 * @param {object} opts.store   safetyEventVideoSettings store (loadConfig, recordJobStart, finishJob)
 * @param {object} [opts.ffmpeg] ffmpeg facade (defaults to makeFfmpeg())
 * @param {string} [opts.tmpDir] base temp dir
 * @param {Console} [opts.log]
 */
function createDriverVideoProcessor({ store, ffmpeg = makeFfmpeg(), tmpDir, log = console } = {}) {
  /**
   * Return a (possibly music-overlaid) buffer for a DRIVER-GROUP video. NEVER
   * throws — on any problem it returns the original buffer so the driver group
   * still receives the clip.
   *
   * @param {Buffer} buffer original video bytes
   * @param {object} ctx
   * @param {boolean} ctx.isSpeeding   whether this is a speeding event (scope gate)
   * @param {'single'|'forward'|'inward'} [ctx.role]  which camera; 'inward' is skipped
   * @param {string} [ctx.eventId]
   * @param {string|number} [ctx.groupId]
   * @param {'immediate'|'backfill'} [ctx.source]
   * @returns {Promise<Buffer>}
   */
  async function prepareDriverVideoBuffer(buffer, ctx = {}) {
    const {
      isSpeeding = false, role = 'single', eventId = null, groupId = null, source = 'immediate',
    } = ctx;

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;

    // Scope: music overlay applies to SPEEDING events only.
    if (!isSpeeding) return buffer;
    // Avoid double music on dual-camera media groups: only the primary/forward
    // camera gets music; the inward camera stays original.
    if (role === 'inward') return buffer;

    let config;
    try {
      config = await store.loadConfig();
    } catch (err) {
      log.warn?.(`[SafetyVideo] loadConfig threw unexpectedly: ${err.message}`);
      return buffer;
    }
    if (!config || !config.enabled || !config.music) return buffer;
    if (config.speedingMusicEnabled === false) return buffer;

    if (!(await ffmpeg.isAvailable())) return buffer;

    let jobId = null;
    let workDir = null;
    try {
      jobId = await store.recordJobStart({
        samsaraEventId: eventId,
        telegramGroupId: groupId,
        musicAssetId: config.music.id,
        videoSource: source,
        videoReference: eventId ? `event:${eventId}:${role}` : null,
      });

      workDir = makeTempDir(tmpDir);
      const videoPath = path.join(workDir, 'in.mp4');
      const musicPath = path.join(workDir, `music.${musicExtFromMime(config.music.mimeType)}`);
      const outPath = path.join(workDir, 'out.mp4');
      fs.writeFileSync(videoPath, buffer);
      fs.writeFileSync(musicPath, config.music.data);

      const { durationSeconds: videoDuration, hasAudio } = await ffmpeg.probe(videoPath);

      // Safety cap: skip heavy jobs, fall back to original.
      const cap = Number(config.maxVideoSeconds) || 0;
      if (cap > 0 && videoDuration && videoDuration > cap) {
        log.log?.(`[SafetyVideo] video ${round3(videoDuration)}s exceeds cap ${cap}s — sending original.`);
        await store.finishJob(jobId, { status: 'fallback_sent', errorMessage: 'video exceeds max_video_seconds', videoDurationSeconds: videoDuration });
        return buffer;
      }

      let musicDuration = config.music.durationSeconds;
      if (musicDuration == null) {
        const probed = await ffmpeg.probe(musicPath);
        musicDuration = probed.durationSeconds;
      }

      const plan = chooseMusicPlan({
        videoDurationSeconds: videoDuration,
        musicDurationSeconds: musicDuration,
        loopWhenLonger: config.loopMusicWhenVideoLonger !== false,
      });

      const args = buildFfmpegArgs({
        videoPath,
        musicPath,
        outPath,
        videoDurationSeconds: videoDuration || musicDuration || 0,
        hasOriginalAudio: hasAudio,
        settings: config,
        plan,
      });

      log.log?.(`[SafetyVideo] overlaying music asset=${config.music.id} video=${round3(videoDuration)}s `
        + `music=${round3(musicDuration)}s mode=${plan.mode} mix=${hasAudio && config.preserveOriginalAudio} `
        + `role=${role} event=${eventId || 'n/a'}`);

      await ffmpeg.run(args);
      const outBuf = fs.readFileSync(outPath);
      if (!outBuf || outBuf.length === 0) throw new Error('ffmpeg produced an empty file');

      await store.finishJob(jobId, {
        status: 'sent',
        videoDurationSeconds: videoDuration,
        musicTrimMode: plan.mode,
      });
      log.log?.(`[SafetyVideo] overlay ok: ${(outBuf.length / 1024).toFixed(0)}KB (was ${(buffer.length / 1024).toFixed(0)}KB) event=${eventId || 'n/a'}`);
      return outBuf;
    } catch (err) {
      log.error?.(`[SafetyVideo] overlay failed (${err.message}); sending original video. event=${eventId || 'n/a'}`);
      if (jobId) {
        await store.finishJob(jobId, { status: 'fallback_sent', errorMessage: String(err.message).slice(0, 500) });
      }
      return buffer;
    } finally {
      safeUnlinkDir(workDir, log);
    }
  }

  return { prepareDriverVideoBuffer, ffmpeg };
}

module.exports = {
  createDriverVideoProcessor,
  makeFfmpeg,
  chooseMusicPlan,
  buildFfmpegArgs,
  parseDurationFromStderr,
  musicExtFromMime,
  resolveFfmpegPath,
  resolveFfprobePath,
};
