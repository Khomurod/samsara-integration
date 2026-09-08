'use strict';

/**
 * The one secret envelope BOTH services can open.
 *
 * The admin/hub (`bot-backend`) writes the Samsara API key into
 * `samsara_settings` so an operator can replace it without redeploying THIS
 * service. Its own standard secret storage (`lib/security/facebookCrypto.js`)
 * uses FACEBOOK_TOKEN_ENCRYPTION_KEY / JWT_SECRET, neither of which this
 * service has — and giving it either would be exactly the "add a new Render
 * environment variable" the operator asked to avoid, besides putting the hub's
 * session-signing secret on a second service.
 *
 * So the envelope is identical — AES-256-GCM, `iv.tag.ciphertext` base64url —
 * and only the KEY MATERIAL differs. It is, in order:
 *
 *   1. INTEGRATION_SECRET_KEY, when both services are given the same value.
 *      Nothing requires it; setting it is a strict upgrade and is what a
 *      deployment should do if it ever wants this decoupled from the database
 *      credentials.
 *   2. The DATABASE_URL's CREDENTIALS — user, password and database name, with
 *      the host and port deliberately EXCLUDED. Render hands out an internal
 *      and an external connection string for the same database; they differ
 *      only in host, and a key that changed between them would leave the poller
 *      unable to read what the admin panel just wrote. What is left is a secret
 *      both services already have, that is specific to this pair of services,
 *      and that a database dump alone does not contain.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT. It protects a stolen table, a backup, a
 * log of a query result — the realistic exposures for a value sitting in a
 * shared Postgres. It does not protect against someone who already holds the
 * connection string. That is a real limit, it is why option 1 exists, and it is
 * still strictly better than the plaintext column the alternative would be.
 *
 * `fingerprint()` is stored alongside a ciphertext so a reader can tell "this
 * was written under different key material" apart from "this is corrupt", and
 * fall back to its environment variable rather than losing the integration.
 * It is a hash of the derived key, never the key or the plaintext.
 *
 * Mirrored, deliberately and with the same comments, from
 * bot-backend/lib/security/sharedIntegrationCrypto.js. The two must agree
 * byte-for-byte on derivation; there is a test on each side pinning the
 * envelope against the same fixed vector, so a change to one that the other
 * did not get fails a build rather than silently costing the poller its key.
 */
const crypto = require('crypto');

/**
 * The shared secret, as a string. Empty when nothing usable is configured —
 * callers must treat that as "cannot encrypt/decrypt here".
 */
function secretMaterial(env = process.env) {
  const explicit = String(env.INTEGRATION_SECRET_KEY || '').trim();
  if (explicit) return `explicit:${explicit}`;

  const url = String(env.DATABASE_URL || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // Host and port are excluded ON PURPOSE — see the header.
    const user = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    const database = decodeURIComponent(String(parsed.pathname || '').replace(/^\//, ''));
    if (!user && !password && !database) return '';
    return `pg:${user}:${password}:${database}`;
  } catch {
    return '';
  }
}

function getKey(env = process.env) {
  const material = secretMaterial(env);
  if (!material) return null;
  return crypto.createHash('sha256').update(material).digest();
}

/** Whether this process can read/write shared-envelope secrets at all. */
function isAvailable(env = process.env) {
  return Boolean(getKey(env));
}

/**
 * A short, non-reversible marker for the key in use. Stored next to a
 * ciphertext so a reader can recognise a value it was never going to open.
 */
function fingerprint(env = process.env) {
  const key = getKey(env);
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function encryptShared(plainText, env = process.env) {
  const key = getKey(env);
  if (!key) throw new Error('No shared integration secret is available (set INTEGRATION_SECRET_KEY or DATABASE_URL).');
  const value = String(plainText || '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptShared(payload, env = process.env) {
  if (!payload) return '';
  const key = getKey(env);
  if (!key) throw new Error('No shared integration secret is available.');
  const [ivPart, tagPart, encryptedPart] = String(payload).split('.');
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error('Encrypted payload is malformed');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * Decrypt without throwing. Returns '' when the value cannot be opened —
 * different key material, corruption, or no secret at all — because every
 * caller's answer to that is the same: fall back to the environment variable.
 */
function safeDecryptShared(payload, env = process.env) {
  if (!payload) return '';
  try {
    return decryptShared(payload, env);
  } catch {
    return '';
  }
}

module.exports = {
  secretMaterial,
  isAvailable,
  fingerprint,
  encryptShared,
  decryptShared,
  safeDecryptShared,
};
