const { effectiveSubscriptionState } = require('./subscription-state');

async function writeEntitlementAllowance({ load, write, assertOwned = () => {}, now = Date.now }) {
  assertOwned();
  const before = await load();
  if (!before?.vpnKeyId) throw new Error('Entitlement key unavailable.');
  const keyId = before.vpnKeyId;
  const allowance = effectiveSubscriptionState(before, now()) === 'ACTIVE'
    ? Math.round(Number(before.dataLimitGb) * 1024 ** 3) : 0;
  if (!Number.isSafeInteger(allowance) || allowance < 0) throw new Error('Invalid allowance.');
  assertOwned();
  await write(keyId, allowance);
  assertOwned();
  const after = await load();
  if (!after || after.vpnKeyId !== keyId || effectiveSubscriptionState(after, now()) !== 'ACTIVE') {
    if (allowance > 0) await write(keyId, 0);
    return after;
  }
  // Customer locking prevents concurrent changes, but expiry can cross a
  // wall-clock boundary during an HTTP request. Always reconcile that boundary.
  if (Number(after.dataLimitGb) !== Number(before.dataLimitGb)) {
    throw new Error('Entitlement changed during remote write.');
  }
  return after;
}
module.exports = { writeEntitlementAllowance };
