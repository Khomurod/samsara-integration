const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrustedVideoUrl } = require('../src/videoUrl');

test('parseTrustedVideoUrl accepts api.samsara.com URLs', () => {
  const url = parseTrustedVideoUrl('https://api.samsara.com/media/v1/foo.mp4');
  assert.equal(url.hostname, 'api.samsara.com');
});

test('parseTrustedVideoUrl accepts CloudFront pre-signed URLs', () => {
  const url = parseTrustedVideoUrl(
    'https://d123.cloudfront.net/foo.mp4?Signature=abc&Key-Pair-Id=xyz'
  );
  assert.equal(url.hostname, 'd123.cloudfront.net');
});

test('parseTrustedVideoUrl rejects URLs that merely embed api.samsara.com in the query', () => {
  assert.throws(
    () => parseTrustedVideoUrl('https://evil.example.com/?x=api.samsara.com'),
    /untrusted host/i
  );
});

test('parseTrustedVideoUrl rejects non-http schemes', () => {
  assert.throws(() => parseTrustedVideoUrl('file:///etc/passwd'), /unsupported protocol/i);
  assert.throws(() => parseTrustedVideoUrl('javascript:alert(1)'), /unsupported protocol/i);
});

test('parseTrustedVideoUrl rejects malformed URLs', () => {
  assert.throws(() => parseTrustedVideoUrl('not a url'), /malformed URL/i);
});

test('parseTrustedVideoUrl is case-insensitive on hostname', () => {
  const url = parseTrustedVideoUrl('https://API.Samsara.com/media/x.mp4');
  assert.equal(url.hostname.toLowerCase(), 'api.samsara.com');
});

test('parseTrustedVideoUrl accepts Samsara driver-media S3 URLs', () => {
  const url = parseTrustedVideoUrl(
    'https://samsara-driver-media-upload.s3.us-west-2.amazonaws.com/org/key.mp4'
  );
  assert.match(url.hostname, /amazonaws\.com$/);
});
