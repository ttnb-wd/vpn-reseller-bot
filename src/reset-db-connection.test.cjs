const { test } = require("node:test");
const assert = require("node:assert/strict");
const { databaseConnection, safeConnectionFailure } = require("./reset-db-connection");

test("reset client uses explicit decoded credentials from the supplied URL", () => {
  const secret = "p@ss:/?#value";
  const encoded = encodeURIComponent(secret);
  const { config, diagnostics } = databaseConnection(
    `postgresql://metro:${encoded}@db.example.render.com:5432/metro_prod?sslmode=require`,
    "process environment");
  assert.equal(config.host, "db.example.render.com");
  assert.equal(config.user, "metro");
  assert.equal(config.password, secret);
  assert.equal(config.database, "metro_prod");
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(diagnostics.source, "process environment");
  assert.equal(diagnostics.renderHost, true);
  assert.equal(diagnostics.sslEnabled, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /p@ss|metro:/);
});

test("invalid URLs and SSL modes fail without a fallback host", () => {
  assert.throws(() => databaseConnection("not-a-url", "local .env"));
  assert.throws(() => databaseConnection("postgres://user:pass@localhost/", "local .env"));
  assert.throws(() => databaseConnection("postgres://user:pass@localhost/db?sslmode=unknown", "local .env"));
});

test('reset tooling verifies external TLS and scopes the internal exception to the host', () => {
  assert.equal(databaseConnection('postgres://synthetic:fake@db.example/test?sslmode=verify-full', 'test')
    .config.ssl.rejectUnauthorized, true);
  assert.throws(() => databaseConnection('postgres://synthetic:fake@db.example/test?sslmode=require&uselibpqcompat=true', 'test'));
  assert.equal(databaseConnection('postgres://synthetic:fake@dpg-test-a/test?sslmode=require', 'test')
    .config.ssl.rejectUnauthorized, false);
});

test("connection failures are classified without exposing server messages", () => {
  const reason = safeConnectionFailure({ message: "password authentication failed for user private-admin secret" });
  assert.equal(reason, "password rejected");
  assert.doesNotMatch(reason, /private-admin|secret/);
});
