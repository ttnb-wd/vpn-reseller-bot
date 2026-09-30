const assert = require("node:assert/strict");
const { test } = require("node:test");
const { effectiveSubscriptionState } = require("./subscription-state");

const now = Date.parse("2026-09-30T00:00:00Z");
const active = { status: "ACTIVE", dataUsedGb: 20, dataLimitGb: 100,
  expiresAt: "2026-10-30T00:00:00Z", revokedAt: null };

test("subscription state uses the purchased limit and preserves priority", () => {
  for (const limit of [100, 200, 400, 737]) {
    assert.equal(effectiveSubscriptionState({ ...active, dataLimitGb: limit,
      dataUsedGb: limit - 1 }, now), "ACTIVE");
    assert.equal(effectiveSubscriptionState({ ...active, dataLimitGb: limit,
      dataUsedGb: limit }, now), "DATA_LIMIT_REACHED");
    assert.equal(effectiveSubscriptionState({ ...active, dataLimitGb: limit,
      dataUsedGb: limit + 1 }, now), "DATA_LIMIT_REACHED");
  }
  assert.equal(effectiveSubscriptionState({ ...active, dataUsedGb: 100,
    expiresAt: "2026-09-29T00:00:00Z" }, now), "EXPIRED");
  assert.equal(effectiveSubscriptionState({ ...active, dataUsedGb: 100,
    revokedAt: "2026-09-28T00:00:00Z" }, now), "REVOKED");
});
