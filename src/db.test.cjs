const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Client } = require("pg");
const { prepareDatabaseUrl, describeDatabaseRuntime } = require("./db");

test("Render internal PostgreSQL requires TLS and accepts only its self-signed certificate", () => {
  const original = "postgres://private:password@dpg-daqknpugekts7391clg0-a:5432/vpn_799m?sslmode=require";
  const url = prepareDatabaseUrl(original, "production");
  const client = new Client({ connectionString: url.toString() });
  assert.equal(url.searchParams.get("sslmode"), "no-verify");
  assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: false });
  assert.equal(url.hostname, "dpg-daqknpugekts7391clg0-a");
  assert.doesNotMatch(readFileSync(path.join(__dirname, "db.js"), "utf8"),
    /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.throws(() => prepareDatabaseUrl(original.replace("require", "disable"), "production"),
    /TLS is required/);
});

test("external PostgreSQL retains certificate verification and diagnostics omit credentials", () => {
  const url = prepareDatabaseUrl(
    "postgres://private:password@dpg-daqknpugekts7391clg0-a.singapore-postgres.render.com/vpn_799m?sslmode=require",
    "production"
  );
  const client = new Client({ connectionString: url.toString() });
  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
  assert.throws(() => prepareDatabaseUrl(url.toString().replace("require", "no-verify"), "production"),
    /reserved for Render internal/);
  const diagnostic = describeDatabaseRuntime(url, "prisma/contract.json",
    { storage: { storageHash: "expected-hash" } }, "8.0.0-rc.11");
  assert.equal(diagnostic.host, url.hostname);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|password|postgres:\/\//);
});
