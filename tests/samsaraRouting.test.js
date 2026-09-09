const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveGroupByUnitAndName,
  determineTargetGroup,
} = require('../src/routing');

test('routes to specific group when unit is shared and name matches', async () => {
  const candidates = [
    { telegram_group_id: '-10011', group_name: '#88 JOHN DOE (COMPANY DRIVER)' },
    { telegram_group_id: '-10022', group_name: '#88 JANE SMITH (COMPANY DRIVER)' },
  ];

  const match = resolveGroupByUnitAndName(candidates, '88', ['jane smith']);
  assert.ok(match);
  assert.equal(match.telegram_group_id, '-10022');

  const target = await determineTargetGroup(
    { vehicleId: 'veh_88', vehicleName: 'Unit 88 JANE SMITH', driverName: 'JANE SMITH' },
    async () => ({
      telegramGroupId: '-10022',
      groupName: '#88 JANE SMITH (COMPANY DRIVER)',
      matchReason: 'unit+name',
    }),
    '-100999'
  );

  assert.equal(target.targetGroupId, '-10022');
  assert.equal(target.matchReason, 'unit+name');
});

test('unmapped vehicle does not route to fallback group', async () => {
  const target = await determineTargetGroup(
    { vehicleId: 'veh_unknown', vehicleName: 'Unit 77 UNKNOWN', driverName: 'UNKNOWN' },
    async () => null,
    '-100999'
  );

  assert.equal(target.targetGroupId, null);
  assert.equal(target.matchReason, 'fallback-unmapped');
});


test('a label with no unit is still resolved when a vehicle id exists', async () => {
  // It used to return before consulting the resolver at all. A stored
  // `samsara_vehicle_id` answers a label like "Unknown Unit" perfectly well, and
  // returning early meant that link was never read. What must not change is the
  // part that matters: an unresolved alert still routes to NOBODY rather than
  // to the management group, and both `matchReason` values keep the `fallback`
  // prefix its two consumers test for.
  const asked = [];
  const target = await determineTargetGroup(
    { vehicleId: 'veh_unknown', vehicleName: 'Unknown Unit', driverName: 'UNKNOWN' },
    async (...args) => { asked.push(args); return null; },
    '-100999'
  );

  assert.equal(target.targetGroupId, null);
  assert.equal(target.matchReason, 'fallback-unmapped');
  assert.equal(asked.length, 1, 'the resolver is consulted on the vehicle id alone');
  assert.equal(asked[0][3], 'veh_unknown', 'and the vehicle id reaches it');
  assert.ok(target.matchReason.startsWith('fallback'));
});

test('no unit and no vehicle id is still nothing to resolve', async () => {
  const target = await determineTargetGroup(
    { vehicleName: 'Unknown Unit', driverName: 'UNKNOWN' },
    async () => { throw new Error('the resolver must not be called'); },
    '-100999'
  );

  assert.equal(target.targetGroupId, null);
  assert.equal(target.matchReason, 'fallback-no-unit');
});

