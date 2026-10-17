'use strict';
// Combined with Docker --network=none and a clean environment in CI.
require('../deploy/synthetic-local-preload.cjs');
const assert = require('node:assert/strict');
assert.equal(process.env.DATABASE_URL, undefined, 'Production DB configuration is forbidden in tests');
assert.equal(process.env.NOTIFICATION_TEST_DATABASE_URL, undefined, 'This job is unit-only');
for (const name of ['net', 'tls']) {
  const api = require(name);
  for (const method of ['connect', 'createConnection']) {
    const original = api[method];
    if (!original) continue;
    api[method] = function (...args) {
      const first = args[0];
      const host = typeof first === 'object' ? first.host || first.hostname || 'localhost' :
        typeof args[1] === 'string' ? args[1] : 'localhost';
      assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host), 'External test socket refused');
      return original.apply(this, args);
    };
  }
}
