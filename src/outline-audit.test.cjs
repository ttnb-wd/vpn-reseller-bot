const assert = require("node:assert/strict");
const { test } = require("node:test");
const { summarizeAccessKeyAudit } = require("./outline");

test("read-only Outline audit returns only metadata and exact URL-match booleans", () => {
  const storedUrl = "ss://private-stored-key";
  const keys = [
    { id: "0", name: "Legacy", accessUrl: storedUrl, dataLimit: { bytes: 107374182400 } },
    { id: "1", name: "Other", accessUrl: "ss://different-private-key" },
  ];
  const summary = summarizeAccessKeyAudit(keys, { "0": 1024 }, ["0", "1", "2"], [storedUrl]);
  assert.deepEqual(summary, [
    { id: "0", exists: true, name: "Legacy", dataLimitBytes: 107374182400,
      usageBytes: 1024, usageReported: true, createdAt: null, storedAccessUrlMatches: true },
    { id: "1", exists: true, name: "Other", dataLimitBytes: null,
      usageBytes: null, usageReported: false, createdAt: null, storedAccessUrlMatches: false },
    { id: "2", exists: false },
  ]);
  assert.equal(JSON.stringify(summary).includes("ss://"), false);
});
