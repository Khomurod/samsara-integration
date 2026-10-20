/**
 * Preferring a stored vehicle link over a parsed one — and saying so.
 *
 * Safety-alert routing has always worked by pulling the first number out of a
 * free-form Samsara vehicle label and matching it against the first number in a
 * Telegram chat title. "2021 Freightliner 305" routes as unit 2021, to nobody.
 * `groups.samsara_vehicle_id` has been in the schema, indexed, the whole time
 * with nothing writing to it; bot-backend's duplicate-unit scan now does.
 *
 * The string parse is NOT removed here — a fleet whose links are half-written
 * still has to route. What changes is which one wins, and that the switchover
 * is auditable: every alert that still routes by name files an `info` finding,
 * and any alert where the two answers disagree files a `serious` one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { chooseRoutedGroup, routingSubjectId } = require('../src/routing');
const {
  recordRoutingFinding, resolveRoutingFindings, resetMissingTableWarning, UNDEFINED_TABLE, ROUTING_KEYS,
} = require('../src/routingFindings');

const STORED = { id: 7, telegram_group_id: '-700', group_name: 'WENZE UNIT # 305 JOHN DOE' };
const PARSED = { id: 9, telegram_group_id: '-900', group_name: 'WENZE 2021 UNIT # 2021 SOMEBODY', matchReason: 'unit' };

test('a stored link wins and files nothing when the parse agrees', () => {
  const agreeing = { ...STORED, matchReason: 'unit+name' };
  const choice = chooseRoutedGroup({
    stored: STORED, parsed: agreeing, vehicleId: 'veh_1', unitNumber: '305',
  });
  assert.equal(choice.group, STORED);
  assert.equal(choice.matchReason, 'vehicle_id');
  assert.equal(choice.finding, null, 'agreement is not news');
});

test('a stored link wins alone, with no finding', () => {
  const choice = chooseRoutedGroup({
    stored: STORED, parsed: null, vehicleId: 'veh_1', vehicleName: '2021 Freightliner 305',
  });
  assert.equal(choice.group, STORED);
  assert.equal(choice.matchReason, 'vehicle_id');
  assert.equal(choice.finding, null,
    'the parse failing where the link succeeded is the link doing its job');
});

test('routing by name still works, and says that it did', () => {
  const choice = chooseRoutedGroup({
    stored: null, parsed: PARSED, vehicleId: 'veh_1', vehicleName: 'UNIT # 2021', unitNumber: '2021',
  });
  assert.equal(choice.group, PARSED);
  assert.equal(choice.matchReason, 'unit');
  assert.equal(choice.finding.checkKey, 'integrations.samsara_routed_by_name');
  assert.equal(choice.finding.severity, 'info');
  assert.equal(choice.finding.subjectId, 'veh_1');
  assert.equal(choice.finding.evidence.parsedGroupId, 9);
});

test('DISAGREEMENT is serious, routes to the stored link, and keeps both answers', () => {
  const choice = chooseRoutedGroup({
    stored: STORED, parsed: PARSED, vehicleId: 'veh_1',
    vehicleName: '2021 Freightliner 305', unitNumber: '2021',
  });
  assert.equal(choice.group, STORED, 'the explicit fact wins over the inferred one');
  assert.equal(choice.finding.checkKey, 'integrations.samsara_routing_disagreement');
  assert.equal(choice.finding.severity, 'serious');
  assert.equal(choice.finding.evidence.storedGroupId, 7);
  assert.equal(choice.finding.evidence.parsedGroupId, 9,
    'the answer that lost is preserved — one of the two is misrouting a safety alert');
  assert.equal(choice.finding.evidence.routedTo, 'stored');
});

test('neither resolving is not a finding', () => {
  const choice = chooseRoutedGroup({ stored: null, parsed: null, vehicleId: 'veh_1' });
  assert.deepEqual(choice, { group: null, matchReason: null, finding: null });
});

test('a vehicle with no id is still identified in its finding', () => {
  const choice = chooseRoutedGroup({ stored: null, parsed: PARSED, unitNumber: '2021' });
  assert.equal(choice.finding.subjectId, 'unit:2021');
});

test('the finding upsert is keyed so one vehicle keeps one row', async () => {
  const queries = [];
  const pool = { query: async (text, values) => { queries.push([text, values]); return { rows: [] }; } };
  const ok = await recordRoutingFinding(pool, {
    checkKey: 'integrations.samsara_routed_by_name',
    subjectType: 'samsara_vehicle', subjectId: 'veh_1',
    title: 'routed by name', severity: 'info', evidence: { a: 1 },
  });
  assert.equal(ok, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0][0], /ON CONFLICT \(check_key, subject_type, subject_id\)/);
  assert.match(queries[0][0], /'warning'/,
    'the poller may file a finding; it may never file one that authorises a change');
  assert.deepEqual(queries[0][1].slice(1, 4), ['samsara_vehicle', 'veh_1', 'routed by name']);
});

test('a missing findings table is survivable and warns once', async () => {
  resetMissingTableWarning();
  const warnings = [];
  const err = Object.assign(new Error('relation "operational_findings" does not exist'),
    { code: UNDEFINED_TABLE });
  const pool = { query: async () => { throw err; } };
  const log = { warn: (m) => warnings.push(m), error: () => { throw new Error('not an error path'); } };

  const finding = { checkKey: 'k', subjectType: 's', subjectId: '1', title: 't', severity: 'info' };
  assert.equal(await recordRoutingFinding(pool, finding, { log }), false);
  assert.equal(await recordRoutingFinding(pool, finding, { log }), false);
  assert.equal(warnings.length, 1, 'once per process, not once per safety alert');
});

test('any other failure is swallowed too — the alert outranks the note', async () => {
  const errors = [];
  const pool = { query: async () => { throw new Error('connection terminated'); } };
  const ok = await recordRoutingFinding(
    pool,
    { checkKey: 'k', subjectType: 's', subjectId: '1', title: 't' },
    { log: { error: (...a) => errors.push(a) } }
  );
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
});

test('the legacy second router is gone', () => {
  const db = require('../src/db');
  assert.equal(typeof db.findGroupByUnit, 'undefined',
    'it had no active filter, no name check, and ORDER BY id DESC LIMIT 1 as its tiebreak');
});

// ─── a contradiction is not a missing link ───────────────────────────────────

test('TWO groups claiming one vehicle is a serious finding, not a silent fallback', () => {
  // bot-backend refuses to write a link a second group already holds, so this
  // should be unreachable — but the two services deploy independently, and this
  // poller can be running against a database whose bot-backend predates that
  // rule. Collapsing it to "no stored link" would hide a contradiction in the
  // one column meant to settle which truck a driver is in.
  const claimants = [
    { id: 7, telegram_group_id: '-700', group_name: 'WENZE UNIT # 305 JOHN DOE' },
    { id: 8, telegram_group_id: '-800', group_name: 'WENZE UNIT # 305 JANE ROE' },
  ];
  const choice = chooseRoutedGroup({
    contestedStored: claimants, parsed: PARSED, vehicleId: 'veh_1', unitNumber: '305',
  });

  assert.equal(choice.finding.checkKey, 'integrations.samsara_vehicle_link_contested');
  assert.equal(choice.finding.severity, 'serious');
  assert.deepEqual(choice.finding.evidence.claimingGroups.map((g) => g.id), [7, 8]);
  assert.equal(choice.group, PARSED,
    'and the alert still reaches a plausible driver — one that reaches nobody is worse');
  assert.equal(choice.finding.evidence.routedTo, 'parsed');
});

test('a contested vehicle with no usable parse routes to NOBODY, loudly', () => {
  const choice = chooseRoutedGroup({
    contestedStored: [{ id: 7 }, { id: 8 }], parsed: null, vehicleId: 'veh_1',
  });
  assert.equal(choice.group, null);
  assert.equal(choice.finding.severity, 'serious');
  assert.equal(choice.finding.evidence.routedTo, 'nobody');
});

test('one claimant is an ordinary stored link, not a contradiction', () => {
  const choice = chooseRoutedGroup({ stored: STORED, contestedStored: null, vehicleId: 'veh_1' });
  assert.equal(choice.group, STORED);
  assert.equal(choice.matchReason, 'vehicle_id');
  assert.equal(choice.finding, null);
});

// ─── a routed alert settles the record for its vehicle ───────────────────────

test('settling closes this poller\'s OTHER routing findings for the vehicle, never anyone else\'s', async () => {
  // 20 October 2026: four of nine "routed by name" rows described vehicles that
  // had routed by their stored link for weeks. Nothing closed them.
  const queries = [];
  const pool = { query: async (text, values) => { queries.push([text, values]); return { rowCount: 1 }; } };
  const n = await resolveRoutingFindings(pool, 'veh_1', { except: 'integrations.samsara_routing_disagreement' });
  assert.equal(n, 1);
  const [text, [keys, subject]] = queries[0];
  assert.match(text, /SET status = 'resolved'/);
  assert.match(text, /subject_type = 'samsara_vehicle'/);
  assert.match(text, /status = 'open'/, 'a dismissed row is a person\'s decision and stays dismissed');
  assert.equal(subject, 'veh_1');
  assert.deepEqual(keys, ['integrations.samsara_routed_by_name', 'integrations.samsara_vehicle_link_contested'],
    'the finding this alert just filed stays open');
  assert.ok(keys.every((k) => ROUTING_KEYS.includes(k)), 'only keys this poller files');
});

test('settling never throws — the alert outranks the note', async () => {
  const errors = [];
  const pool = { query: async () => { throw new Error('connection terminated'); } };
  assert.equal(await resolveRoutingFindings(pool, 'veh_1', { log: { error: (...a) => errors.push(a) } }), 0);
  assert.equal(errors.length, 1);
  const missing = { query: async () => { throw Object.assign(new Error('x'), { code: UNDEFINED_TABLE }); } };
  assert.equal(await resolveRoutingFindings(missing, 'veh_1', { log: { error: () => { throw new Error('no'); } } }), 0);
  assert.equal(await resolveRoutingFindings(pool, '', {}), 0, 'no vehicle, nothing to settle');
});

test('the finding\'s subject and the settle\'s subject are the same id', () => {
  assert.equal(routingSubjectId({ vehicleId: 281475006981753 }), '281475006981753');
  assert.equal(routingSubjectId({ unitNumber: '2021' }), 'unit:2021');
  const choice = chooseRoutedGroup({ stored: null, parsed: PARSED, unitNumber: '2021' });
  assert.equal(choice.finding.subjectId, routingSubjectId({ unitNumber: '2021' }));
});
