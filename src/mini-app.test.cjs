const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const { verifyTelegramInitData, createMiniAppRouter } = require("./mini-app");
const { dashboardView, formatUsageSync, remainingDays, formatRemainingDays,
  formatUsagePercent, progressFillPercent, formatPlanLabel,
  orderStatusLabel, vpnStatusLabel } = require("./mini-app/app");

test("Mini App keeps customer statuses, exact days and buttons friendly", () => {
  assert.equal(formatPlanLabel("Basic - 30 Days"), "Basic - 30 ရက်");
  assert.equal(formatPlanLabel("Basic - 60 Days"), "Basic - 60 ရက်");
  for (const status of ["ACTIVE", "EXPIRED", "REVOKED", "DATA_LIMIT_REACHED", "INACTIVE", "NONE", "NEW_STATE"])
    assert.doesNotMatch(vpnStatusLabel(status), /\b(?:ACTIVE|EXPIRED|REVOKED|DATA_LIMIT_REACHED|INACTIVE|NONE|NEW_STATE)\b/);
  for (const status of ["PENDING_PAYMENT", "PAYMENT_SUBMITTED", "PROCESSING", "PAID", "PAYMENT_REJECTED", "CANCELLED", "EXPIRED", "NEW_STATE"])
    assert.doesNotMatch(orderStatusLabel(status), /\b(?:PENDING_PAYMENT|PAYMENT_SUBMITTED|PROCESSING|PAID|PAYMENT_REJECTED|CANCELLED|EXPIRED|NEW_STATE)\b/);
  assert.match(orderStatusLabel("PAYMENT_SUBMITTED"), /Slip ရပါပြီ/);
  assert.match(vpnStatusLabel("EXPIRED"), /VPN သက်တမ်းကုန်သွားပါပြီ/);

  const html = readFileSync(path.join(__dirname, "mini-app", "index.html"), "utf8");
  const js = readFileSync(path.join(__dirname, "mini-app", "app.js"), "utf8");
  const labels = [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
  labels.push(...[...js.matchAll(/\baction\("([^"]+)"/g)].map((match) => match[1]));
  for (const label of labels) assert.doesNotMatch(label, /\p{Extended_Pictographic}|[↻←⌂⬡◆]/u);
  assert.match(js, /api\("support\/send"/);
  assert.match(js, /api\/order\/payment-proof-upload/);
  assert.doesNotMatch(html + js, /Contact us in the bot|Send this through Telegram|Send Payment Proof in Bot/);
  assert.match(js, /slip ပုံကို ဒီမှာတင်ပေးပါ/);
});

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

test("Mini App Support stays inside the app and validates every customer request", async () => {
  const calls = [];
  const conversations = new Map();
  const service = {
    async openOrResumeTicket(id) { calls.push(["open", id]); return { customer: { id } }; },
    async listMessages(id) { calls.push(["list", id]); return { messages: conversations.get(id) || [] }; },
    async sendCustomerMessage(id, text) {
      calls.push(["send", id, text]);
      conversations.set(id, [...(conversations.get(id) || []),
        { sender: "customer", text, createdAt: "2026-09-30T00:00:00Z" }]);
      return { ok: true };
    },
  };
  const app = express();
  app.use("/app", createMiniAppRouter({ botToken: token,
    async getAccount() { return { customerExists: true }; },
    getSupportService() { return service; },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/app`;
  const post = (route, initData, extra = {}) => fetch(`${base}/api/support/${route}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData, ...extra }),
  });
  try {
    const html = await (await fetch(base)).text();
    const js = await (await fetch(`${base}/app.js`)).text();
    const css = await (await fetch(`${base}/app.css`)).text();
    assert.match(html, /id="support-panel"/);
    assert.match(js, /navigate\("support"\)/);
    assert.doesNotMatch(html + js, /Send Payment Proof in Bot|Contact Support in Bot|Opening Support in the bot|Send your payment screenshot as a photo/);
    assert.doesNotMatch(html, /<button[^>]*>[^<]*[⚡♻🎧📊🗂↻←⌂⬡◆]/u);
    assert.match(css, /\.action-stack\{display:flex;flex-direction:column;gap:15px/);
    assert.match(css, /\.primary-button\{border:0;background:linear-gradient/);
    assert.match(css, /\.secondary-button\{border:1px solid/);
    assert.match(js, /api\("support\/send"/);
    assert.match(js, /new EventSource\(`/);
    assert.match(js, /state\.supportFallbackTimer = setInterval/);
    assert.match(js, /stopFallback\(\)/);
    assert.match(js, /api\/order\/payment-proof-upload/);
    assert.doesNotMatch(js, /payment-proof-handoff|api\("flow"/);
    assert.match(readFileSync(path.join(__dirname, "customer-menu.js"), "utf8"), /🎧 Support/);
    assert.equal((await post("open", "invalid")).status, 401);
    assert.equal((await post("messages", signedData(42, Math.floor(Date.now() / 1000) - 3601))).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await post("open", signedData(42))).status, 200);
    assert.equal((await post("send", signedData(42), { text: "My order needs help", customerId: 77, ticketId: 777 })).status, 200);
    const other = await (await post("messages", signedData(77), { customerId: 42, ticketId: 1 })).json();
    assert.deepEqual(other, { messages: [] });
    const own = await (await post("messages", signedData(42))).json();
    assert.equal(own.messages[0].text, "My order needs help");
    assert.equal(JSON.stringify(own).includes("ticketId"), false);
    assert.deepEqual(calls.filter(([kind]) => kind === "send"), [["send", 42, "My order needs help"]]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
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
    assert.match(page.headers.get("content-security-policy"), /img-src 'self' data: blob:/);
    assert.equal(page.headers.get("x-frame-options"), null);
    const html = await page.text();
    assert.match(html, /Metro Secure/);
    assert.match(html, /id="support-button"/);
    assert.equal([...html.matchAll(/metro-secure-icon\.png/g)].length, 5);
    assert.match(html, /<link rel="preload" as="image" href="metro-secure-icon\.png">/);
    const headerLogo = html.match(/<header class="topbar"><img\b[^>]*>/)?.[0];
    const heroLogo = html.match(/<div id="hero" class="hero"><img\b[^>]*>/)?.[0];
    assert.ok(headerLogo);
    assert.ok(heroLogo);
    for (const [logo, size] of [[headerLogo, 36], [heroLogo, 76]]) {
      assert.match(logo, /src="metro-secure-icon\.png"/);
      assert.match(logo, new RegExp(`width="${size}" height="${size}"`));
      assert.match(logo, /loading="eager"/);
      assert.match(logo, /fetchpriority="high"/);
      assert.doesNotMatch(logo, /loading="lazy"|style="[^"]*opacity\s*:\s*0/);
    }
    assert.ok(html.indexOf('id="hero"') < html.indexOf('id="loading"'));
    assert.ok(html.indexOf('id="hero"') < html.indexOf('id="content" class="hidden"'));
    assert.doesNotMatch(html, /hero-skeleton/);
    const css = await (await fetch(`${base}/app.css`)).text();
    const js = await (await fetch(`${base}/app.js`)).text();
    assert.match(css, /\.topbar img,\.hero img\{opacity:1;transform:none;animation:none;transition:none\}/);
    assert.doesNotMatch(js, /metro-secure-icon\.png/);
    assert.match(js, /show\("hero", tab === "home"\)/);
    assert.doesNotMatch(html, /🌐|<svg\b/);
    const icon = await fetch(`${base}/metro-secure-icon.png`);
    const iconBytes = Buffer.from(await icon.arrayBuffer());
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /^image\/png/);
    assert.match(icon.headers.get("cache-control"), /public, max-age=86400/);
    assert.deepEqual(iconBytes,
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
    assert.equal(JSON.stringify(data).includes("ss://"), false);
    assert.equal((await post("connect", { initData: signedData() })).status, 200);
    assert.equal((await post("flow", { initData: signedData(), flow: "support" })).status, 404);
    assert.deepEqual(calls.filter(([kind]) => kind === "connect"), [["connect", 42]]);
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
  assert.equal(dashboardView({ ...base, status: "EXPIRED", expiresAt: "2026-09-30T00:00:00Z" }, now).status, "EXPIRED");
  assert.equal(dashboardView({ ...base, status: "REVOKED" }, now).status, "REVOKED");
  assert.equal(dashboardView({ ...base, status: "DATA_LIMIT_REACHED",
    dataUsedGb: 100 }, now).status, "DATA_LIMIT_REACHED");
  assert.equal(dashboardView(base, now).warning, "");
  assert.match(dashboardView({ ...base, dataUsedGb: 80 }, now).warning, /Data နည်းလာပါပြီ/);
  assert.match(dashboardView({ ...base, dataUsedGb: 95 }, now).warning, /Data နည်းနည်းပဲ ကျန်တော့ပါတယ်/);
  assert.equal(dashboardView({ ...base, dataUsedGb: 100 }, now).warning, "ဒီ package ရဲ့ data ကို အကုန်သုံးပြီးပါပြီ။ ဆက်သုံးချင်ရင် package ထပ်ဝယ်လို့ရပါတယ်။");
  assert.equal(dashboardView({ ...base, dataUsedGb: null }, now).percent, null);
});

test("Mini App formats live subscription usage without rounding non-zero usage to zero or a full quota", () => {
  for (const [used, limit, label] of [
    [0, 300, "0%"], [0.4, 300, "0.1%"], [1, 300, "0.3%"],
    [50, 100, "50%"], [199, 200, "99.5%"], [200, 200, "100%"],
    [250, 200, "100%"],
  ]) {
    const view = dashboardView({ hasSubscription: true, status: "ACTIVE",
      dataUsedGb: used, dataLimitGb: limit });
    assert.equal(view.percent, used / limit * 100);
    assert.equal(formatUsagePercent(view.percent), label);
  }
  assert.equal(formatUsagePercent(dashboardView({ dataUsedGb: 0.001,
    dataLimitGb: 300 }).percent), "<0.1%");
  assert.equal(formatUsagePercent(99.96), "<100%");
  assert.equal(formatUsagePercent(dashboardView({ dataUsedGb: 1e308,
    dataLimitGb: 1e-308 }).percent), "100%");
  assert.equal(formatUsagePercent(null), "အသုံးပြုမှုကို ကြည့်လို့မရသေးပါဘူး");
});

test("Mini App progress presents a visible fill for small usage while keeping the raw percentage", () => {
  const percent = dashboardView({ dataUsedGb: 0.4, dataLimitGb: 300 }).percent;
  assert.ok(percent > 0 && percent < 1);
  assert.equal(progressFillPercent(percent), 1);
  assert.equal(formatUsagePercent(percent), "0.1%");
  assert.equal(progressFillPercent(0), 0);
  assert.equal(progressFillPercent(50), 50);
  assert.equal(progressFillPercent(120), 100);
  assert.equal(progressFillPercent(Infinity), 100);
  const appJs = readFileSync(path.join(__dirname, "mini-app", "app.js"), "utf8");
  assert.match(appJs, /style\.width = `\$\{progressFillPercent\(percent\)\}%`/);
  assert.match(appJs, /aria-valuenow", String\(percent === null \? 0 : Math\.min\(100, percent\)\)/);
});

test("Home, My VPN, and Usage share the percentage formatter and thresholds use raw values", () => {
  const appJs = readFileSync(path.join(__dirname, "mini-app", "app.js"), "utf8");
  for (const id of ["home-usage", "vpn-percent", "usage-percentage"])
    assert.match(appJs, new RegExp(`set\\("${id}"[^;]*formatUsagePercent\\(v\\.percent\\)`));
  const base = { hasSubscription: true, status: "ACTIVE", dataLimitGb: 100 };
  assert.equal(dashboardView({ ...base, dataUsedGb: 79.95 }).warning, "");
  assert.match(dashboardView({ ...base, dataUsedGb: 80 }).warning, /Data နည်းလာပါပြီ/);
  assert.match(dashboardView({ ...base, dataUsedGb: 94.95 }).warning, /Data နည်းလာပါပြီ/);
  assert.match(dashboardView({ ...base, dataUsedGb: 95 }).warning, /Data နည်းနည်းပဲ ကျန်တော့ပါတယ်/);
  assert.match(dashboardView({ ...base, dataUsedGb: 99.95 }).warning, /Data နည်းနည်းပဲ ကျန်တော့ပါတယ်/);
  assert.equal(dashboardView({ ...base, dataUsedGb: 100 }).warning, "ဒီ package ရဲ့ data ကို အကုန်သုံးပြီးပါပြီ။ ဆက်သုံးချင်ရင် package ထပ်ဝယ်လို့ရပါတယ်။");
});

test("Mini App derives exact remaining days from expiry and always labels them as days", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  for (const [milliseconds, expected] of [
    [60 * 86400000, 60], [30 * 86400000, 30],
    [29 * 86400000 + 10 * 3600000, 30], [86400000, 1],
    [1, 1], [0, 0], [-1, 0],
  ]) {
    const expiresAt = new Date(now + milliseconds).toISOString();
    assert.equal(remainingDays(expiresAt, now), expected);
    assert.equal(dashboardView({ hasSubscription: true, status: "ACTIVE", expiresAt }, now).days, expected);
  }
  assert.equal(formatRemainingDays(60), "60 ရက် ကျန်ပါတယ်");
  assert.equal(formatRemainingDays(1), "1 ရက် ကျန်ပါတယ်");
  assert.equal(formatRemainingDays(0), "သက်တမ်းကုန်ပါပြီ");
  assert.doesNotMatch(formatRemainingDays(60), /month/i);
  assert.equal(remainingDays(null, now), null);
});

test("usage sync timestamps render as relative text with a first-sync fallback", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  assert.equal(formatUsageSync(null, now), "မစစ်ရသေးပါဘူး");
  assert.equal(formatUsageSync("2026-09-30T12:00:00Z", now), "အခုလေးတင်");
  assert.equal(formatUsageSync("2026-09-30T11:59:15Z", now), "45 စက္ကန့်အကြာက");
  assert.equal(formatUsageSync("2026-09-30T11:58:00Z", now), "2 မိနစ်အကြာက");
  assert.doesNotMatch(formatUsageSync("2026-09-28T12:00:00Z", now), /T12:00:00Z/);
});

test("customer API sends only allowlisted fields and rejects identity substitution", async () => {
  const accounts = new Map([[42, { customerExists: true, hasSubscription: true, status: "ACTIVE", plan: "Standard",
    serverLabel: "Singapore", dataLimitGb: 200, dataUsedGb: 82.4,
    lastUsageSyncedAt: "2026-09-30T11:59:15Z",
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
    assert.equal(body.account.lastUsageSyncedAt, "2026-09-30T11:59:15Z");
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
    assert.deepEqual(await response.json(), { error: "အခုကြည့်လို့မရသေးပါဘူး။ ခဏနေရင် ပြန်စမ်းကြည့်ပေးပါ။" });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("Phase 2 checkout rechecks packages and scopes orders", async () => {
  const packages = [
    { id: 7, name: "Basic", dataLimitGb: 50, durationDays: 30, priceMmk: 3200, active: true, sortOrder: 1, version: "v1" },
    { id: 8, name: "Hidden", dataLimitGb: 10, durationDays: 10, priceMmk: 1000, active: false, sortOrder: 2, version: "v1" },
  ];
  const orders = [];
  const app = express();
  app.use("/app", createMiniAppRouter({ botToken: token,
    async getAccount(id) { return { customerExists: id === 42 || id === 77,
      status: id === 77 ? "ACTIVE" : "NONE", hasSubscription: id === 77 }; },
    async getPackages() { return packages.filter((pkg) => pkg.active)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id); },
    async getPackage(id) { return packages.find((pkg) => pkg.id === id && pkg.active) || null; },
    async createOrder(user, _account, id, version) {
      const pkg = packages.find((item) => item.id === id && item.active);
      if (pkg.version !== version) return { changed: true };
      const existing = orders.find((order) => order.owner === user.id && order.status === "PENDING_PAYMENT");
      if (existing) return { order: existing, inProgress: true };
      const order = { owner: user.id, orderNumber: "VPN-Itest123", plan: pkg.name,
        price: pkg.priceMmk, totalDataGb: pkg.dataLimitGb, totalDurationDays: pkg.durationDays,
        createdAt: new Date("2026-09-30T00:00:00Z"), status: "PENDING_PAYMENT",
        paymentProof: "private-file-id", vpnKey: "ss://secret", customerId: 9, id: 1 };
      orders.push(order);
      return { order, inProgress: false };
    },
    async getOrder(id, number) { return orders.find((order) => order.owner === id && order.orderNumber === number) || null; },
    async getOrders(id) { return orders.filter((order) => order.owner === id); },
    async getPaymentMethods() { return [{ code: "mobile_wallet", name: "Wallet",
      accountName: "Metro Secure", accountNumber: "09999999999" }]; },
    async selectPaymentMethod(id, number, method) {
      const order = orders.find((item) => item.owner === id && item.orderNumber === number);
      if (!order || method !== "mobile_wallet") return null;
      order.paymentMethod = method; return order;
    },
    async getConnectUrl() { return null; }, async sendBotFlow() {},
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/app/api`;
  const post = (path, id = 42, extra = {}) => fetch(`${base}/${path}`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: signedData(id), ...extra }) });
  try {
    assert.equal((await post("packages", 42, { initData: "invalid" })).status, 401);
    const first = (await (await post("packages")).json()).packages;
    assert.equal(first.length, 1);
    assert.equal(first[0].name, "Basic");
    assert.equal(Object.hasOwn(first[0], "id"), false);
    assert.equal((await post("order/create", 42,
      { confirmationToken: first[0].selectionToken })).status, 400);
    packages[0].priceMmk = 3500; packages[0].dataLimitGb = 55;
    packages[0].durationDays = 33; packages[0].version = "v2";
    const refreshed = (await (await post("packages")).json()).packages;
    assert.equal(refreshed[0].priceMmk, 3500);
    const detail = (await (await post("package/detail", 42,
      { selectionToken: first[0].selectionToken })).json());
    assert.equal(detail.package.changed, true);
    assert.equal(detail.package.dataLimitGb, 55);
    packages[0].priceMmk = 3600; packages[0].version = "v3";
    const staleResponse = await post("order/create", 42,
      { confirmationToken: detail.confirmationToken, price: 1, durationDays: 999, dataLimitGb: 999 });
    assert.equal(staleResponse.status, 409);
    const current = await staleResponse.json();
    assert.equal(current.package.priceMmk, 3600);
    assert.equal(orders.length, 0);
    const created = await post("order/create", 42,
      { confirmationToken: current.confirmationToken, price: 1, durationDays: 999, dataLimitGb: 999, customerId: 77 });
    assert.equal(created.status, 200);
    const order = (await created.json()).order;
    assert.equal(order.amountMmk, 3600);
    assert.equal(order.dataLimitGb, 55);
    assert.equal(order.durationDays, 33);
    assert.equal(orders.length, 1);
    assert.equal((await (await post("order/create", 42,
      { confirmationToken: current.confirmationToken })).json()).inProgress, true);
    assert.equal(orders.length, 1);
    assert.equal((await post("order/status", 77, { orderNumber: order.orderNumber })).status, 404);
    assert.equal((await post("order/payment-method", 77,
      { orderNumber: order.orderNumber, method: "mobile_wallet" })).status, 409);
    const methods = (await (await post("payment-methods")).json()).methods;
    assert.equal(methods[0].accountNumber, "09999999999");
    assert.equal((await post("order/payment-method", 42,
      { orderNumber: order.orderNumber, method: "mobile_wallet" })).status, 200);
    assert.equal((await post("order/payment-proof-handoff", 42,
      { orderNumber: order.orderNumber })).status, 404);
    assert.equal((await (await post("orders", 77)).json()).orders.length, 0);
    const visible = await (await post("order/status", 42, { orderNumber: order.orderNumber })).json();
    assert.equal(visible.order.status, "PAYMENT_SUBMITTED");
    for (const secret of ["private-file-id", "ss://", "customerId", "telegramId", '"id":1'])
      assert.equal(JSON.stringify(visible).includes(secret), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
