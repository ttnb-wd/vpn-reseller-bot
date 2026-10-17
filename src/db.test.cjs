const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Client } = require("pg");
const { prepareDatabaseUrl, describeDatabaseRuntime } = require("./db");

test('external weak compatibility and private-host overrides fail; verify-full is verified', () => {
  const base = 'postgres://synthetic:fake@db.example/test';
  for (const mode of ['prefer', 'verify-ca', 'disable', 'no-verify', 'unknown']) {
    assert.throws(() => prepareDatabaseUrl(base + '?sslmode=' + mode, 'production'));
  }
  assert.throws(() => prepareDatabaseUrl(base + '?sslmode=require&uselibpqcompat=true', 'production'));
  assert.throws(() => prepareDatabaseUrl('postgres://synthetic:fake@dpg-test-a/test?host=db.example', 'production'));
  const url = prepareDatabaseUrl(base + '?sslmode=verify-full&uselibpqcompat=true', 'production');
  assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  assert.notEqual(new Client({ connectionString: url.toString() }).connectionParameters.ssl.rejectUnauthorized, false);
});

test("internal PostgreSQL also requires certificate and hostname verification", () => {
  const original = "postgres://private:password@dpg-synthetic-a:5432/synthetic_database?sslmode=require";
  const url = prepareDatabaseUrl(original, "production");
  const client = new Client({ connectionString: url.toString() });
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
  assert.equal(url.hostname, "dpg-synthetic-a");
  assert.doesNotMatch(readFileSync(path.join(__dirname, "db.js"), "utf8"),
    /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.throws(() => prepareDatabaseUrl(original.replace("require", "disable"), "production"),
    /TLS is required/);
});

test("external PostgreSQL retains certificate verification and diagnostics omit credentials", () => {
  const url = prepareDatabaseUrl(
    "postgres://private:password@dpg-synthetic-a.singapore-postgres.render.com/synthetic_database?sslmode=require",
    "production"
  );
  const client = new Client({ connectionString: url.toString() });
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
  assert.throws(() => prepareDatabaseUrl(url.toString().replace("verify-full", "no-verify"), "production"),
    /verified TLS/);
  const diagnostic = describeDatabaseRuntime(url, "prisma/contract.json",
    { storage: { storageHash: "expected-hash" } }, "8.0.0-rc.11");
  assert.equal(diagnostic.host, url.hostname);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|password|postgres:\/\//);
});
