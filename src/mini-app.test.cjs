const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const { verifyTelegramInitData, createMiniAppRouter } = require("./mini-app");
const { dashboardView } = require("./mini-app/app");

const token = "123456:synthetic-telegram-token";
function signedData(userId = 42, authDate = Math.floor(Date.now() / 1000)) {
  const fields = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: "Test" }) });
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const check = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  fields.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return fields.toString();
}

test("Telegram Mini App rejects tampering and stale sessions", () => {
  assert.equal(verifyTelegramInitData(signedData(), token).id, 42);
  assert.equal(verifyTelegramInitData(signedData().replace("Test", "Admin"), token), null);
  assert.equal(verifyTelegramInitData(signedData(42, Math.floor(Date.now() / 1000) - 3601), token), null);
  assert.equal(verifyTelegramInitData(signedData(42, Math.floor(Date.now() / 1000) + 61), token), null);
  assert.equal(verifyTelegramInitData(signedData(42) + "&user=%7B%7D", token), null);
});

test("Mini App serves live account data and gates connect and checkout by Telegram identity", async () => {
  const calls = [];
  const app = express();
  app.use((_req, res, next) => { res.set("X-Frame-Options", "DENY"); next(); });
  app.use("/mini-app", createMiniAppRouter({
    botToken: token,
    async getAccount(id) { calls.push(["account", id]); return { customerExists: true, status: "ACTIVE", plan: "Basic", dataUsedGb: 35, dataLimitGb: 100 }; },
    async getPackages() { return [{ id: 7, name: "Basic", dataLimitGb: 100, durationDays: 31, priceMmk: 5000 }]; },
    async getConnectUrl(id) { calls.push(["connect", id]); return "https://vpn.example.test/connect/synthetic-token"; },
    async sendBotFlow(id, flow, packageId) { calls.push(["flow", id, flow, packageId]); },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/mini-app`;
  const post = (endpoint, body) => fetch(`${base}/api/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), null);
    const html = await page.text();
    assert.match(html, /Metro Secure/);
    assert.match(html, /id="support-button"/);
    assert.equal([...html.matchAll(/metro-secure-icon\.png/g)].length, 4);
    assert.doesNotMatch(html, /🌐|<svg\b/);
    const icon = await fetch(`${base}/metro-secure-icon.png`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /^image\/png/);
    assert.deepEqual(Buffer.from(await icon.arrayBuffer()),
      readFileSync(path.join(__dirname, "mini-app", "metro-secure-icon.png")));
    const denied = await post("overview", { initData: "bad" });
    assert.equal(denied.status, 401);
    assert.deepEqual(calls, []);
    const overview = await post("overview", { initData: signedData() });
    assert.equal(overview.status, 200);
    const data = await overview.json();
    assert.equal(data.account.plan, "Basic");
    assert.equal(data.packages[0].name, "Basic");
    assert.equal(Object.hasOwn(data.packages[0], "id"), false);
    assert.ok(data.packages[0].selectionToken);
    assert.equal((await post("flow", { initData: signedData(77), flow: "renew",
      packageToken: data.packages[0].selectionToken })).status, 400);
    assert.equal(JSON.stringify(data).includes("ss://"), false);
    assert.equal((await post("connect", { initData: signedData() })).status, 200);
    assert.equal((await post("flow", { initData: signedData(), flow: "renew",
      packageToken: data.packages[0].selectionToken })).status, 200);
    assert.equal((await post("flow", { initData: signedData(), flow: "support" })).status, 200);
    assert.equal((await post("flow", { initData: signedData(), flow: "arbitrary" })).status, 400);
    assert.deepEqual(calls.filter(([kind]) => kind === "connect" || kind === "flow"),
      [["connect", 42], ["flow", 42, "renew", 7], ["flow", 42, "support", undefined]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dashboard handles subscription and usage states", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const base = { hasSubscription: true, status: "ACTIVE", dataLimitGb: 100,
    dataUsedGb: 35, expiresAt: "2026-10-19T00:00:00Z" };
  assert.equal(dashboardView({}, now).status, "NONE");
  assert.deepEqual([dashboardView(base, now).status, dashboardView(base, now).days,
    dashboardView(base, now).remaining], ["ACTIVE", 18, 65]);
  assert.equal(dashboardView({ ...base, expiresAt: "2026-09-30T00:00:00Z" }, now).status, "EXPIRED");
  assert.equal(dashboardView({ ...base, status: "REVOKED" }, now).status, "REVOKED");
  assert.equal(dashboardView(base, now).warning, "");
  assert.match(dashboardView({ ...base, dataUsedGb: 80 }, now).warning, /getting close/);
  assert.match(dashboardView({ ...base, dataUsedGb: 95 }, now).warning, /Very little/);
  assert.equal(dashboardView({ ...base, dataUsedGb: 100 }, now).warning, "Data limit reached");
  assert.equal(dashboardView({ ...base, dataUsedGb: null }, now).percent, null);
});

test("customer API sends only allowlisted fields and rejects identity substitution", async () => {
  const accounts = new Map([[42, { customerExists: true, hasSubscription: true, status: "ACTIVE", plan: "Standard",
    serverLabel: "Singapore", dataLimitGb: 200, dataUsedGb: 82.4,
    vpnKey: "ss://secret", vpnKeyId: "internal-key", customerId: 9, telegramId: "42",
    managementUrl: "https://192.0.2.1/secret", token: "private" }]]);
  let createdKeys = 0;
  let seenId;
  const app = express();
  app.use("/app", createMiniAppRouter({ botToken: token,
    async getAccount(id) { seenId = id; return accounts.get(id) ||
      { customerExists: id === 77, hasSubscription: false, status: "NONE" }; },
    async getPackages() { return []; },
    async getConnectUrl(id) { seenId = id; return id === 42 ? "https://vpn.example.test/connect/token" : null; },
    async sendBotFlow() {},
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/app/api`;
  const post = (path, body) => fetch(`${base}/${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const denied = await post("overview", { initData: "invalid", telegramId: 42 });
    assert.equal(denied.status, 401);
    assert.equal(seenId, undefined);
    const other = await post("overview", { initData: signedData(77), telegramId: 42, customerId: 9 });
    assert.equal(other.status, 200);
    assert.equal((await other.json()).account.status, "NONE");
    assert.equal(seenId, 77);
    assert.equal((await post("overview", { initData: signedData(88) })).status, 403);
    assert.equal((await post("connect", { initData: signedData(77), subscriptionId: 9 })).status, 409);
    assert.equal(seenId, 77);
    const own = await post("overview", { initData: signedData(42) });
    const body = await own.json();
    assert.equal(body.account.plan, "Standard");
    assert.equal(body.account.serverLabel, "Singapore");
    assert.equal(body.account.dataUsedGb, 82.4);
    for (const secret of ["ss://", "internal-key", "customerId", "telegramId", "managementUrl", "192.0.2.1", "private"])
      assert.equal(JSON.stringify(body).includes(secret), false);
    const connect = await post("connect", { initData: signedData(42), customerId: 999 });
    assert.equal(connect.status, 200);
    assert.equal(seenId, 42);
    assert.equal(createdKeys, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("account lookup failure returns a safe message", async () => {
  const app = express();
  app.use("/app", createMiniAppRouter({ botToken: token,
    async getAccount() { throw new Error("postgres://secret sql error"); },
    async getPackages() { return []; }, async getConnectUrl() { return null; },
    async sendBotFlow() {},
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/app/api/overview`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signedData() }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "We couldn't load your account." });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
