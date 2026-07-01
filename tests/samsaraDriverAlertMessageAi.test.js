const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldUseFriendlyCaption,
  parseDriverMessageResponse,
  extractFirstName,
  extractUnitNumber,
  buildDriverAlertPrompt,
  resolveDriverCaption,
} = require('../src/driverAlertMessageAi');

test('shouldUseFriendlyCaption returns false for crash', () => {
  assert.equal(shouldUseFriendlyCaption({ isCrash: true }, 'unit'), false);
});

test('shouldUseFriendlyCaption returns false for fallback routing', () => {
  assert.equal(shouldUseFriendlyCaption({ isCrash: false }, 'fallback-unmapped'), false);
  assert.equal(shouldUseFriendlyCaption({ isCrash: false }, 'fallback-no-unit'), false);
});

test('shouldUseFriendlyCaption returns true for matched driver route', () => {
  assert.equal(shouldUseFriendlyCaption({ isCrash: false }, 'unit'), true);
});

test('parseDriverMessageResponse strips fences and rejects short output', () => {
  const html = '<b>Hey</b> there — give yourself a little extra room on the road today. Please stay careful out there!';
  const fenced = '```html\n' + html + '\n```';
  assert.equal(parseDriverMessageResponse(fenced), html);
  assert.equal(parseDriverMessageResponse('too short'), null);
  assert.equal(parseDriverMessageResponse(''), null);
});

test('extractFirstName parses driver tags and vehicle-prefixed names', () => {
  assert.equal(extractFirstName('#OMARALAWAD'), 'OMARALAWAD');
  assert.equal(extractFirstName('005 OMAR ALAWAD'), 'OMAR');
  assert.equal(extractFirstName('Unknown Driver'), null);
});

test('extractUnitNumber reads leading unit from vehicle name', () => {
  assert.equal(extractUnitNumber('005 OMAR ALAWAD'), '005');
  assert.equal(extractUnitNumber('no unit here'), null);
});

test('buildDriverAlertPrompt includes event and unit', () => {
  const prompt = buildDriverAlertPrompt({
    eventLabel: 'Following Distance',
    driverName: '005 OMAR ALAWAD',
    vehicleName: '005 OMAR ALAWAD',
  });
  assert.match(prompt, /Following Distance/);
  assert.match(prompt, /Unit number: 005/);
  assert.match(prompt, /Address the driver as OMAR/);
});

test('resolveDriverCaption returns standard text for crash without calling AI', async () => {
  const standard = '<b>🚨 CRASH 🚨</b>\n\nDriver info';
  const result = await resolveDriverCaption({ isCrash: true, eventLabel: 'Collision' }, standard);
  assert.equal(result, standard);
});
