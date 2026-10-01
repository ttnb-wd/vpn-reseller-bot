const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeEntitlementAllowance } = require('./entitlement-write');
for (const mutation of ['EXPIRED', 'DATA_LIMIT_REACHED', 'revoked']) {
  test(`in-flight positive write is reconciled when latest state becomes ${mutation}`, async () => {
    const row = { vpnKeyId: 'synthetic', status: 'ACTIVE', dataUsedGb: 0, dataLimitGb: 10,
      expiresAt: new Date(Date.now() + 60000) };
    const calls = [];
    await writeEntitlementAllowance({ load: async () => ({ ...row }), async write(_key, bytes) {
      calls.push(bytes);
      if (bytes > 0) {
        if (mutation === 'revoked') row.revokedAt = new Date();
        else row.status = mutation;
      }
    } });
    assert.deepEqual(calls, [10 * 1024 ** 3, 0]);
  });
}
test('expiry passing during remote write is blocked before finalizing', async () => {
  let clock = 1000;
  const row = { vpnKeyId: 'synthetic', status: 'ACTIVE', dataUsedGb: 0, dataLimitGb: 1,
    expiresAt: new Date(1001) };
  const calls = [];
  await writeEntitlementAllowance({ now: () => clock, load: async () => row,
    async write(_key, bytes) { calls.push(bytes); clock = 1002; } });
  assert.deepEqual(calls, [1024 ** 3, 0]);
});
