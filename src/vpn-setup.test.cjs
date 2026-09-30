const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { Temporal } = require("@js-temporal/polyfill");

// Load the actual implementation without starting polling, recovery, or making
// any production database / Outline calls. Fixtures contain only synthetic keys.
function loadBot() {
  const file = path.join(__dirname, "bot.js");
  const source = readFileSync(file, "utf8");
  const startupOffset = source.lastIndexOf("\nstartBot().catch(");
  assert.ok(startupOffset > 0);
  const localRequire = createRequire(file);
  let now = Date.now();
  let createKeyCalls = 0;
  const logs = [];
  const env = {
    PUBLIC_BASE_URL: "https://vpn.example.test",
    CONNECT_TOKEN_SECRET: "synthetic-test-secret-".repeat(3),
    BOT_TOKEN: "123456:synthetic-bot-token",
  };
  const context = vm.createContext({
    __dirname: __dirname,
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "./db") return { createDatabase() { throw new Error("Unexpected DB startup"); } };
      if (name === "./outline") return {
        createAccessKey() { createKeyCalls++; throw new Error("Setup must never create keys"); },
      };
      return localRequire(name);
    },
    process: { env }, Buffer, URL, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    console: { error(...args) { logs.push(args); } },
    module: { exports: {} },
  });
  vm.runInContext(source.slice(0, startupOffset) + `
    module.exports = { app, createVpnConnectUrl, readConnectToken,
      renderVpnConnectPage, sendVpnSetup, getConnectConfig,
      setDatabase(value) { db = value; } };
  `, context, { filename: file });
  return {
    ...context.module.exports, env, logs,
    advanceTime(ms) { now += ms; },
    get createKeyCalls() { return createKeyCalls; },
  };
}

function activeSubscription() {
  return {
    id: 12345,
    customerId: 98765,
    status: "ACTIVE",
    expiresAt: Temporal.Now.instant().add({ hours: 24 }),
    revokedAt: null,
    vpnKeyId: "existing-key-17",
    vpnKey: "ss://YWVzLTI1Ni1nY206c3ludGhldGlj@192.0.2.1:1234/?outline=1#Test",
  };
}

function runPage(html, options = {}) {
  const nodes = {};
  const navigations = [];
  const copies = [];
  const timers = new Map();
  let clock = 0;
  let selected;
  function node() {
    return { textContent: "", disabled: false, listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
      focus() {}, select() { selected = this; }, setSelectionRange() {},
      setAttribute() {}, remove() { selected = null; },
    };
  }
  const document = {
    getElementById(id) { return nodes[id] ||= node(); },
    createElement() { return node(); },
    body: { appendChild() {} }, addEventListener() {},
    execCommand(command) {
      assert.equal(command, "copy");
      copies.push(selected.value);
      return true;
    },
  };
  const navigator = {
    userAgent: options.ua || "Windows NT",
    platform: options.platform || "Win32",
    maxTouchPoints: options.maxTouchPoints || 0,
  };
  if (!options.noClipboard) navigator.clipboard = {
    async writeText(value) {
      if (options.rejectClipboard) throw new Error("Clipboard denied");
      copies.push(value);
    },
  };
  const window = { isSecureContext: true, addEventListener() {}, location: {} };
  Object.defineProperty(window.location, "href", {
    set(value) {
      navigations.push(value);
      if (options.blockNavigation) throw new Error("App launch blocked");
    },
  });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    document, navigator, window, performance: { now: () => clock },
    setTimeout(fn, delay) { const id = timers.size + 1; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    nodes, navigations, copies,
    click(id) { return nodes[id].listeners.click(); },
    expire() { clock = 601000; },
  };
}

test("existing-key HTTPS setup", async (t) => {
  const bot = loadBot();
  let subscription = activeSubscription();
  let queryCount = 0;
  let databaseError = false;
  bot.setDatabase({ public: {
    Customer: { where: () => ({ first: async () => ({ id: 98765 }) }) },
    Package: { where: () => ({ all: async () => [{
      id: 7, name: "Basic", active: true, sortOrder: 1,
      dataLimitGb: 100, durationDays: 31, priceMmk: 5000,
    }] }) },
    Subscription: { where: (filter) => ({ first: async () => {
      queryCount++;
      if (databaseError) throw new Error("Private database details");
      if (filter.id !== undefined) assert.equal(filter.id, 12345);
      return subscription;
    } }) },
  } });
  const server = bot.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connectUrl = bot.createVpnConnectUrl(subscription);
  const token = connectUrl.split("/").pop();
  const request = (url = connectUrl, https = true) => fetch(origin + new URL(url).pathname, {
    headers: https ? { "X-Forwarded-Proto": "https" } : {}, redirect: "manual",
  });
  let html;

  await t.test("opaque randomized tokens resolve to the subscription without containing a key", () => {
    assert.notEqual(bot.createVpnConnectUrl(subscription), connectUrl);
    assert.equal(bot.readConnectToken(token).subscriptionId, subscription.id);
    assert.equal(bot.readConnectToken(token).expiresAt <= Date.now() + 600000, true);
    const decoded = Buffer.from(token.slice(3), "base64url").toString("utf8");
    assert.equal(decoded.includes(subscription.vpnKey), false);
    assert.equal(decoded.includes('"subscriptionId"'), false);
    assert.equal(decoded.includes("98765"), false);
    const short = { ...subscription, expiresAt: Temporal.Now.instant().add({ seconds: 30 }) };
    const shortToken = bot.createVpnConnectUrl(short).split("/").pop();
    assert.equal(bot.readConnectToken(shortToken).expiresAt, Number(short.expiresAt.epochMilliseconds));
  });

  await t.test("helper serves the existing key privately and never redirects to a download", async () => {
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    html = await response.text();
    assert.match(html, /<h1>VPN Setup<\/h1>/);
    assert.doesNotMatch(html, /getoutline\.org|play\.google|itunes\.apple|intent:\/\/|outline:\/\//);
    const visibleBody = html.replace(/<script[\s\S]*?<\/script>/g, "");
    assert.equal(visibleBody.includes(subscription.vpnKey), false);
    assert.equal(visibleBody.includes("ss://"), false);
    // Repeated loads must remain usable (Telegram previews must not consume it).
    assert.equal((await request()).status, 200);
  });

  await t.test("security headers are present and private files are not served", async () => {
    const response = await request();
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
    for (const file of ["/.env", "/backups/private.sql", "/prisma/contract.prisma",
      "/migrations/20260929_support_tickets.sql", "/src/bot.js", "/.git/config"]) {
      const result = await fetch(origin + file);
      assert.equal(result.status, 404, file);
    }
  });

  await t.test("/app opens the same signed Mini App and reads current account data", async () => {
    const redirect = await fetch(origin + "/app", { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "app/");
    const page = await fetch(origin + "/app/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /metro-secure-icon\.png/);
    assert.equal((await fetch(origin + "/app/metro-secure-icon.png")).status, 200);
    const denied = await fetch(origin + "/app/api/overview", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(denied.status, 401);
    const fields = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 123, first_name: "Test" }),
    });
    const secret = crypto.createHmac("sha256", "WebAppData").update(bot.env.BOT_TOKEN).digest();
    const check = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${key}=${value}`).join("\n");
    fields.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
    const overview = await fetch(origin + "/app/api/overview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: fields.toString() }),
    });
    assert.equal(overview.status, 200);
    const data = await overview.json();
    assert.equal(data.account.status, "ACTIVE");
    assert.equal(data.packages[0].name, "Basic");
    assert.equal(JSON.stringify(data).includes(subscription.vpnKey), false);
  });

  await t.test("customer dashboard statuses, server label and Connect use the existing key", async () => {
    const signed = () => {
      const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id: 123, first_name: "Test" }) });
      const secret = crypto.createHmac("sha256", "WebAppData").update(bot.env.BOT_TOKEN).digest();
      const check = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`).join("\n");
      fields.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
      return fields.toString();
    };
    const post = (path) => fetch(origin + `/app/api/${path}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ initData: signed() }) });
    const original = subscription;
    try {
      bot.env.VPN_SERVER_LABEL = "vpn.example.test";
      let account = (await (await post("overview")).json()).account;
      assert.equal(account.serverLabel, "VPN server");
      assert.equal(account.status, "ACTIVE");
      assert.equal(account.canConnect, true);
      assert.equal(account.hasSubscription, true);
      assert.equal(JSON.stringify(account).includes(original.vpnKey), false);
      assert.equal(JSON.stringify(account).includes("192.0.2.1"), false);
      bot.env.VPN_SERVER_LABEL = "Singapore";
      account = (await (await post("overview")).json()).account;
      assert.equal(account.serverLabel, "Singapore");
      const connected = await post("connect");
      assert.equal(connected.status, 200);
      assert.match((await connected.json()).url, /\/connect\/v1\./);
      assert.equal(bot.createKeyCalls, 0);
      subscription = { ...original, expiresAt: Temporal.Now.instant().subtract({ seconds: 1 }) };
      account = (await (await post("overview")).json()).account;
      assert.equal(account.status, "EXPIRED");
      assert.equal(account.canConnect, false);
      assert.equal((await post("connect")).status, 409);
      subscription = { ...original, dataUsedGb: 100, dataLimitGb: 100 };
      account = (await (await post("overview")).json()).account;
      assert.equal(account.status, "DATA_LIMIT_REACHED");
      assert.equal(account.canConnect, false);
      assert.equal((await post("connect")).status, 409);
      assert.equal(bot.createKeyCalls, 0);
      subscription = { ...original, revokedAt: Temporal.Now.instant() };
      account = (await (await post("overview")).json()).account;
      assert.equal(account.status, "REVOKED");
      assert.equal(account.canConnect, false);
      assert.equal((await post("connect")).status, 409);
      subscription = null;
      account = (await (await post("overview")).json()).account;
      assert.equal(account.status, "NONE");
      assert.equal(account.hasSubscription, false);
      assert.equal(bot.createKeyCalls, 0);
    } finally { subscription = original; delete bot.env.VPN_SERVER_LABEL; }
  });

  await t.test("tampered, malformed, wrong-secret and expired tokens are rejected before DB lookup", async () => {
    const before = queryCount;
    const bytes = Buffer.from(token.slice(3), "base64url");
    bytes[35] ^= 1;
    const tampered = "https://vpn.example.test/connect/v1." + bytes.toString("base64url");
    assert.equal((await request(tampered)).status, 410);
    assert.equal((await request("https://vpn.example.test/connect/invalid")).status, 410);
    const originalSecret = bot.env.CONNECT_TOKEN_SECRET;
    bot.env.CONNECT_TOKEN_SECRET = "different-test-secret".repeat(3);
    assert.equal((await request()).status, 410);
    bot.env.CONNECT_TOKEN_SECRET = originalSecret;
    bot.advanceTime(600001);
    assert.equal((await request()).status, 410);
    bot.advanceTime(-600001);
    assert.equal(queryCount, before);
  });

  await t.test("every page load rechecks activity, expiry, revocation and both key fields", async () => {
    const original = subscription;
    for (const change of [
      { status: "EXPIRED" }, { revokedAt: Temporal.Now.instant() },
      { expiresAt: Temporal.Now.instant().subtract({ seconds: 1 }) },
      { dataUsedGb: 100, dataLimitGb: 100 },
      { vpnKey: null }, { vpnKeyId: null }, { vpnKeyId: "" },
      { vpnKeyId: "mock-123" }, { vpnKey: "https://wrong.example.test" },
      { vpnKey: "ssconf://wrong.example.test" },
    ]) {
      subscription = { ...original, ...change };
      const response = await request();
      assert.equal(response.status, 410);
      assert.equal((await response.text()).includes(original.vpnKey), false);
      assert.throws(() => bot.createVpnConnectUrl(subscription));
    }
    subscription = null;
    assert.equal((await request()).status, 410);
    subscription = { ...original, vpnKey: original.vpnKey + "Updated" };
    const currentPage = await (await request()).text();
    assert.equal(runPage(currentPage).navigations[0], subscription.vpnKey);
    subscription = original;
  });

  await t.test("HTTP and DB failures fail closed without leaking details", async () => {
    const insecure = await request(connectUrl, false);
    assert.equal(insecure.status, 400);
    assert.equal(insecure.headers.get("location"), null);
    assert.equal((await insecure.text()).includes(subscription.vpnKey), false);
    databaseError = true;
    const unavailable = await request();
    databaseError = false;
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /Private database details/);
    assert.equal(JSON.stringify(bot.logs).includes(subscription.vpnKey), false);
    assert.equal(JSON.stringify(bot.logs).includes("Private database details"), false);
  });

  await t.test("automatic and click handoffs use the exact same stored URL on all target platforms", () => {
    for (const platform of [
      { ua: "iPhone", platform: "iPhone" },
      { ua: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 },
      { ua: "Android Chrome" }, { ua: "Windows NT" }, { ua: "Macintosh" },
    ]) {
      const page = runPage(html, platform);
      assert.deepEqual(page.navigations, [subscription.vpnKey]);
      page.click("open-outline");
      assert.deepEqual(page.navigations, [subscription.vpnKey, subscription.vpnKey]);
    }
  });

  await t.test("copy works when app navigation is blocked, including the legacy clipboard fallback", async () => {
    const page = runPage(html, { blockNavigation: true });
    await page.click("copy-key");
    assert.deepEqual(page.copies, [subscription.vpnKey]);
    const legacy = runPage(html, { noClipboard: true });
    await legacy.click("copy-key");
    assert.deepEqual(legacy.copies, [subscription.vpnKey]);
    const denied = runPage(html, { rejectClipboard: true });
    await denied.click("copy-key");
    assert.match(denied.nodes.status.textContent, /Tap Copy VPN Key again/);
    await denied.click("copy-key");
    assert.deepEqual(denied.copies, [subscription.vpnKey]);
  });

  await t.test("an expired open page disables launch and copy", async () => {
    const page = runPage(html);
    page.expire();
    page.click("open-outline");
    await page.click("copy-key");
    assert.equal(page.navigations.length, 1);
    assert.equal(page.copies.length, 0);
    assert.equal(page.nodes["open-outline"].disabled, true);
    assert.equal(page.nodes["copy-key"].disabled, true);
  });

  await t.test("script serialization cannot break out of the script element", () => {
    const specialKey = subscription.vpnKey + '</script><script>alert("test")</script>&\u2028\u2029';
    const safePage = bot.renderVpnConnectPage(specialKey, "test-nonce", 60000);
    assert.equal((safePage.match(/<script/g) || []).length, 1);
    assert.deepEqual(runPage(safePage).navigations, [specialKey]);
  });

  await t.test("Telegram setup returns an HTTPS helper and retains Copy Key without creating a key", async () => {
    const replies = [];
    await bot.sendVpnSetup({ from: { id: 999888777 }, reply: async (...args) => replies.push(args) });
    const keyboard = replies[0][1].reply_markup.inline_keyboard;
    assert.equal(keyboard[0][0].copy_text.text, subscription.vpnKey);
    assert.match(keyboard[0][1].url, /^https:\/\/vpn\.example\.test\/connect\/v1\./);
    assert.equal(keyboard[1][0].callback_data, "my_vpn");
    assert.equal(bot.createKeyCalls, 0);
  });

  await t.test("configuration rejects HTTP, embedded credentials and weak token secrets", () => {
    const initialUrl = bot.env.PUBLIC_BASE_URL;
    for (const url of ["http://vpn.example.test", "https://user:pass@vpn.example.test", "https://vpn.example.test/?secret=1", "invalid"]) {
      bot.env.PUBLIC_BASE_URL = url;
      assert.throws(() => bot.getConnectConfig());
    }
    bot.env.PUBLIC_BASE_URL = initialUrl;
    bot.env.CONNECT_TOKEN_SECRET = "short";
    assert.throws(() => bot.getConnectConfig());
  });
});
