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
  parseDurationFromStderr,
  musicExtFromMime,
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
