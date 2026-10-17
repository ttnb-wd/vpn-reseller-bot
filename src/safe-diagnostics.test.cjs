const assert = require("node:assert/strict");
const { test } = require("node:test");
const { describeHandlerFailure } = require("./safe-diagnostics");

test("marker-read diagnostics expose safe driver cause without credentials", () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://dbuser:dbpassword@db.example/private";
  try {
    const error = Object.assign(new Error("Database error while reading contract marker"), {
      code: "CONTRACT.MARKER_READ_FAILED",
      cause: Object.assign(new Error("connect ECONNREFUSED postgres://dbuser:dbpassword@db.example/private"), {
        code: "ECONNREFUSED",
      }),
    });
    const diagnostic = describeHandlerFailure("buy_vpn", error);
    assert.equal(diagnostic.code, "CONTRACT.MARKER_READ_FAILED");
    assert.equal(diagnostic.cause.code, "ECONNREFUSED");
    assert.doesNotMatch(JSON.stringify(diagnostic), /dbpassword|dbuser|postgres:\/\//);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
