/**
 * The envelope BOTH services must agree on.
 *
 * This file is mirrored, deliberately, by
 * bot-backend/tests/sharedIntegrationCrypto.test.js — SAME fixed vector, same
 * assertions. If a change to one repository's derivation does not reach the
 * other, one of the two suites fails instead of the poller silently losing its
 * Samsara key in production.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('../src/sharedIntegrationCrypto');

// The shared fixed vector. Do not change it on one side only.
const VECTOR_URL = 'postgresql://wenze_user:s3cret-pass@dpg-internal.oregon-postgres.render.com:5432/wenze_db';
const VECTOR_FINGERPRINT = '99e9b7712a89e692';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the derived key matches the cross-repository fixed vector', () => {
  withEnv({ DATABASE_URL: VECTOR_URL, INTEGRATION_SECRET_KEY: undefined }, () => {
    assert.equal(crypto.fingerprint(), VECTOR_FINGERPRINT);
  });
});

test('the internal and external connection strings for one database derive the SAME key', () => {
  // Render hands out two URLs for the same database, differing only in host.
  // A key that changed between them would leave this service unable to read
  // what the admin panel had just written — so host and port are excluded.
  const internal = 'postgresql://wenze_user:s3cret-pass@dpg-internal:5432/wenze_db';
  const external = 'postgresql://wenze_user:s3cret-pass@dpg-abc.oregon-postgres.render.com:5432/wenze_db';

  const sealed = withEnv({ DATABASE_URL: internal, INTEGRATION_SECRET_KEY: undefined },
    () => crypto.encryptShared('samsara_api_key_value'));
  const opened = withEnv({ DATABASE_URL: external, INTEGRATION_SECRET_KEY: undefined },
    () => crypto.decryptShared(sealed));

  assert.equal(opened, 'samsara_api_key_value');
});

test('a different database is a different key, and reads back as nothing rather than garbage', () => {
  const sealed = withEnv({ DATABASE_URL: VECTOR_URL, INTEGRATION_SECRET_KEY: undefined },
    () => crypto.encryptShared('samsara_api_key_value'));
  const opened = withEnv(
    { DATABASE_URL: 'postgresql://other:other@host:5432/other_db', INTEGRATION_SECRET_KEY: undefined },
    () => crypto.safeDecryptShared(sealed),
  );
  assert.equal(opened, '', 'the caller falls back to its environment variable');
});

test('an explicit INTEGRATION_SECRET_KEY wins over the database credentials', () => {
  const sealed = withEnv({ DATABASE_URL: VECTOR_URL, INTEGRATION_SECRET_KEY: 'shared-upgrade' },
    () => crypto.encryptShared('value'));
  // Same explicit key, completely different database: still opens.
  const opened = withEnv({ DATABASE_URL: 'postgresql://x:y@z/q', INTEGRATION_SECRET_KEY: 'shared-upgrade' },
    () => crypto.decryptShared(sealed));
  assert.equal(opened, 'value');
});

test('with no secret at all, encryption refuses rather than storing something openable', () => {
  withEnv({ DATABASE_URL: undefined, INTEGRATION_SECRET_KEY: undefined }, () => {
    assert.equal(crypto.isAvailable(), false);
    assert.equal(crypto.fingerprint(), null);
    assert.throws(() => crypto.encryptShared('x'), /No shared integration secret/);
    assert.equal(crypto.safeDecryptShared('a.b.c'), '');
  });
});

test('the envelope is the repository standard: iv.tag.ciphertext, base64url', () => {
  withEnv({ DATABASE_URL: VECTOR_URL, INTEGRATION_SECRET_KEY: undefined }, () => {
    const sealed = crypto.encryptShared('hello');
    const parts = sealed.split('.');
    assert.equal(parts.length, 3);
    for (const part of parts) assert.match(part, /^[A-Za-z0-9_-]+$/);
    assert.equal(crypto.decryptShared(sealed), 'hello');
    // Tampering is detected, not silently decrypted. Deliberately the FIRST
    // character of the auth tag: base64url's last character carries only a few
    // significant bits, so changing it can decode to the same bytes and quietly
    // assert nothing.
    const first = parts[1].slice(0, 1);
    const tampered = `${first === 'A' ? 'B' : 'A'}${parts[1].slice(1)}`;
    assert.equal(crypto.safeDecryptShared(`${parts[0]}.${tampered}.${parts[2]}`), '');
  });
});
