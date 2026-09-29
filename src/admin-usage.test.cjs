const assert = require("node:assert/strict");
const { test } = require("node:test");
const bcrypt = require("bcryptjs");
const express = require("express");
const { Temporal } = require("@js-temporal/polyfill");
const { createAdminRouter, validateAdminConfig } = require("./admin-auth");
const { getUsageData, usageMetrics, getSettingsData } = require("./admin-data");

const email = "admin@example.test";
const password = "synthetic-test-password";
const expiry = Temporal.Instant.from("2099-01-01T00:00:00Z");
const usageRows = [
  { id: 1, plan: "Standard", status: "ACTIVE", vpnKeyId: "key-1", dataUsedGb: 35,
    dataLimitGb: 100, expiresAt: expiry, revokedAt: null,
    customer: { telegramId: "123456789", username: '<img src=x onerror=alert(1)>',
      firstName: '<script>alert(1)</script>' }, package: { name: '<b>Standard</b>' },
    vpnKey: "ss://hidden-access-url" },
  { id: 2, plan: "Zero", status: "ACTIVE", vpnKeyId: "mock-2", dataUsedGb: 2,
    dataLimitGb: 0, expiresAt: expiry, revokedAt: null,
    customer: { telegramId: "222", username: null, firstName: "Zero" }, package: null },
  { id: 3, plan: "Over", status: "ACTIVE", vpnKeyId: "key-3", dataUsedGb: 120,
    dataLimitGb: 100, expiresAt: expiry, revokedAt: null,
    customer: { telegramId: "333", username: "over", firstName: "Over" }, package: null },
];

function makeApi() {
  const calls = [];
  return {
    calls, usageMetrics, getSettingsData,
    getUsageData: async (_client, params) => {
      calls.push({ q: params.q, status: params.status, page: params.page });
      return {
        subscriptions: params.status === "expired" ? [] : usageRows,
        summary: { totalDataUsedGb: 157, totalDataLimitGb: 200, activeSubscriptions: 3,
          above50: 1, above80: 1, atLimit: 1 },
        count: 41, page: Number(params.page || 1), totalPages: 3,
        q: params.q || "", filter: params.status || "all", now: Temporal.Now.instant(),
      };
    },
  };
}

async function startServer(dataApi) {
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = validateAdminConfig({
    ADMIN_EMAIL: email, ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 10),
    ADMIN_SESSION_SECRET: "synthetic-session-secret-for-usage-tests-only", NODE_ENV: "test",
  });
  app.use("/admin", createAdminRouter({ ...config, getClient: () => ({}), dataApi,
    getOperationalStatus: () => ({ databaseConnected: true, usageWorkerEnabled: true,
      usageSyncRunning: false, usageIntervalMinutes: 15, processingRecoveryMinutes: 15 }) }));
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    request: (path, options = {}) => fetch(base + path, { redirect: "manual", ...options }),
    login: async () => {
      const response = await fetch(base + "/admin/login", {
        method: "POST", redirect: "manual", headers: { Origin: base },
        body: new URLSearchParams({ email, password }),
      });
      assert.equal(response.status, 303);
      return response.headers.get("set-cookie").split(";")[0];
    },
  };
}

test("Usage and Settings require the existing admin session", async (t) => {
  const site = await startServer(makeApi());
  t.after(site.close);
  for (const path of ["/admin/usage", "/admin/settings"]) {
    const response = await site.request(path);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin/login");
  }
});

test("Usage renders summaries, safe percentages, progress, search and paging", async (t) => {
  const api = makeApi();
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/usage?q=123456789&status=above50&page=2", {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.deepEqual(api.calls[0], { q: "123456789", status: "above50", page: "2" });
  for (const value of ["157 GB", "200 GB", "35%", "120% (100%+)", "N/A", "Page 2 of 3",
    "Stored snapshot", "Legacy mock · sync skipped"]) assert.ok(html.includes(value), value);
  assert.match(html, /q=123456789&amp;status=above50&amp;page=3/);
  assert.match(html, /href="\/admin\/usage"/);
  assert.match(html, /href="\/admin\/settings"/);
  assert.match(html, /<progress class="usage-progress" value="100" max="100"/);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;b&gt;Standard&lt;/b&gt;"));
  assert.equal(html.includes("ss://"), false);
  const expired = await site.request("/admin/usage?status=expired", { headers: { Cookie: cookie } });
  assert.equal(expired.status, 200);
  assert.match(await expired.text(), /No usage records match this view/);
});

test("usage metrics reject null, zero, negative and nonfinite limits", () => {
  assert.deepEqual(usageMetrics({ dataUsedGb: 35, dataLimitGb: 100 }),
    { used: 35, limit: 100, percentage: 35, remaining: 65 });
  for (const limit of [null, 0, -1, "NaN", Infinity]) {
    const metrics = usageMetrics({ dataUsedGb: 10, dataLimitGb: limit });
    assert.equal(metrics.percentage, null);
    assert.equal(metrics.remaining, null);
  }
  assert.equal(usageMetrics({ dataUsedGb: 120, dataLimitGb: 100 }).remaining, 0);
});

test("Settings shows safe status values, admin email and cleanup checklist without secrets", async (t) => {
  const site = await startServer(makeApi());
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/settings", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const value of [email, "Production health", "Database connected", "Usage worker enabled",
    "15 minutes", "Final cleanup checklist", "Review legacy mock-* records", "Real Outline only"]) {
    assert.ok(html.includes(value), value);
  }
  for (const name of ["BOT_TOKEN", "DATABASE_URL", "OUTLINE_API_URL", "ADMIN_PASSWORD_HASH",
    "ADMIN_SESSION_SECRET"]) {
    const secret = process.env[name];
    if (secret) assert.equal(html.includes(secret), false, name);
  }
  assert.equal(html.includes("ss://"), false);
});

test("settings data includes no raw secrets and marks missing configuration", () => {
  const env = { NODE_ENV: "production", PUBLIC_BASE_URL: "https://vpn.example.test/private-path",
    BOT_TOKEN: "private-bot-token", DATABASE_URL: "private-db-url", OUTLINE_API_URL: "private-outline-url",
    ADMIN_EMAIL: email };
  const settings = getSettingsData(env, { email, production: true,
    passwordHash: "private-hash", sessionSecret: "private-session-secret" }, {});
  assert.equal(settings.publicHostname, "vpn.example.test");
  assert.equal(settings.requiredEnvPresent, false);
  assert.equal(settings.databaseConnected, false);
  const serialized = JSON.stringify(settings);
  for (const secret of [env.BOT_TOKEN, env.DATABASE_URL, env.OUTLINE_API_URL,
    "private-hash", "private-session-secret", "/private-path"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

class QuerySpy {
  constructor(rows, log, steps = []) { this.rows = rows; this.log = log; this.steps = steps; }
  clone(name, value) { return new QuerySpy(this.rows, this.log, [...this.steps, [name, value]]); }
  where(value) { return this.clone("where", value); }
  select(...fields) { return this.clone("select", fields); }
  include(name, callback) { callback(new QuerySpy([], this.log)); return this.clone("include", name); }
  orderBy(value) { return this.clone("orderBy", value); }
  offset(value) { return this.clone("offset", value); }
  limit(value) { return this.clone("limit", value); }
  aggregate(selector) { selector({ count: () => "count" }); return Promise.resolve({ count: this.rows.length }); }
  all() {
    this.log.push(this.steps);
    const offset = this.steps.find(([name]) => name === "offset")?.[1] || 0;
    const limit = this.steps.find(([name]) => name === "limit")?.[1] || this.rows.length;
    return Promise.resolve(this.rows.slice(offset, offset + limit));
  }
}

test("usage query scans bounded batches and applies strict threshold filters", async () => {
  const rows = [
    { id: 1, status: "ACTIVE", dataUsedGb: 50, dataLimitGb: 100, expiresAt: expiry, revokedAt: null },
    { id: 2, status: "ACTIVE", dataUsedGb: 51, dataLimitGb: 100, expiresAt: expiry, revokedAt: null },
    { id: 3, status: "ACTIVE", dataUsedGb: 81, dataLimitGb: 100, expiresAt: expiry, revokedAt: null },
    { id: 4, status: "ACTIVE", dataUsedGb: 100, dataLimitGb: 100, expiresAt: expiry, revokedAt: null },
    { id: 5, status: "ACTIVE", dataUsedGb: 1, dataLimitGb: 0, expiresAt: expiry, revokedAt: null },
  ];
  const log = [];
  const client = { public: { Subscription: new QuerySpy(rows, log) } };
  const counts = [];
  for (const status of ["above50", "above80", "atLimit"]) {
    const data = await getUsageData(client, { status, q: "123", page: "1" });
    counts.push(data.count);
    assert.equal(data.summary.activeSubscriptions, 5);
    assert.equal(data.summary.totalDataUsedGb, 283);
    assert.ok(log.every((steps) => steps.some(([name, value]) => name === "limit" && value <= 250)));
  }
  assert.deepEqual(counts, [3, 2, 1]);
});
