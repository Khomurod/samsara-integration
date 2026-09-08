/**
 * The DURABLE missing-video recovery — working the queue.
 *
 * These are the guarantees that used to be impossible with an in-memory timer:
 *   · the cheap re-read runs first, and a clip Samsara already has costs NO
 *     camera retrieval;
 *   · retrieval is requested ONCE, over a genuinely non-zero interval, and its
 *     id is persisted so later checks poll THAT request rather than queueing a
 *     second one for the same seconds of video;
 *   · a recovered video replaces the original text safely — video first, delete
 *     only on success, so a failed send leaves the alert exactly where it was;
 *   · a partial fold-in retries only the destinations still missing it;
 *   · jobs come from the store, so a restart resumes them;
 *   · a job that runs out of attempts ends in a state that says why, never
 *     silently.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIG, RAW_EVENT, fakeStore, jobRow, makeWorker, stubFetch,
} = require('./helpers/recoveryFakes');

const NO_VIDEO = async () => ({ forwardUrl: null, inwardUrl: null });

test('the initial re-check finds the clip and costs no camera retrieval', async () => {
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch(() => ({ body: {} }));
  try {
    const { worker, sent, deleted } = makeWorker({
      store,
      refetch: async () => ({ forwardUrl: 'https://cdn/forward.mp4', inwardUrl: null }),
    });
    const result = await worker.tick();

    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'completed' }]);
    assert.deepEqual(
      fetchStub.requests.filter((r) => r.url.includes('/cameras/media')),
      [],
      'Samsara is never asked to produce footage it already has',
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].caption, 'Harsh braking', "each target keeps its own original text");
    assert.deepEqual(deleted, [{ chatId: '-100111', messageId: 55 }], 'the text-only alert is removed after the video lands');
    assert.deepEqual(store.calls.finish, [{ id: 1, status: 'completed', targets: [] }],
      'the delivered targets are cleared in the SAME write as the status');
  } finally { fetchStub.restore(); }
});

test('a re-check with nothing asks for footage once, over a real interval', async () => {
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch(() => ({ body: { data: { retrievalId: 'ret-77' } } }));
  try {
    const { worker } = makeWorker({ store, refetch: NO_VIDEO });
    const result = await worker.tick();

    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'pending_retrieval' }]);
    // The cheap listing is tried first — a clip the camera uploaded on its own
    // must not cost a retrieval job.
    assert.ok(
      fetchStub.requests.some((r) => r.method === 'GET' && r.url.includes('/cameras/media?')),
      'the existing media is listed before any footage is requested',
    );

    const posts = fetchStub.requests.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 1, 'exactly one retrieval request');
    const { vehicleId, startTime, endTime } = posts[0].body;
    assert.equal(vehicleId, 'veh-9');
    assert.notEqual(startTime, endTime, 'Samsara cannot produce a clip of no duration');
    const seconds = (Date.parse(endTime) - Date.parse(startTime)) / 1000;
    assert.equal(seconds, 60, '15s before + 45s after the event, as configured');

    // The id is the thing that stops the next check making another request.
    const [rescheduled] = store.calls.reschedule;
    assert.equal(rescheduled.retrievalId, 'ret-77');
    assert.equal(rescheduled.status, 'pending_retrieval');
    assert.equal(rescheduled.retrievalStartTime, startTime);
    assert.equal(rescheduled.retrievalEndTime, endTime);
  } finally { fetchStub.restore(); }
});

test('a clip the camera already uploaded costs no retrieval request at all', async () => {
  // Most speeding events resolve this way: their ids never appear in the
  // /fleet/safety-events window, but the media listing has the clip.
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch(() => ({
    body: { data: { media: [{ mediaType: 'videoHighRes', input: 'dashcamRoadFacing', urlInfo: { url: 'https://cdn/self-uploaded.mp4' } }] } },
  }));
  try {
    const { worker, sent } = makeWorker({ store, refetch: NO_VIDEO });
    const result = await worker.tick();

    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'completed' }]);
    assert.deepEqual(fetchStub.requests.filter((r) => r.method === 'POST'), []);
    assert.equal(sent.length, 1);
  } finally { fetchStub.restore(); }
});

test('a job that already owns a retrieval never makes a second one', async () => {
  const store = fakeStore([jobRow({
    status: 'pending_retrieval',
    retrieval_id: 'ret-77',
    retrieval_start_time: '2026-05-29T14:56:17.338Z',
    retrieval_end_time: '2026-05-29T14:57:17.338Z',
    attempts: 1,
  })]);
  const fetchStub = stubFetch(() => ({ body: { data: { media: [] } } }));
  try {
    const { worker } = makeWorker({ store, refetch: NO_VIDEO });
    await worker.tick();

    assert.deepEqual(
      fetchStub.requests.filter((r) => r.method === 'POST'),
      [],
      'the existing retrieval is polled, not duplicated',
    );
    assert.ok(
      fetchStub.requests.some((r) => r.url.includes('retrievalId=ret-77')),
      'and it is polled by its own id',
    );
  } finally { fetchStub.restore(); }
});

test('the retrieval produces a clip and it is folded into the waiting alerts', async () => {
  const store = fakeStore([jobRow({
    status: 'pending_retrieval',
    retrieval_id: 'ret-77',
    retrieval_start_time: '2026-05-29T14:56:17.338Z',
    retrieval_end_time: '2026-05-29T14:57:17.338Z',
    attempts: 1,
    targets: [
      { botKind: 'notification', chatId: '-100111', messageId: 55, caption: 'Harsh braking' },
      { botKind: 'driver', chatId: '-100222', messageId: 77, caption: 'Take it easy out there' },
    ],
  })]);
  const fetchStub = stubFetch(() => ({
    body: { data: { media: [{ mediaType: 'videoHighRes', input: 'dashcamRoadFacing', urlInfo: { url: 'https://cdn/ret.mp4' } }] } },
  }));
  try {
    const { worker, sent, deleted } = makeWorker({ store, refetch: NO_VIDEO });
    const result = await worker.tick();

    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'completed' }]);
    assert.deepEqual(sent.map((s) => s.caption), ['Harsh braking', 'Take it easy out there']);
    assert.equal(deleted.length, 2, 'both original text alerts are replaced');
  } finally { fetchStub.restore(); }
});

test('a failed video send leaves the original text notification intact', async () => {
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch(() => ({ body: {} }));
  try {
    const { worker, deleted } = makeWorker({
      store,
      refetch: async () => ({ forwardUrl: 'https://cdn/forward.mp4', inwardUrl: null }),
      bots: { sendVideoThrows: new Error('Telegram: file too large') },
    });
    const result = await worker.tick();

    assert.deepEqual(deleted, [], 'nothing is deleted when the video did not land');
    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'video_available' }]);
    // The destination is kept so the retry goes exactly where it is still missing.
    assert.equal(store.calls.reschedule[0].targets.length, 1);
  } finally { fetchStub.restore(); }
});

test('a partial fold-in retries only the destination that missed out', async () => {
  const store = fakeStore([jobRow({
    targets: [
      { botKind: 'notification', chatId: '-100111', messageId: 55, caption: 'A' },
      { botKind: 'driver', chatId: '-100222', messageId: 77, caption: 'B' },
    ],
  })]);
  const fetchStub = stubFetch(() => ({ body: {} }));
  try {
    let calls = 0;
    const bot = {
      sendVideo: async (chatId, buffer, opts) => {
        calls += 1;
        if (chatId === '-100222') throw new Error('bot is not in the group');
        return { message_id: 900, caption: opts.caption };
      },
      sendMediaGroup: async () => { throw new Error('single camera'); },
      deleteMessage: async () => {},
    };
    const { createVideoRecoveryWorker } = require('../src/videoRecoveryWorker');
    const worker = createVideoRecoveryWorker({
      store,
      settings: { load: async () => CONFIG },
      resolveBot: () => bot,
      makeGetVideoBuffer: () => async () => Buffer.from('bytes'),
      refetchEventUrls: async () => ({ forwardUrl: 'https://cdn/f.mp4', inwardUrl: null }),
      log: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.tick();
    assert.equal(calls, 2);
    assert.deepEqual(
      store.calls.reschedule[0].targets.map((t) => t.chatId),
      ['-100222'],
      'the group that already has the video is never targeted again',
    );
  } finally { fetchStub.restore(); }
});

test('a job that runs out of attempts ends as no_video, with a reason', async () => {
  // maxAttempts is 3 in the test config; this job has already used two.
  const store = fakeStore([jobRow({ status: 'pending_retrieval', retrieval_id: 'ret-77', attempts: 2 })]);
  const fetchStub = stubFetch(() => ({ body: { data: { media: [] } } }));
  try {
    const { worker } = makeWorker({ store, refetch: NO_VIDEO });
    const result = await worker.tick();

    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'no_video' }]);
    const [finished] = store.calls.finish;
    assert.equal(finished.status, 'no_video');
    assert.match(finished.lastError, /never produced a clip|no video/i, 'it says why, rather than vanishing');
  } finally { fetchStub.restore(); }
});

test('a finished job is never picked up again', async () => {
  const store = fakeStore([jobRow({ status: 'completed' }), jobRow({ id: 2, samsara_event_id: 'evt-2', status: 'no_video' })]);
  const fetchStub = stubFetch(() => ({ body: {} }));
  try {
    const { worker, sent } = makeWorker({
      store, refetch: async () => ({ forwardUrl: 'https://cdn/f.mp4', inwardUrl: null }),
    });
    const result = await worker.tick();
    assert.equal(result.claimed, 0);
    assert.deepEqual(sent, []);
  } finally { fetchStub.restore(); }
});

test('a job still in the future is left alone until it is due', async () => {
  const store = fakeStore([jobRow({ next_check_at: new Date(Date.now() + 60_000) })]);
  const { worker } = makeWorker({ store, refetch: NO_VIDEO });
  const result = await worker.tick();
  assert.equal(result.claimed, 0, 'the configured delay is a real wait, not a suggestion');
});

test('a restart resumes pending work, because the queue is in the database', async () => {
  // Nothing is carried in memory: a brand-new worker over the same store picks
  // up the job the previous process was waiting on.
  const store = fakeStore([jobRow({ status: 'pending_retrieval', retrieval_id: 'ret-77', attempts: 1 })]);
  const fetchStub = stubFetch(() => ({
    body: { data: { media: [{ mediaType: 'videoHighRes', input: 'dashcamRoadFacing', urlInfo: { url: 'https://cdn/late.mp4' } }] } },
  }));
  try {
    const { worker, sent } = makeWorker({ store, refetch: NO_VIDEO });
    const result = await worker.tick();
    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'completed' }]);
    assert.equal(sent.length, 1);
  } finally { fetchStub.restore(); }
});

test('a Samsara outage during recovery never throws into the caller', async () => {
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch(() => { throw new Error('ECONNRESET'); });
  try {
    const { worker } = makeWorker({
      store,
      refetch: async () => { throw new Error('Samsara 503'); },
    });
    const result = await worker.tick();
    assert.equal(result.claimed, 1);
    // The job is put back with the reason recorded — never abandoned silently.
    const [rescheduled] = store.calls.reschedule;
    assert.ok(rescheduled.lastError, 'the failure is recorded on the job');
  } finally { fetchStub.restore(); }
});

test('recovery turned off leaves every pending job untouched', async () => {
  const store = fakeStore([jobRow()]);
  const { worker } = makeWorker({
    store, refetch: NO_VIDEO, config: { ...CONFIG, videoRecoveryEnabled: false },
  });
  const result = await worker.tick();
  assert.equal(result.skipped, true);
  assert.equal(store.jobs.get(1).status, 'pending_recheck', 'they resume when it is turned back on');
});

test('the event time anchors the retrieval window, not the moment we happened to look', async () => {
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch(() => ({ body: { data: { retrievalId: 'ret-1' } } }));
  try {
    const { worker } = makeWorker({ store, refetch: NO_VIDEO });
    await worker.tick();
    const post = fetchStub.requests.find((r) => r.method === 'POST');
    assert.ok(
      Date.parse(post.body.startTime) < Date.parse(RAW_EVENT.time),
      'the window opens before the event',
    );
    assert.ok(
      Date.parse(post.body.endTime) > Date.parse(RAW_EVENT.time),
      'and closes after it',
    );
  } finally { fetchStub.restore(); }
});

// ── the three holes the Codex review found on the first pass ──

test('a retrieval Samsara never answered is not asked for again, and still ends', async () => {
  // The original bug, twice over: `startRetrieval` returns a window even when
  // the POST failed, so this branch rescheduled unconditionally — never
  // reaching the attempt budget — and, because no retrieval id was stored,
  // every later attempt issued ANOTHER POST for the same seconds of video.
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch(() => ({ ok: false, status: 500, body: 'upstream unavailable' }));
  try {
    const { worker } = makeWorker({ store, refetch: NO_VIDEO, config: { ...CONFIG, videoRecoveryMaxAttempts: 2 } });

    // Attempt 1: the ask is refused with a status, so it is safe to ask again.
    await worker.tick();
    assert.equal(store.jobs.get(1).status, 'pending_retrieval');
    assert.equal(store.jobs.get(1).retrieval_id, null);

    // Attempt 2 exhausts the budget — the job ENDS instead of looping forever.
    store.jobs.get(1).next_check_at = new Date(Date.now() - 1000);
    const result = await worker.tick();
    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'no_video' }]);
    assert.equal(store.calls.finish.at(-1).status, 'no_video');
    assert.ok(store.calls.finish.at(-1).lastError, 'and it says why');
  } finally { fetchStub.restore(); }
});

test('an ask whose outcome is unknown is never repeated', async () => {
  // A timeout or a reset: Samsara may well have accepted the request. Asking
  // again is how one event ends up with several retrievals, so the job records
  // that it asked and falls back to polling the media listing.
  const store = fakeStore([jobRow()]);
  const fetchStub = stubFetch((req) => {
    if (req.method === 'POST') throw new Error('ETIMEDOUT');  // no status: ambiguous
    return { body: { data: { media: [] } } };
  });
  try {
    const { worker } = makeWorker({ store, refetch: NO_VIDEO });

    await worker.tick();
    assert.equal(store.calls.reschedule[0].retrievalRequested, true);
    assert.ok(store.jobs.get(1).retrieval_requested_at, 'the ask is recorded even with no id');

    store.jobs.get(1).next_check_at = new Date(Date.now() - 1000);
    const before = fetchStub.requests.filter((r) => r.method === 'POST').length;
    await worker.tick();
    assert.equal(
      fetchStub.requests.filter((r) => r.method === 'POST').length,
      before,
      'no second retrieval request for the same footage',
    );
  } finally { fetchStub.restore(); }
});

test('an unreadable retrieval id still falls through to the media listing', async () => {
  // An expired or unknown retrieval answers 404. A shared try/catch made that
  // throw skip the listing entirely, so a clip already sitting in the camera's
  // media was missed on every attempt and the job ended as `no_video`.
  const store = fakeStore([jobRow({
    status: 'pending_retrieval', retrieval_id: 'ret-gone', attempts: 1,
    retrieval_start_time: '2026-05-29T14:56:17.338Z',
    retrieval_end_time: '2026-05-29T14:57:17.338Z',
  })]);
  const fetchStub = stubFetch((req) => {
    if (req.url.includes('retrievalId=')) return { ok: false, status: 404, body: 'no such retrieval' };
    return {
      body: { data: { media: [{ mediaType: 'videoHighRes', input: 'dashcamRoadFacing', urlInfo: { url: 'https://cdn/found.mp4' } }] } },
    };
  });
  try {
    const { worker, sent } = makeWorker({ store, refetch: NO_VIDEO });
    const result = await worker.tick();

    assert.deepEqual(result.outcomes, [{ eventId: 'evt-1', outcome: 'completed' }]);
    assert.equal(sent.length, 1, 'the clip the listing had is delivered, not lost');
  } finally { fetchStub.restore(); }
});

test('a terminal write that does not land never reports success, and cannot duplicate', async () => {
  // The store swallows database errors, so an unchecked `finish()` let the
  // worker claim a completed recovery while the row stayed open with all of
  // its targets — and once the claim went stale, every destination got the
  // video a second time.
  const store = fakeStore([jobRow()], { finishFails: true });
  const fetchStub = stubFetch(() => ({ body: {} }));
  const errors = [];
  try {
    const { worker, sent } = makeWorker({
      store,
      refetch: async () => ({ forwardUrl: 'https://cdn/f.mp4', inwardUrl: null }),
      logErrors: errors,
    });
    await worker.tick();

    assert.equal(sent.length, 1, 'the video did go out');
    assert.match(errors.join(' '), /recording 'completed' FAILED/, 'and the failure to record it is loud');

    // The reclaim: the row still says pending, but its targets were to be
    // cleared in the same statement — so nothing is re-sent either way.
    store.jobs.get(1).targets = [];
    store.jobs.get(1).next_check_at = new Date(Date.now() - 1000);
    const again = await worker.tick();
    assert.deepEqual(again.outcomes, [{ eventId: 'evt-1', outcome: 'completed' }]);
    assert.equal(sent.length, 1, 'no destination receives the video twice');
  } finally { fetchStub.restore(); }
});
