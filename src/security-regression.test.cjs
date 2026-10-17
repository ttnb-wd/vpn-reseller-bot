const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { EventEmitter } = require("node:events");
const { createMiniAppRouter } = require("./mini-app");
const { createAdminRouter } = require("./admin-auth");
const { createDynamicConfigRouter, tokenHash } = require("./dynamic-config");
const { createSupportEvents } = require("./support-events");
const { createWindowLimiter } = require("./abuse-limits");
const { getSalesSummary, SALES_SQL } = require("./admin-sales");
const { createNotificationStore } = require("./notification-store");
const { prepareDatabaseUrl, assertDatabaseSecurity } = require("./db");
const { isPrivateCustomerContext } = require("./telegram-security");
const { securityHeaders, safeHttpError } = require("./http-security");
const { describeHandlerFailure } = require("./safe-diagnostics");

const botToken = "123456:synthetic-security-test-token";
const injected = { id: 999, customerId: 99, telegramId: "private-telegram-id",
  vpnKey: "ss://private-vpn-key", vpnKeyId: "private-outline-id", dynamicTokenHash: "private-hash",
  paymentProof: "private-proof-reference", managementUrl: "https://private.test/secret-path",
  databaseUrl: "postgres://private:password@private.test/db", adminSecret: "private-session-secret" };
function signedData(id = 42) {
  const data = new URLSearchParams({ user: JSON.stringify({ id }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const check = [...data.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  data.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return data.toString();
}
async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function callbacks() {
  const pkg = { ...injected, id: 7, name: "Basic", dataLimitGb: 50, durationDays: 30, priceMmk: 5000, version: "v1" };
  const order = { ...injected, orderNumber: "VPN-owner-42", plan: "Basic", price: 5000,
    status: "PENDING_PAYMENT", paymentMethod: "wallet", totalDataGb: 50, totalDurationDays: 30 };
  const message = { ...injected, key: "opaque-message-key", sender: "support", text: "Safe message", createdAt: "2026-10-05T00:00:00Z" };
  return { botToken, getAccount: async id => ({ ...injected, customerExists: true,
    hasSubscription: id === 42, plan: id === 42 ? "Basic" : null, displayName: "Customer", status: id === 42 ? "ACTIVE" : "NONE" }),
    getPackages: async () => [pkg], getPackage: async () => pkg,
    createOrder: async () => ({ order }), getOrder: async (id, number) => id === 42 && number === order.orderNumber ? order : null,
    getOrders: async id => id === 42 ? [order] : [],
    getPaymentMethods: async () => [{ ...injected, code: "wallet", name: "Wallet", accountName: "Metro", accountNumber: "12345" }],
    selectPaymentMethod: async id => id === 42 ? order : null, uploadProof: async id => id === 42 ? { order } : null,
    getConnectUrl: async id => id === 42 ? "https://vpn.example.test/connect/synthetic-token?lang=en" : null,
    getSupportService: () => ({ openOrResumeTicket: async id => ({ customer: { id } }),
      listMessages: async id => ({ ...injected, messages: id === 42 ? [message] : [] }),
      sendCustomerMessage: async () => ({ ok: true, message }) }),
  };
}
async function mini(t, options = {}) {
  const app = express();
  app.use("/app", createMiniAppRouter({ ...callbacks(), ...options }));
  const base = await serve(t, app);
  const post = (route, id = 42, extra = {}, headers = {}) => fetch(`${base}/app/api/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ initData: signedData(id), ...extra }),
  });
  return { base, post };
}
function noSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const key of Object.keys(injected)) assert.equal(serialized.includes(`"${key}":`), false, key);
  for (const secret of Object.values(injected).filter(value => typeof value === "string")) assert.equal(serialized.includes(secret), false, secret);
}

test("SQL injection payloads are rejected as dates and never enter SQL; valid dates are bound", async () => {
  let calls = 0;
  const query = async (sql, values) => {
    calls++; assert.equal(sql, SALES_SQL); assert.equal(values.length, 2);
    for (const value of values) assert.match(value, /^\d{4}-\d{2}-\d{2}T/);
    return { rows: [] };
  };
  for (const payload of ["' OR '1'='1", '" OR "1"="1', "'; SELECT pg_sleep(1); --", "1 OR 1=1"]) {
    await assert.rejects(getSalesSummary(payload, query), /Invalid sales month/);
  }
  assert.equal(calls, 0);
  await getSalesSummary(require("./admin-sales").currentMonth(), query);
  assert.equal(calls, 1);
});

test("raw SQL notification column allowlist rejects prototype and injection names before querying", async () => {
  const pool = new EventEmitter(); let queries = 0;
  pool.query = async () => { queries++; }; pool.connect = async () => { queries++; throw new Error("unexpected query"); };
  const store = createNotificationStore({ pool });
  for (const kind of ["__proto__", "constructor", "toString", '"; DROP TABLE subscription; --']) {
    await assert.rejects(store.claim(1, kind), /Unknown notification kind/);
    await assert.rejects(store.sent({ kind }, 1), /Unknown notification kind/);
  }
  assert.equal(queries, 0);
});

test("every ordinary customer route emits only approved DTO fields, including support and payment", async t => {
  const { post } = await mini(t);
  const overview = await (await post("overview")).json();
  noSecrets(overview);
  assert.deepEqual(Object.keys(overview.account).sort(), ["hasSubscription", "status", "displayName", "plan", "serverLabel", "dataUsedGb", "dataLimitGb", "startedAt", "expiresAt", "lastUsageSyncedAt", "canConnect"].sort());
  assert.deepEqual(Object.keys(overview.packages[0]).sort(), ["name", "dataLimitGb", "durationDays", "priceMmk", "changed", "selectionToken"].sort());
  const detail = await (await post("package/detail", 42, { selectionToken: overview.packages[0].selectionToken })).json(); noSecrets(detail);
  for (const [route, extra] of [["order/create", { confirmationToken: detail.confirmationToken }], ["packages", {}], ["orders", {}],
    ["order/status", { orderNumber: "VPN-owner-42" }], ["order/payment-method", { orderNumber: "VPN-owner-42", method: "wallet" }],
    ["payment-methods", {}], ["support/open", {}], ["support/messages", {}], ["support/send", { text: "Hello" }]]) {
    const response = await post(route, 42, extra); assert.equal(response.status, 200, route); noSecrets(await response.json());
  }
});

test("nested objects in approved scalar fields cannot smuggle internal secrets", async t => {
  const { post } = await mini(t, { getAccount: async () => ({ customerExists: true, displayName: injected, plan: injected }) });
  const response = await (await post("overview")).json();
  assert.equal(response.account.displayName, null); assert.equal(response.account.plan, null); noSecrets(response);
});

test("user A cannot read user B order, subscription, support or connect link", async t => {
  const { post } = await mini(t);
  assert.equal((await post("order/status", 77, { orderNumber: "VPN-owner-42", customerId: 99, telegramId: 42 })).status, 404);
  assert.deepEqual((await (await post("orders", 77)).json()).orders, []);
  const account = (await (await post("overview", 77, { customerId: 99, telegramId: 42 })).json()).account;
  assert.equal(account.hasSubscription, false); assert.equal(account.plan, null);
  assert.deepEqual(await (await post("support/messages", 77, { ticketId: 999 })).json(), { messages: [] });
  assert.equal((await post("connect", 77, { telegramId: 42 })).status, 409);
});

test("package selection and confirmation cannot be replayed by a different Telegram user", async t => {
  const { post } = await mini(t);
  const overview = await (await post("overview")).json();
  const token = overview.packages[0].selectionToken;
  assert.equal((await post("package/detail", 77, { selectionToken: token })).status, 400);
  const detail = await (await post("package/detail", 42, { selectionToken: token })).json();
  assert.equal((await post("order/create", 77, { confirmationToken: detail.confirmationToken })).status, 400);
});

test("Mini App rejects arbitrary Origin and cross-site metadata, never grants CORS", async t => {
  const { post, base } = await mini(t);
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const response = await post("overview", 42, {}, headers);
    assert.equal(response.status, 403); assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const response = await post("overview", 42, {}, { Origin: base }); assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("malformed/oversized JSON responses omit secrets, stacks and paths with safe headers", async t => {
  const { base } = await mini(t);
  for (const [body, status] of [['{"initData":"private-parser-token"', 400], [JSON.stringify({ token: "x".repeat(14000) }), 413]]) {
    const response = await fetch(base + "/app/api/overview", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(response.status, status); assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.doesNotMatch(await response.text(), /private-parser-token|SyntaxError|stack|node_modules|initData/);
  }
});

test("unexpected production errors expose a generic response and no diagnostic payload", async t => {
  const app = express(); app.use(securityHeaders);
  app.get("/app/api/boom", () => { throw Object.assign(new Error("ssconf://private/config/token postgres://user:secret@db/host"), { stack: "private-filesystem-path" }); });
  app.use(safeHttpError); const base = await serve(t, app);
  const response = await fetch(base + "/app/api/boom"); assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Service is temporarily unavailable." });
});

test("customer mutations have a bounded per-user budget", async t => {
  const { post } = await mini(t);
  for (let i = 0; i < 20; i++) assert.equal((await post("order/payment-method", 42, { orderNumber: "VPN-owner-42", method: "wallet" })).status, 200);
  assert.equal((await post("order/payment-method", 42, { orderNumber: "VPN-owner-42", method: "wallet" })).status, 429);
  assert.equal((await post("overview", 42)).status, 200);
});

test("SSE strips internal fields and connection credentials; handshake tokens are single-use", () => {
  let clock = 1000;
  const events = createSupportEvents(botToken, { now: () => clock });
  const res = new EventEmitter(); let output = "";
  res.write = chunk => { output += chunk; return true; }; res.end = () => res.emit("close");
  events.subscribe(42, res);
  events.publish(42, { ...injected, key: "safe", sender: "customer", text: "Check ssconf://private.test/vpn/config/token and ss://secret", createdAt: "today" });
  noSecrets(output); assert.doesNotMatch(output, /ssconf:\/\/|ss:\/\/|private\.test/);
  const session = events.issue(42); assert.equal(events.consume(session), 42); assert.equal(events.consume(session), null);
  const stale = events.issue(42); clock += 60001; assert.equal(events.consume(stale), null); events.closeAll();
});

test("invalid, expired, revoked and exhausted dynamic access never returns a VPN secret", async t => {
  const token = crypto.randomBytes(32).toString("base64url"); let subscription;
  const app = express(); app.use("/vpn/config", createDynamicConfigRouter({ production: false, log: { info() {}, error() {} },
    getClient: () => ({ public: { Subscription: { where(filter) {
      assert.equal(filter.dynamicTokenHash, tokenHash(token)); return { first: async () => subscription };
    } } } }) }));
  const base = await serve(t, app);
  assert.equal((await fetch(base + "/vpn/config/invalid-token")).status, 404);
  assert.equal((await fetch(base + "/vpn/config/" + token)).status, 404);
  for (const override of [{ expiresAt: new Date(Date.now() - 1000) }, { revokedAt: new Date() }, { dataUsedGb: 50 }, { status: "REVOKED" }]) {
    subscription = { status: "ACTIVE", expiresAt: new Date(Date.now() + 3600000), dataLimitGb: 50, dataUsedGb: 0,
      vpnKey: "ss://aes-256-gcm:private-secret@192.0.2.1:1234", ...override };
    const response = await fetch(base + "/vpn/config/" + token);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const yaml = await response.text(); assert.match(yaml, /error:/); assert.doesNotMatch(yaml, /private-secret|transport:|192\.0\.2/);
  }
});

test("outstanding dynamic lookups remain bounded even after response timeouts", async t => {
  let calls = 0; const releases = [];
  const app = express(); app.use("/vpn/config", createDynamicConfigRouter({ production: false, lookupTimeoutMs: 5, log: { info() {}, error() {} },
    getClient: () => ({ public: { Subscription: { where() { return { first() { calls++; return new Promise(resolve => releases.push(resolve)); } }; } } } }) }));
  const base = await serve(t, app); const token = crypto.randomBytes(32).toString("base64url");
  for (let i = 0; i < 35; i++) assert.equal((await fetch(base + "/vpn/config/" + token)).status, 503);
  assert.equal(calls, 32); releases.forEach(resolve => resolve(null));
});

test("rate limiter saturation cannot evict live identities to reset limits", () => {
  const allow = createWindowLimiter({ max: 1, maxEntries: 2, windowMs: 1000 });
  assert.equal(allow("A", 0), true); assert.equal(allow("B", 0), true);
  assert.equal(allow("C", 0), false); assert.equal(allow("A", 0), false);
  assert.equal(allow("C", 1001), true);
});

test("production TLS is verify-full for every host and privileged database roles fail closed", () => {
  for (const hostname of ["db.example", "dpg-test-a", "ep-test-pooler.neon.tech"]) {
    const url = prepareDatabaseUrl(`postgres://synthetic:fake@${hostname}/db?sslmode=require`, "production");
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
  }
  assert.throws(() => prepareDatabaseUrl("postgres://fake:fake@db.example/db?ssl=false", "production"));
  for (const flags of [null, { superuser: true, tls: true }, { bypassRls: true, tls: true }, { tls: false }]) assert.throws(() => assertDatabaseSecurity(flags));
  assert.doesNotThrow(() => assertDatabaseSecurity({ superuser: false, bypassRls: false, tls: true }));
});

test("Telegram customer handlers refuse group chats and mismatched private identities", () => {
  assert.equal(isPrivateCustomerContext({ from: { id: 42 }, chat: { id: 42, type: "private" } }), true);
  for (const chat of [{ id: -100, type: "group" }, { id: -100, type: "supergroup" }, { id: 77, type: "private" }])
    assert.equal(isPrivateCustomerContext({ from: { id: 42 }, chat }), false);
});

test("logs exclude unlabelled secrets, user data, parser bodies, request configs and stacks", () => {
  const error = Object.assign(new Error(JSON.stringify(injected)), { body: injected, config: injected,
    stack: "private-stack", cause: new Error("private-customer-name private-bearer-token") });
  const diagnostic = describeHandlerFailure("synthetic", error); noSecrets(diagnostic);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-|stack|body|config/);
  error.name = error.code = "private-unlabelled-token";
  error.cause.name = error.cause.code = "private-unlabelled-token";
  assert.doesNotMatch(JSON.stringify(describeHandlerFailure("synthetic", error)), /private-/);
});

test("admin APIs require an admin session; wrong Origin and forged CSRF are denied", async t => {
  const app = express(); app.use("/admin", createAdminRouter({ email: "admin@example.test", production: false,
    passwordHash: bcrypt.hashSync("synthetic-password", 10), sessionSecret: "synthetic-session-secret-for-tests-only" }));
  const base = await serve(t, app);
  const unauth = await fetch(base + "/admin/api/sales-summary", { headers: { Cookie: "customer_session=anything" } }); assert.equal(unauth.status, 401);
  const page = await fetch(base + "/admin/login"); const body = await page.text();
  const csrf = body.match(/name="_csrf" value="([^"]+)"/)[1]; const cookie = page.headers.get("set-cookie").split(";")[0];
  for (const headers of [{ Origin: "https://evil.example", Cookie: cookie }, { Origin: "null", Cookie: cookie }, { Cookie: "metro_admin_form=forged" }]) {
    const response = await fetch(base + "/admin/login", { method: "POST", redirect: "manual", headers,
      body: new URLSearchParams({ email: "admin@example.test", password: "synthetic-password", _csrf: csrf }) }); assert.equal(response.status, 403);
  }
});

test("both XSS payloads remain text in customer DOM rendering and are escaped in Admin HTML", () => {
  const { readFileSync } = require("node:fs");
  const source = readFileSync(require("node:path").join(__dirname, "mini-app/app.js"), "utf8");
  const fragment = source.slice(source.indexOf("  function renderPackages()"), source.indexOf("  async function refreshPackages()"));
  const values = [];
  const node = () => ({ append() {}, replaceChildren() {}, addEventListener() {},
    set textContent(value) { values.push(value); }, set innerHTML(_value) { throw new Error("HTML injection sink used"); } });
  const document = { createElement: node };
  for (const payload of ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>"]) {
    const state = { packages: [{ name: payload, dataLimitGb: 50, durationDays: 30, priceMmk: 5000 }], account: null };
    const render = new Function("document", "state", "$", "gb", "dashboardView", "selectPackage", `${fragment}; return renderPackages;`)
      (document, state, node, String, () => ({ status: "NONE" }), () => {});
    render(); assert.ok(values.includes(payload));
    const res = { set() {}, type() { return this; }, send(html) { return html; } };
    const html = require("./admin-ui").renderUsers(res, "admin@example.test", "csrf", { page: 1, totalPages: 1, count: 1, q: payload, status: "all",
      customers: [{ id: 1, firstName: payload, username: payload, telegramId: "42" }] });
    assert.equal(html.includes(payload), false); assert.match(html, /&lt;(?:img|script)/);
  }
});

test("uploads reject invalid MIME and oversize; traversal filenames never survive parsing", async () => {
  const { parseMultipartProof, MAX_IMAGE_BYTES } = require("./payment-proof-upload");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6xkAAAAASUVORK5CYII=", "base64");
  const parse = async (image, mime, filename) => {
    const form = new FormData(); form.append("initData", signedData()); form.append("orderNumber", "VPN-owner-42");
    form.append("proof", new Blob([image], { type: mime }), filename);
    const request = new Request("https://example.test/upload", { method: "POST", body: form });
    return parseMultipartProof(Buffer.from(await request.arrayBuffer()), request.headers.get("Content-Type"));
  };
  await assert.rejects(parse(png, "text/html", "proof.png"));
  await assert.rejects(parse(Buffer.alloc(MAX_IMAGE_BYTES + 1), "image/png", "proof.png"), error => error.status === 413);
  const proof = await parse(png, "image/png", "../../private.exe");
  assert.deepEqual(Object.keys(proof).sort(), ["initData", "orderNumber", "image", "mimeType"].sort());
  assert.equal(proof.image.equals(png), true); assert.equal(proof.filename, undefined);
});

test("readiness timeouts share one outstanding database probe", async () => {
  const { createReadiness } = require("./startup-health");
  let calls = 0, finish;
  const ready = createReadiness({ configured: () => true, botHealthy: () => true, ownsLease: () => true, stopping: () => false,
    timeoutMs: 5, checkDatabase: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  for (let i = 0; i < 3; i++) assert.equal(await ready(), false);
  assert.equal(calls, 1); finish();
});

test("Outline management validation and outbound client cannot accept proxy/redirect/path substitution", async () => {
  const axios = require("axios"), outline = require("./outline");
  const previous = { url: process.env.OUTLINE_API_URL, fingerprint: process.env.OUTLINE_API_CERT_SHA256, create: axios.create };
  try {
    process.env.OUTLINE_API_CERT_SHA256 = "a".repeat(64);
    for (const url of ["http://outline.example/secret", "https://user:pass@outline.example/secret", "https://outline.example/", "https://outline.example/secret?redirect=evil", "https://outline.example/secret#fragment"]) {
      process.env.OUTLINE_API_URL = url; assert.throws(() => outline.validateOutlineConfig());
    }
    process.env.OUTLINE_API_URL = "https://outline.example/secret";
    axios.create = options => {
      assert.equal(options.baseURL, process.env.OUTLINE_API_URL); assert.equal(options.proxy, false);
      assert.equal(options.maxRedirects, 0); assert.equal(options.maxContentLength, 8 * 1024 * 1024);
      return { get: async route => { assert.equal(route, "/server"); return { data: {} }; } };
    };
    await outline.testOutlineConnection();
    for (const id of ["..", "../server", "https://evil.example", "mock-1"]) {
      await assert.rejects(outline.deleteAccessKey(id)); await assert.rejects(outline.setAccessKeyDataLimit(id, 1));
    }
  } finally {
    axios.create = previous.create;
    if (previous.url === undefined) delete process.env.OUTLINE_API_URL; else process.env.OUTLINE_API_URL = previous.url;
    if (previous.fingerprint === undefined) delete process.env.OUTLINE_API_CERT_SHA256; else process.env.OUTLINE_API_CERT_SHA256 = previous.fingerprint;
  }
});

test("connection responses reject foreign destinations and script/open-redirect URLs", async t => {
  let url;
  const { post } = await mini(t, { expectedOrigin: "https://vpn.example.test", getConnectUrl: async () => url });
  for (url of ["javascript:alert(1)", "https://evil.example/connect/token", "https://vpn.example.test/connect/token?next=https://evil.example", "https://user:pass@vpn.example.test/connect/token"]) {
    const response = await post("connect"); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /evil\.example|javascript:|pass@/);
  }
  url = "https://vpn.example.test/connect/synthetic-token?lang=en";
  assert.equal((await post("connect")).status, 200);
});
