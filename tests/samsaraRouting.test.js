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


test('missing unit does not route to fallback group', async () => {
  const target = await determineTargetGroup(
    { vehicleId: 'veh_unknown', vehicleName: 'Unknown Unit', driverName: 'UNKNOWN' },
    async () => null,
    '-100999'
  );

  assert.equal(target.targetGroupId, null);
  assert.equal(target.matchReason, 'fallback-no-unit');
});

