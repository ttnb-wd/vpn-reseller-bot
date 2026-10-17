const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDynamicKeys, tokenHash } = require('../src/dynamic-config');
function fixture() {
  const row = { id: 1, vpnKeyId: 'synthetic-existing-key',
    vpnKey: 'ss://synthetic', dynamicTokenHash: null };
  let writes = 0;
  const client = { public: { Subscription: { where() { return {
    async updateAll(values) { writes++; Object.assign(row, values); return [{ ...row }]; },
    async first() { return { ...row }; },
  }; } } } };
  return { row, client, writes: () => writes };
}
test('changing public hostname preserves an existing dynamic bearer token and key mapping', async () => {
  const f = fixture(); const secret = 'synthetic-preserved-secret-material'.repeat(2);
  const old = createDynamicKeys({ client: f.client, secret, baseUrl: 'https://vpn-reseller-bot-1.onrender.com' });
  const subscription = await old.ensure(f.row);
  const oldUrl = new URL(old.accessUrl(subscription));
  const current = createDynamicKeys({ client: f.client, secret, baseUrl: 'https://metrosecure.duckdns.org' });
  const same = await current.ensure(subscription);
  const currentUrl = new URL(current.accessUrl(same));
  assert.equal(oldUrl.pathname, currentUrl.pathname);
  assert.notEqual(oldUrl.hostname, currentUrl.hostname);
  assert.equal(tokenHash(currentUrl.pathname.split('/').at(-1)), subscription.dynamicTokenHash);
  assert.equal(same.vpnKeyId, 'synthetic-existing-key'); assert.equal(f.writes(), 1);
});
test('rotating encryption secret cannot decrypt existing dynamic tokens', async () => {
  const f = fixture();
  const old = createDynamicKeys({ client: f.client, secret: 'old-synthetic-secret'.repeat(3), baseUrl: 'https://old.invalid' });
  const subscription = await old.ensure(f.row);
  const changed = createDynamicKeys({ client: f.client, secret: 'new-synthetic-secret'.repeat(3), baseUrl: 'https://metrosecure.duckdns.org' });
  assert.throws(() => changed.accessUrl(subscription), /could not be read/);
  assert.equal(f.writes(), 1);
});
