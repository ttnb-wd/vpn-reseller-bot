const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWindowLimiter } = require("./abuse-limits");

test("per-customer windows block floods and reset without affecting another customer", () => {
  const allow = createWindowLimiter({ windowMs: 60000, max: 3 });
  assert.equal(allow("customer-1", 1000), true);
  assert.equal(allow("customer-1", 1001), true);
  assert.equal(allow("customer-1", 1002), true);
  assert.equal(allow("customer-1", 1003), false);
  assert.equal(allow("customer-2", 1003), true);
  assert.equal(allow("customer-1", 61000), true);
});
