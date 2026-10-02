const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const vm = require("node:vm");
const { Temporal } = require("@js-temporal/polyfill");
const { currentMonth, monthBounds, permittedMonth, SALES_SQL, getSalesSummary } = require("./admin-sales");
const { createAdminSalesEvents, publishSaleAfterPaidUpdate } = require("./admin-sales-events");
const { createAdminRouter, validateAdminConfig } = require("./admin-auth");
const { renderDashboard } = require("./admin-ui");

const october = [
  { status: "PAID", paidAt: "2026-09-30T17:29:59Z", plan: "100 GB - 30 Days", durationMonths: 1, price: "7000" },
  { status: "PAID", paidAt: "2026-09-30T17:30:00Z", plan: "100 GB - 30 Days", durationMonths: 1, price: "5000" },
  { status: "PAID", paidAt: "2026-10-12T00:00:00Z", plan: "100 GB - 30 Days", durationMonths: 1, price: "5000" },
  { status: "PAID", paidAt: "2026-10-13T00:00:00Z", plan: "200 GB - 90 Days", durationMonths: 3, price: "15000" },
  { status: "PENDING_PAYMENT", paidAt: null, plan: "100 GB - 30 Days", durationMonths: 1, price: "99999" },
  { status: "PROCESSING", paidAt: null, plan: "100 GB - 30 Days", durationMonths: 1, price: "99999" },
  { status: "PAYMENT_REJECTED", paidAt: null, plan: "100 GB - 30 Days", durationMonths: 1, price: "99999" },
  { status: "CANCELLED", paidAt: null, plan: "100 GB - 30 Days", durationMonths: 1, price: "99999" },
  { status: "FAILED", paidAt: null, plan: "100 GB - 30 Days", durationMonths: 1, price: "99999" },
  { status: "PAID", paidAt: "2026-10-31T17:30:00Z", plan: "100 GB - 30 Days", durationMonths: 1, price: "9000" },
];

function queryFixture(orders) {
  return async (sql, [start, end]) => {
    assert.equal(sql, SALES_SQL);
    assert.match(sql, /WHERE "status" = 'PAID'/);
    assert.match(sql, /SUM\("price"\)/);
    const groups = new Map();
    let total = 0n;
    let count = 0;
    for (const order of orders) {
      if (order.status !== "PAID" || !order.paidAt || order.paidAt < start || order.paidAt >= end) continue;
      const key = `${order.plan}:${order.durationMonths}`;
      const item = groups.get(key) || { package: order.plan, duration_months: order.durationMonths,
        quantity: "0", revenue: "0", grand_total: 0 };
      item.quantity = String(Number(item.quantity) + 1);
      item.revenue = String(BigInt(item.revenue) + BigInt(order.price));
      groups.set(key, item);
      total += BigInt(order.price); count++;
    }
    return { rows: [...groups.values(), { package: null, duration_months: null,
      quantity: String(count), revenue: String(total), grand_total: 3 }] };
  };
}

test("sales use PAID and paidAt, Yangon month boundaries, order price snapshot and one count per order", async () => {
  assert.deepEqual(monthBounds("2026-10"), {
    start: "2026-09-30T17:30:00Z", end: "2026-10-31T17:30:00Z",
  });
  assert.equal(currentMonth(Temporal.Instant.from("2026-09-30T18:00:00Z")), "2026-10");
  const data = await getSalesSummary("2026-10", queryFixture(october));
  assert.deepEqual(data.period, { month: "2026-10", timezone: "Asia/Yangon" });
  assert.equal(data.totalRevenue, "25000");
  assert.equal(data.paidOrders, 3);
  assert.deepEqual(data.packages, [
    { package: "100 GB - 30 Days", quantity: 2, revenue: "10000" },
    { package: "200 GB - 90 Days", quantity: 1, revenue: "15000" },
  ]);
  assert.equal(data.packages.reduce((sum, item) => sum + BigInt(item.revenue), 0n), BigInt(data.totalRevenue));
  assert.equal(data.packages.reduce((sum, item) => sum + item.quantity, 0), data.paidOrders);
});

test("empty month and month validation are safe", async () => {
  const data = await getSalesSummary("2026-10", queryFixture([]));
  assert.deepEqual([data.totalRevenue, data.paidOrders, data.packages], ["0", 0, []]);
  const now = Temporal.Instant.from("2026-10-02T00:00:00Z");
  assert.equal(permittedMonth("2026-10", now) !== null, true);
  assert.equal(permittedMonth("2024-10", now), null);
  assert.equal(permittedMonth("2026-11", now), null);
  for (const value of ["2026-00", "2026-13", "2026-10-01", "junk", ["2026-10"]]) {
    assert.equal(permittedMonth(value, now), null);
  }
});

test("only a committed first PAID update invalidates sales; failed and duplicate approvals do not", () => {
  let notifications = 0;
  const events = { publishSale: () => { notifications++; } };
  publishSaleAfterPaidUpdate([{ id: 1 }], { status: "PAID" }, events);
  publishSaleAfterPaidUpdate([], { status: "PAID" }, events);
  publishSaleAfterPaidUpdate([{ id: 2 }], { status: "PAYMENT_REJECTED" }, events);
  publishSaleAfterPaidUpdate([{ id: 3 }], { status: "PROCESSING" }, events);
  assert.equal(notifications, 1);
});

test("dashboard formats MMK exactly, refreshes on SSE, and retains last data on disconnect", async () => {
  let html;
  const res = { set() { return this; }, type() { return this; }, send(value) { html = value; return this; } };
  renderDashboard(res, "admin@example.test", "token", { totalCustomers: 0,
    activeSubscriptions: 0, expiredSubscriptions: 0, pendingPayments: 0,
    totalOrders: 0, activeVpnKeys: 0, totalDataUsedGb: 0, recentOrders: [] }, "2026-10");
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { textContent: "", children: [],
      value: "2026-10", selectedOptions: [{ textContent: "October 2026" }],
      addEventListener(name, fn) { this[name] = fn; },
      replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } });
    return elements.get(id);
  }
  let source;
  let interval;
  let calls = 0;
  const summary = { totalRevenue: "9007199254740993", paidOrders: 2,
    packages: [{ package: "100 GB - 30 Days", quantity: 2, revenue: "9007199254740993" }] };
  const context = { document: { getElementById: element,
    createElement: () => ({ textContent: "", children: [], append(...children) { this.children.push(...children); } }) },
    window: { setInterval(fn) { interval = fn; }, addEventListener() {} },
    EventSource: class { constructor() { source = this; } addEventListener(name, fn) { this[name] = fn; } close() {} },
    fetch: async () => { calls++; return { ok: calls < 4, json: async () => summary }; },
    encodeURIComponent, BigInt, Number, String };
  vm.runInNewContext(script, context);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(element("sales-revenue").textContent, "9,007,199,254,740,993 MMK");
  assert.equal(element("sales-orders").textContent, "2");
  assert.equal(element("sales-packages").children.length, 1);
  source["sales-change"]();
  await flush();
  assert.equal(element("sales-orders").textContent, "2");
  interval();
  await flush();
  assert.equal(element("sales-orders").textContent, "2");
  source["sales-change"]();
  await flush();
  assert.equal(element("sales-revenue").textContent, "9,007,199,254,740,993 MMK");
  assert.match(element("sales-state").textContent, /temporarily unavailable/);
});

test("authenticated admin API and SSE require session; events follow successful sale only", async (t) => {
  const events = createAdminSalesEvents({ heartbeatMs: 100000 });
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => { events.closeAll(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = validateAdminConfig({ ADMIN_EMAIL: "admin@example.test",
    ADMIN_PASSWORD_HASH: bcrypt.hashSync("synthetic-password", 10),
    ADMIN_SESSION_SECRET: "synthetic-session-secret-for-sales-tests", NODE_ENV: "test" });
  app.use("/admin", createAdminRouter({ ...config, expectedOrigin: base, salesEvents: events,
    salesMonthAllowed: (month) => month === "2026-10" ? monthBounds(month) : null,
    getClient: () => ({}), getSalesSummary: (month) => getSalesSummary(month, queryFixture(october)),
    dataApi: { getDashboardData: async () => ({ totalCustomers: 0, activeSubscriptions: 0,
      expiredSubscriptions: 0, pendingPayments: 0, totalOrders: 0, activeVpnKeys: 0,
      totalDataUsedGb: 0, recentOrders: [] }) },
  }));
  assert.equal((await fetch(base + "/admin/api/sales-summary?month=2026-10", { redirect: "manual" })).status, 401);
  assert.equal((await fetch(base + "/admin/events/sales", { redirect: "manual" })).status, 401);
  const login = await fetch(base + "/admin/login", { method: "POST", redirect: "manual",
    headers: { Origin: base }, body: new URLSearchParams({ email: "admin@example.test", password: "synthetic-password" }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const home = await fetch(base + "/admin", { headers: { Cookie: cookie } });
  const html = await home.text();
  assert.match(html, /Sales Overview[\s\S]*Package Sales/);
  assert.match(html, /<select id="sales-month">/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script);
  const response = await fetch(base + "/admin/api/sales-summary?month=2026-10", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).totalRevenue, "25000");
  assert.equal((await fetch(base + "/admin/api/sales-summary?month=bogus", { headers: { Cookie: cookie } })).status, 400);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(base + "/admin/events/sales", { headers: { Cookie: cookie, Origin: base }, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const reader = stream.body.getReader();
  await reader.read(); // connected comment
  assert.equal(events.subscriberCount(), 1);
  events.publishSale();
  const message = new TextDecoder().decode((await reader.read()).value);
  assert.match(message, /event: sales-change/);
  assert.doesNotMatch(message, /25000|telegram|vpn/i);
  controller.abort();
});

test("disposable PostgreSQL sales aggregation uses real numeric SUM and Yangon bounds",
  { skip: !process.env.NOTIFICATION_TEST_DATABASE_URL }, async () => {
    const url = new URL(process.env.NOTIFICATION_TEST_DATABASE_URL);
    assert.ok(!url.searchParams.has("host") && !url.searchParams.has("hostaddr") && !url.searchParams.has("port"));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.ok(/^\d+$/.test(url.port) && url.port !== "5432");
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const month = currentMonth();
      const before = await getSalesSummary(month, client.query.bind(client));
      const id = crypto.randomUUID();
      const customer = await client.query('INSERT INTO public."customer" ("telegramId") VALUES ($1) RETURNING id', [`sales-test-${id}`]);
      const paidAt = Temporal.Instant.from(monthBounds(month).start).add({ seconds: 1 }).toString();
      await client.query(`INSERT INTO public."order" ("orderNumber", "plan", "durationMonths", "price", "status", "paidAt", "customerId")
        VALUES ($1, $2, 3, 5000, 'PAID', $3::timestamptz, $4)`, [
        `SALES-${id}`, `Synthetic 100 GB - 90 Days ${id}`, paidAt, customer.rows[0].id,
      ]);
      const after = await getSalesSummary(month, client.query.bind(client));
      assert.equal(BigInt(after.totalRevenue) - BigInt(before.totalRevenue), 5000n);
      assert.equal(after.paidOrders - before.paidOrders, 1);
      assert.deepEqual(after.packages.find((item) => item.package.endsWith(id)), {
        package: `Synthetic 100 GB - 90 Days ${id}`, quantity: 1, revenue: "5000",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
