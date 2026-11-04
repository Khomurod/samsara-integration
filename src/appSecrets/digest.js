'use strict';

/**
 * A fingerprint of the stored values THIS service reads — pure.
 *
 * Settings → Secrets (in the hub) stores every change as a new version, and
 * a value that did not change keeps its exact ciphertext. So the digest of
 * this service's rows (scopes 'both' and 'samsara') changes exactly when one
 * of its own values changed, and not when only the hub's did. The boot read
 * records it; the watch (./watch.js) compares against it.
 */
const crypto = require('crypto');

const SCOPES = Object.freeze(['both', 'samsara']);

function digestRows(rows) {
  const lines = rows
    .filter((r) => SCOPES.includes(r.scope))
    .map((r) => `${r.scope}\u0000${r.name}\u0000${r.ciphertext}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The TLS setting for a connection string — the hub's rule (lib/database/sslForUrl.js there). */
function sslForUrl(url) {
  const text = String(url || '');
  if (!text) return false;
  if (text.includes('sslmode=require') || text.includes('supabase') || text.includes('neon')) {
    return { rejectUnauthorized: false };
  }
  return false;
}

module.exports = { SCOPES, digestRows, sslForUrl };
