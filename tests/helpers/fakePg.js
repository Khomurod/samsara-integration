/**
 * A stand-in for the `pg` module, so the REAL src/db.js can be loaded, build
 * its one pool, and be exercised with no database anywhere.
 *
 * `require.cache` rather than a DI seam because db.js builds its pool when it
 * loads, which is exactly the wiring under test. `pg` stays replaced until
 * `restore()`, so ANY pool built in the meantime — including one a module
 * should no longer be building — is a fake that is counted, and can never
 * reach a network.
 */
'use strict';

const EventEmitter = require('node:events');

const PG_PATH = require.resolve('pg');
const DB_PATH = require.resolve('../../src/db');

/** `.invalid` never resolves (RFC 2606), and `pg` is replaced regardless. */
const FAKE_DATABASE_URL = 'postgres://fake:fake@db.invalid:5432/fake';

/**
 * Load a FRESH src/db.js against a fake `pg`.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]  variables to set until restore(); undefined deletes one
 * @param {(sql: string, params: any[]) => object} [opts.answer]  a query's result, or throw
 * @returns {{ db: object, pools: object[], queries: object[], restore: () => void }}
 *   `pools` is every Pool constructed while loaded — the point being exactly one —
 *   and `queries` every statement sent to any of them, in order.
 */
function loadDbWithFakePg({ env = {}, answer = () => ({ rows: [] }) } = {}) {
  const pools = [];
  const queries = [];

  class FakePool extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      pools.push(this);
    }

    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return answer(String(sql), params);
    }
  }

  const savedModules = new Map([PG_PATH, DB_PATH].map((id) => [id, require.cache[id]]));
  const savedEnv = {};
  const vars = {
    DATABASE_URL: FAKE_DATABASE_URL, PG_POOL_MAX: undefined, PG_IDLE_TIMEOUT_MS: undefined, ...env,
  };
  for (const [name, value] of Object.entries(vars)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  require.cache[PG_PATH] = {
    id: PG_PATH, filename: PG_PATH, loaded: true, exports: { Pool: FakePool },
  };
  delete require.cache[DB_PATH];
  // eslint-disable-next-line global-require
  const db = require(DB_PATH);

  function restore() {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [id, entry] of savedModules) {
      if (entry) require.cache[id] = entry;
      else delete require.cache[id];
    }
  }

  return { db, pools, queries, restore };
}

module.exports = { loadDbWithFakePg, FAKE_DATABASE_URL };
