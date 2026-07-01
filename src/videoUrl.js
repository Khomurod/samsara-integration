/**
 * videoUrl.js
 * Hostname allow-list for Samsara-authored media URLs. Centralized here so
 * the check can be unit-tested and shared between poller and downloader.
 */

const ALLOWED_VIDEO_HOSTS = new Set([
  'api.samsara.com',
  'media.samsara.com',
]);

const ALLOWED_VIDEO_HOST_SUFFIXES = [
  '.cloudfront.net',
  '.samsara.com',
];

function isTrustedSamsaraAwsHost(host) {
  // Official examples use buckets like samsara-driver-media-upload.s3.us-west-2.amazonaws.com
  if (!host.endsWith('.amazonaws.com')) return false;
  return host.includes('samsara');
}

function parseTrustedVideoUrl(videoUrl) {
  let parsed;
  try {
    parsed = new URL(videoUrl);
  } catch {
    throw new Error(`Refusing to fetch video: malformed URL "${videoUrl}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Refusing to fetch video: unsupported protocol ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    ALLOWED_VIDEO_HOSTS.has(host) ||
    ALLOWED_VIDEO_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isTrustedSamsaraAwsHost(host);
  if (!allowed) {
    throw new Error(`Refusing to fetch video: untrusted host "${host}"`);
  }
  return parsed;
}

module.exports = {
  parseTrustedVideoUrl,
  ALLOWED_VIDEO_HOSTS,
  ALLOWED_VIDEO_HOST_SUFFIXES,
};
