const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const { verifyTelegramInitData, createMiniAppRouter } = require("./mini-app");

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
    async getAccount(id) { calls.push(["account", id]); return { status: "ACTIVE", plan: "Basic", dataUsedGb: 35, dataLimitGb: 100 }; },
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
    assert.equal([...html.matchAll(/metro-secure-icon\.png/g)].length, 5);
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
    assert.equal(data.packages[0].id, 7);
    assert.equal(JSON.stringify(data).includes("ss://"), false);
    assert.equal((await post("connect", { initData: signedData() })).status, 200);
    assert.equal((await post("flow", { initData: signedData(), flow: "renew", packageId: 7 })).status, 200);
    assert.equal((await post("flow", { initData: signedData(), flow: "arbitrary" })).status, 400);
    assert.deepEqual(calls, [["account", 42], ["connect", 42], ["flow", 42, "renew", 7]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
