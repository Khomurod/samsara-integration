'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createDriverVideoProcessor,
  chooseMusicPlan,
  buildFfmpegArgs,
  computeCompressionPlan,
  buildCompressionArgs,
  parseDurationFromStderr,
  musicExtFromMime,
  makeFfmpeg: realMakeFfmpeg,
  resolveTelegramTargetBytes,
  runOverlaySelfTest,
  TELEGRAM_HARD_LIMIT_BYTES,
} = require('../src/safetyEventVideoMusicService');

// ── Pure helpers ────────────────────────────────────────────────────────────

test('chooseMusicPlan trims when music is longer than the video', () => {
  const p = chooseMusicPlan({ videoDurationSeconds: 10, musicDurationSeconds: 171, loopWhenLonger: true });
  assert.equal(p.mode, 'trim');
  assert.equal(p.loopMusic, false);
});

test('chooseMusicPlan loops when video is longer and looping enabled', () => {
  const p = chooseMusicPlan({ videoDurationSeconds: 60, musicDurationSeconds: 10, loopWhenLonger: true });
  assert.equal(p.mode, 'loop');
  assert.equal(p.loopMusic, true);
});

test('chooseMusicPlan plays once (silent tail) when video is longer and looping disabled', () => {
  const p = chooseMusicPlan({ videoDurationSeconds: 60, musicDurationSeconds: 10, loopWhenLonger: false });
  assert.equal(p.mode, 'once');
  assert.equal(p.loopMusic, false);
});

test('chooseMusicPlan defaults to trim when durations unknown', () => {
  const p = chooseMusicPlan({ videoDurationSeconds: 0, musicDurationSeconds: 0, loopWhenLonger: true });
  assert.equal(p.mode, 'trim');
});

test('buildFfmpegArgs (replace audio) maps video + music, applies volume/fade, bounds to video length', () => {
  const args = buildFfmpegArgs({
    videoPath: 'in.mp4', musicPath: 'm.m4a', outPath: 'out.mp4',
    videoDurationSeconds: 12, hasOriginalAudio: false,
    settings: { musicVolume: 0.4, fadeInSeconds: 0, fadeOutSeconds: 2, preserveOriginalAudio: true },
    plan: { mode: 'trim', loopMusic: false },
  });
  const s = args.join(' ');
  assert.match(s, /-map 0:v:0/);
  assert.match(s, /-map 1:a:0/);
  assert.match(s, /-af volume=0\.4,afade=t=out:st=10:d=2/);
  assert.match(s, /-c:v copy/);
  assert.match(s, /-c:a aac/);
  assert.match(s, /-t 12/);
  assert.doesNotMatch(s, /-stream_loop/);
});

test('buildFfmpegArgs (mix) uses amix duration=first when preserving original audio', () => {
  const args = buildFfmpegArgs({
    videoPath: 'in.mp4', musicPath: 'm.m4a', outPath: 'out.mp4',
    videoDurationSeconds: 8, hasOriginalAudio: true,
    settings: { musicVolume: 0.3, fadeInSeconds: 1, fadeOutSeconds: 1, preserveOriginalAudio: true },
    plan: { mode: 'trim', loopMusic: false },
  });
  const s = args.join(' ');
  assert.match(s, /-filter_complex/);
  assert.match(s, /amix=inputs=2:duration=first/);
  assert.match(s, /\[1:a\]volume=0\.3,afade=t=in:st=0:d=1/);
  assert.match(s, /-map \[aout\]/);
});

test('buildFfmpegArgs adds -stream_loop before the music input when looping', () => {
  const args = buildFfmpegArgs({
    videoPath: 'in.mp4', musicPath: 'm.m4a', outPath: 'out.mp4',
    videoDurationSeconds: 30, hasOriginalAudio: false,
    settings: { musicVolume: 1, fadeInSeconds: 0, fadeOutSeconds: 0, preserveOriginalAudio: false },
    plan: { mode: 'loop', loopMusic: true },
  });
  const streamLoopIdx = args.indexOf('-stream_loop');
  const musicIdx = args.lastIndexOf('m.m4a');
  const videoIdx = args.indexOf('in.mp4');
  assert.ok(streamLoopIdx > videoIdx, '-stream_loop comes after the video input');
  assert.ok(streamLoopIdx < musicIdx, '-stream_loop comes before the music input');
});

test('buildFfmpegArgs (mix) still forces original audio replacement when no original audio present', () => {
  const args = buildFfmpegArgs({
    videoPath: 'in.mp4', musicPath: 'm.m4a', outPath: 'out.mp4',
    videoDurationSeconds: 5, hasOriginalAudio: false,
    settings: { musicVolume: 0.5, fadeInSeconds: 0, fadeOutSeconds: 0, preserveOriginalAudio: true },
    plan: { mode: 'trim', loopMusic: false },
  });
  const s = args.join(' ');
  assert.doesNotMatch(s, /amix/); // no original audio => cannot mix; replace instead
  assert.match(s, /-map 1:a:0/);
});

test('parseDurationFromStderr reads an ffmpeg Duration line', () => {
  assert.equal(parseDurationFromStderr('  Duration: 00:00:12.34, start: 0'), 12.34);
  assert.equal(parseDurationFromStderr('no duration here'), null);
});

test('musicExtFromMime maps common audio types', () => {
  assert.equal(musicExtFromMime('audio/mpeg'), 'mp3');
  assert.equal(musicExtFromMime('audio/wav'), 'wav');
  assert.equal(musicExtFromMime('audio/aac'), 'aac');
  assert.equal(musicExtFromMime('audio/mp4'), 'm4a');
});

// ── Processor: gating + fallback + cleanup ──────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    speedingMusicEnabled: true,
    musicVolume: 0.35,
    preserveOriginalAudio: true,
    fadeInSeconds: 0,
    fadeOutSeconds: 1.5,
    loopMusicWhenVideoLonger: true,
    maxVideoSeconds: 120,
    music: { id: 7, mimeType: 'audio/mp4', durationSeconds: 171, data: Buffer.from('MUSICBYTES') },
    ...overrides,
  };
}

function makeStore(config) {
  const events = [];
  return {
    events,
    loadConfig: async () => config,
    recordJobStart: async () => { events.push('start'); return 42; },
    finishJob: async (_id, info) => { events.push(`finish:${info.status}`); },
  };
}

function makeFfmpeg({ available = true, probe = { durationSeconds: 10, hasAudio: true }, fail = false } = {}) {
  const calls = { run: 0, probe: 0 };
  return {
    calls,
    isAvailable: async () => available,
    probe: async () => { calls.probe += 1; return probe; },
    run: async (args) => {
      calls.run += 1;
      if (fail) throw new Error('ffmpeg boom');
      const outPath = args[args.length - 1];
      fs.writeFileSync(outPath, Buffer.from('PROCESSED-VIDEO-BYTES'));
    },
  };
}

function tempDirCount() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('se-music-')).length;
}

const ORIGINAL = Buffer.from('ORIGINAL-VIDEO-BYTES');

test('processor returns ORIGINAL for non-speeding events (never calls ffmpeg)', async () => {
  const ff = makeFfmpeg();
  const proc = createDriverVideoProcessor({ store: makeStore(makeConfig()), ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: false, role: 'single' });
  assert.equal(out, ORIGINAL);
  assert.equal(ff.calls.run, 0);
});

test('processor skips the inward camera (avoids double music)', async () => {
  const ff = makeFfmpeg();
  const proc = createDriverVideoProcessor({ store: makeStore(makeConfig()), ffmpeg: ff });
  const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'inward' });
  assert.equal(out, ORIGINAL);
  assert.equal(ff.calls.run, 0);
});

test('processor returns ORIGINAL when the feature is disabled', async () => {
  const ff = makeFfmpeg();
  const proc = createDriverVideoProcessor({ store: makeStore(makeConfig({ enabled: false, music: null })), ffmpeg: ff });
  const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single' });
  assert.equal(out, ORIGINAL);
  assert.equal(ff.calls.run, 0);
});

test('processor returns ORIGINAL when ffmpeg is unavailable', async () => {
  const ff = makeFfmpeg({ available: false });
  const proc = createDriverVideoProcessor({ store: makeStore(makeConfig()), ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single' });
  assert.equal(out, ORIGINAL);
  assert.equal(ff.calls.run, 0);
});

test('processor overlays music on a speeding driver video (happy path) and cleans up temp files', async () => {
  const before = tempDirCount();
  const ff = makeFfmpeg({ probe: { durationSeconds: 10, hasAudio: true } });
  const store = makeStore(makeConfig());
  const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'evt1', groupId: '-100' });
  assert.equal(out.toString(), 'PROCESSED-VIDEO-BYTES');
  assert.equal(ff.calls.run, 1);
  assert.deepEqual(store.events, ['start', 'finish:sent']);
  assert.equal(tempDirCount(), before, 'temp dir cleaned up');
});

test('processor falls back to ORIGINAL when ffmpeg encode fails, and records fallback', async () => {
  const before = tempDirCount();
  const ff = makeFfmpeg({ fail: true });
  const store = makeStore(makeConfig());
  const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'evt2' });
  assert.equal(out, ORIGINAL);
  assert.deepEqual(store.events, ['start', 'finish:fallback_sent']);
  assert.equal(tempDirCount(), before, 'temp dir cleaned up even on failure');
});

test('processor falls back to ORIGINAL when the video exceeds the max-length cap', async () => {
  const ff = makeFfmpeg({ probe: { durationSeconds: 999, hasAudio: true } });
  const store = makeStore(makeConfig({ maxVideoSeconds: 120 }));
  const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'evt3' });
  assert.equal(out, ORIGINAL);
  assert.equal(ff.calls.run, 0, 'never encodes an over-cap video');
  assert.deepEqual(store.events, ['start', 'finish:fallback_sent']);
});

test('processor replaces audio (no amix) when the video has no original audio', async () => {
  let capturedArgs = null;
  const ff = makeFfmpeg({ probe: { durationSeconds: 10, hasAudio: false } });
  ff.run = async (args) => { capturedArgs = args; fs.writeFileSync(args[args.length - 1], Buffer.from('X')); };
  const proc = createDriverVideoProcessor({ store: makeStore(makeConfig({ preserveOriginalAudio: true })), ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single' });
  const s = capturedArgs.join(' ');
  assert.doesNotMatch(s, /amix/);
  assert.match(s, /-map 1:a:0/);
});

// ── End-to-end overlay self-test with a REAL ffmpeg (skips if unavailable) ───
// Proves the overlay pipeline actually runs against a real binary when one is
// present (e.g. @ffmpeg-installer/ffmpeg installed, or FFMPEG_PATH set). When no
// ffmpeg is available it reports ffmpegAvailable:false and the test SKIPS with a
// clear message rather than failing — so CI without ffmpeg stays green.
test('runOverlaySelfTest overlays synthetic media end-to-end when ffmpeg is available', async (t) => {
  const ff = realMakeFfmpeg();
  if (!(await ff.isAvailable())) {
    t.skip('ffmpeg not available in this environment — install @ffmpeg-installer/ffmpeg or set FFMPEG_PATH to exercise this');
    return;
  }
  const result = await runOverlaySelfTest({ ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.ffmpegAvailable, true);
  assert.equal(result.ok, true, `overlay self-test should succeed: ${result.reason || ''}`);
  assert.ok(result.outputBytes > 0, 'overlay produced a non-empty output video');
});

test('runOverlaySelfTest reports ffmpegAvailable:false (no throw) when ffmpeg is missing', async () => {
  // Force an unavailable binary via a bogus FFMPEG_PATH-based facade.
  const ff = realMakeFfmpeg({ ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: '/nonexistent/ffprobe', log: { warn() {} } });
  const result = await runOverlaySelfTest({ ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.ffmpegAvailable, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ffmpeg-unavailable');
});

// ── Telegram-size compression ────────────────────────────────────────────────
// The overlay copies the video stream, so an already-big dashcam clip can push
// the output past Telegram's 50 MB bot-upload limit. These tests cover the
// automatic compression passes and every fallback branch.

/** Fake ffmpeg whose Nth run writes sizes[N] bytes to the output ('throw' → error). */
function makeSizedFfmpeg(sizes, probe = { durationSeconds: 10, hasAudio: true }) {
  const calls = { run: 0, probe: 0, invocations: [] };
  return {
    calls,
    isAvailable: async () => true,
    probe: async () => { calls.probe += 1; return probe; },
    run: async (args, opts) => {
      const spec = sizes[Math.min(calls.run, sizes.length - 1)];
      calls.run += 1;
      calls.invocations.push({ args, opts });
      if (spec === 'throw') throw new Error('compress boom');
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(spec, 0x41));
    },
  };
}

/** Run fn with SAFETY_MUSIC_TELEGRAM_MAX_MB set (tiny targets keep tests fast). */
async function withTargetMb(mb, fn) {
  const prev = process.env.SAFETY_MUSIC_TELEGRAM_MAX_MB;
  process.env.SAFETY_MUSIC_TELEGRAM_MAX_MB = String(mb);
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SAFETY_MUSIC_TELEGRAM_MAX_MB;
    else process.env.SAFETY_MUSIC_TELEGRAM_MAX_MB = prev;
  }
}

test('resolveTelegramTargetBytes defaults to 49MB and honours the env override (capped below 50)', async () => {
  assert.equal(resolveTelegramTargetBytes({}), Math.floor(49 * 1024 * 1024));
  assert.equal(resolveTelegramTargetBytes({ SAFETY_MUSIC_TELEGRAM_MAX_MB: '10' }), 10 * 1024 * 1024);
  assert.ok(resolveTelegramTargetBytes({ SAFETY_MUSIC_TELEGRAM_MAX_MB: '80' }) < TELEGRAM_HARD_LIMIT_BYTES);
  assert.equal(resolveTelegramTargetBytes({ SAFETY_MUSIC_TELEGRAM_MAX_MB: 'junk' }), Math.floor(49 * 1024 * 1024));
});

test('computeCompressionPlan: pass 1 targets 720p/128k audio, pass 2 is more aggressive', () => {
  const target = 49 * 1024 * 1024;
  const p1 = computeCompressionPlan({ durationSeconds: 60, targetBytes: target, pass: 1 });
  const p2 = computeCompressionPlan({ durationSeconds: 60, targetBytes: target, pass: 2 });
  assert.equal(p1.maxHeight, 720);
  assert.equal(p1.audioKbps, 128);
  assert.equal(p2.maxHeight, 480);
  assert.equal(p2.audioKbps, 96);
  assert.ok(p2.videoKbps < p1.videoKbps, 'pass 2 uses a lower bitrate');
  // Longer video → lower bitrate for the same target size.
  const longer = computeCompressionPlan({ durationSeconds: 120, targetBytes: target, pass: 1 });
  assert.ok(longer.videoKbps < p1.videoKbps);
  // Bitrate never collapses below the floor.
  const tiny = computeCompressionPlan({ durationSeconds: 3600, targetBytes: 1024, pass: 2 });
  assert.equal(tiny.videoKbps, 250);
});

test('buildCompressionArgs re-encodes with libx264, keeps AAC audio, bounds duration, downscales only', () => {
  const plan = computeCompressionPlan({ durationSeconds: 59, targetBytes: 49 * 1024 * 1024, pass: 1 });
  const args = buildCompressionArgs({ inPath: 'in.mp4', outPath: 'out.mp4', plan, durationSeconds: 59 });
  const s = args.join(' ');
  assert.match(s, /-c:v libx264/);
  assert.match(s, /-c:a aac/);
  assert.match(s, /-b:a 128k/);
  assert.match(s, new RegExp(`-b:v ${plan.videoKbps}k`));
  assert.match(s, /scale=-2:min\(720\\,ih\)/);
  assert.match(s, /-t 59/);
  assert.match(s, /-movflags \+faststart/);
  assert.equal(args[args.length - 1], 'out.mp4');
});

test('overlay below the limit is returned as-is (no compression pass, status sent)', async () => {
  await withTargetMb(0.001, async () => { // target = 1048 bytes
    const before = tempDirCount();
    const ff = makeSizedFfmpeg([500]); // overlay output below target
    const store = makeStore(makeConfig());
    const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
    const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'c1' });
    assert.equal(out.length, 500);
    assert.equal(ff.calls.run, 1, 'only the overlay ran');
    assert.deepEqual(store.events, ['start', 'finish:sent']);
    assert.equal(tempDirCount(), before);
  });
});

test('oversized overlay is compressed (pass 1) and recorded as compressed_sent', async () => {
  await withTargetMb(0.001, async () => {
    const before = tempDirCount();
    const ff = makeSizedFfmpeg([5000, 500]); // overlay 5000B > 1048B target; pass1 → 500B
    const store = makeStore(makeConfig());
    const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
    const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'c2' });
    assert.equal(out.length, 500, 'returned buffer is the compressed one');
    assert.equal(ff.calls.run, 2, 'overlay + one compression pass');
    assert.deepEqual(store.events, ['start', 'finish:compressed_sent']);
    const compression = ff.calls.invocations[1];
    assert.match(compression.args.join(' '), /-c:v libx264/, 'compression re-encodes video');
    assert.ok(compression.opts?.timeoutMs >= 90000, 'compression uses the longer timeout');
    assert.equal(tempDirCount(), before, 'temp dir cleaned up');
  });
});

test('pass 2 runs when pass 1 is still oversized, and may land under the hard limit', async () => {
  await withTargetMb(0.001, async () => {
    const ff = makeSizedFfmpeg([5000, 2000, 900]); // p1 2000B > target; p2 900B ≤ target
    const store = makeStore(makeConfig());
    const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
    const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'c3' });
    assert.equal(out.length, 900);
    assert.equal(ff.calls.run, 3, 'overlay + two compression passes');
    assert.deepEqual(store.events, ['start', 'finish:compressed_sent']);
  });
});

test('pass 2 output between target and the 50MB hard limit is still accepted', async () => {
  await withTargetMb(0.001, async () => {
    const ff = makeSizedFfmpeg([5000, 3000, 2000]); // both passes above the 1048B target…
    const store = makeStore(makeConfig());
    const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
    const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'c4' });
    // …but pass 2's 2000B is far below the hard 50MB limit → accepted.
    assert.equal(out.length, 2000);
    assert.deepEqual(store.events, ['start', 'finish:compressed_sent']);
  });
});

test('compression failure falls back to the ORIGINAL (sendable) buffer without throwing', async () => {
  await withTargetMb(0.001, async () => {
    const before = tempDirCount();
    const ff = makeSizedFfmpeg([5000, 'throw', 'throw']);
    const store = makeStore(makeConfig());
    const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
    const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'single', eventId: 'c5' });
    assert.equal(out, ORIGINAL, 'original returned when compression fails');
    assert.deepEqual(store.events, ['start', 'finish:fallback_sent']);
    assert.equal(tempDirCount(), before, 'temp dir cleaned up on compression failure');
  });
});

test('records failed_too_large when even the original exceeds the 50MB hard limit', async () => {
  await withTargetMb(0.001, async () => {
    const before = tempDirCount();
    const huge = Buffer.alloc(TELEGRAM_HARD_LIMIT_BYTES + 1, 0x42);
    const ff = makeSizedFfmpeg([5000, 'throw', 'throw']);
    const store = makeStore(makeConfig({ maxVideoSeconds: 0 })); // disable duration cap
    const proc = createDriverVideoProcessor({ store, ffmpeg: ff, log: { log() {}, warn() {}, error() {} } });
    const out = await proc.prepareDriverVideoBuffer(huge, { isSpeeding: true, role: 'single', eventId: 'c6' });
    assert.equal(out, huge, 'buffer still returned so the delivery layer owns the fallback');
    assert.deepEqual(store.events, ['start', 'finish:failed_too_large']);
    assert.equal(tempDirCount(), before, 'temp dir cleaned up');
  });
});

test('inward camera is never compressed either (still skips music entirely)', async () => {
  await withTargetMb(0.001, async () => {
    const ff = makeSizedFfmpeg([5000, 500]);
    const proc = createDriverVideoProcessor({ store: makeStore(makeConfig()), ffmpeg: ff });
    const out = await proc.prepareDriverVideoBuffer(ORIGINAL, { isSpeeding: true, role: 'inward' });
    assert.equal(out, ORIGINAL);
    assert.equal(ff.calls.run, 0);
  });
});
