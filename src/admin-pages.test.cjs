const assert = require("node:assert/strict");
const { test } = require("node:test");
const bcrypt = require("bcryptjs");
const express = require("express");
const { Temporal } = require("@js-temporal/polyfill");
const { createAdminRouter, validateAdminConfig } = require("./admin-auth");
const { getDashboardData, getUsersData, getUserDetail } = require("./admin-data");

const email = "admin@example.test";
const password = "synthetic-test-password";
const now = Temporal.Now.instant();
const createdAt = Temporal.Instant.from("2026-01-01T00:00:00Z");
const customer = {
  id: 7, telegramId: "123456789", username: '<img src=x onerror=alert(1)>',
  firstName: '<script>alert(1)</script>', createdAt,
  subscription: {
    plan: "Standard", status: "ACTIVE", vpnKeyId: "key-7",
    vpnKey: "ss://hidden-subscription-key", dataUsedGb: 35.25,
    dataLimitGb: 200, startedAt: createdAt,
    expiresAt: Temporal.Instant.from("2099-01-01T00:00:00Z"), revokedAt: null,
    package: { name: '<b>Standard</b>' },
  },
  orders: 2,
};
const detail = {
  ...customer,
  orders: [{
    orderNumber: '<script>order</script>', plan: "Standard", price: "120000",
    paymentMethod: '<img src=x onerror=alert(2)>', status: "PAID", createdAt,
    vpnKey: "ss://hidden-order-key", package: { name: '<b>Standard</b>' },
  }],
};

async function startServer(dataApi) {
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = validateAdminConfig({
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 10),
    ADMIN_SESSION_SECRET: "synthetic-session-secret-for-page-tests-only",
    NODE_ENV: "test",
  });
  app.use("/admin", createAdminRouter({
    ...config, expectedOrigin: base, getClient: () => ({}), dataApi,
  }));
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

function dataApi() {
  const calls = [];
  return {
    calls,
    getDashboardData: async () => ({
      totalCustomers: 1234, activeSubscriptions: 9, expiredSubscriptions: 4,
      pendingPayments: 3, totalOrders: 1520, activeVpnKeys: 8,
      totalDataUsedGb: 345.678,
      recentOrders: [{
        orderNumber: '<script>order</script>', plan: "Standard", price: "120000",
        status: "PENDING_PAYMENT", createdAt,
        customer, package: { name: '<b>Standard</b>' },
        vpnKey: "ss://hidden-dashboard-key",
      }],
    }),
    getUsersData: async (_client, params) => {
      calls.push({ q: params.q, status: params.status, page: params.page });
      return {
        customers: params.status === "expired" ? [] : [customer],
        count: 41, page: Number(params.page || 1), totalPages: 3,
        q: params.q || "", status: params.status || "all", now,
      };
    },
    getUserDetail: async (_client, id) => id === 7 ? detail : null,
  };
}

test("dashboard and users routes require login; dashboard renders real supplied counts safely", async (t) => {
  const site = await startServer(dataApi());
  t.after(site.close);
  for (const path of ["/admin", "/admin/users", "/admin/users/7"]) {
    const response = await site.request(path);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin/login");
  }
  const cookie = await site.login();
  const response = await site.request("/admin", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const value of ["1,234", "1,520", "345.68 GB", "Pending Payments", "Recent orders"]) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(html.includes("&lt;script&gt;order&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;Standard&lt;/b&gt;"));
  assert.equal(html.includes("<script>order</script>"), false);
  assert.equal(html.includes("ss://"), false);
  assert.match(html, /href="\/admin\/users"/);
  assert.match(html, /href="\/admin\/orders"/);
  assert.match(html, /href="\/admin\/payments"/);
});

test("users search, status filter, and pagination preserve parameters and escape data", async (t) => {
  const api = dataApi();
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/users?q=Alice&status=active&page=2", {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.deepEqual(api.calls[0], { q: "Alice", status: "active", page: "2" });
  assert.match(html, /Page 2 of 3/);
  assert.match(html, /q=Alice&amp;status=active/);
  assert.match(html, /q=Alice&amp;status=active&amp;page=3/);
  for (const value of ["123456789", "key-7", "35.25 GB", "200 GB", "Order count", "7"]) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("ss://"), false);
  const filtered = await site.request("/admin/users?status=expired", { headers: { Cookie: cookie } });
  assert.equal(filtered.status, 200);
  assert.match(await filtered.text(), /No customers match this search/);
  assert.equal(api.calls[1].status, "expired");
});

test("user detail renders recent orders, returns 404 for missing IDs, and never reveals keys", async (t) => {
  const site = await startServer(dataApi());
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/users/7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const value of ["Customer 7", "key-7", "35.25 GB", "120,000 MMK", "Recent orders"]) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(html.includes("&lt;script&gt;order&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.equal(html.includes("ss://"), false);
  assert.equal((await site.request("/admin/users/8", { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await site.request("/admin/users/not-an-id", { headers: { Cookie: cookie } })).status, 404);
});

test("an invalid VPN key ID value cannot reveal a full access URL", async (t) => {
  const api = dataApi();
  api.getUserDetail = async () => ({
    ...detail, subscription: { ...detail.subscription, vpnKeyId: "ss://accidental-full-key" },
  });
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/users/7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(html.includes("ss://"), false);
  assert.match(html, /VPN key ID<\/dt><dd>-<\/dd>/);
});

class QuerySpy {
  constructor(model, log, steps = []) {
    this.model = model;
    this.log = log;
    this.steps = steps;
  }
  clone(name, value) { return new QuerySpy(this.model, this.log, [...this.steps, [name, value]]); }
  where(value) { return this.clone("where", value); }
  select(...fields) { return this.clone("select", fields); }
  include(name, callback) {
    const child = callback(new QuerySpy(`${this.model}.${name}`, this.log));
    return this.clone("include", [name, child.steps]);
  }
  count() { return this.clone("count", null); }
  orderBy(value) { return this.clone("orderBy", value); }
  offset(value) { return this.clone("offset", value); }
  limit(value) { return this.clone("limit", value); }
  aggregate(selector) {
    const selected = selector({ count: () => "count", sum: (field) => `sum:${field}` });
    this.log.push({ model: this.model, steps: this.steps, selected });
    return Promise.resolve(selected.total ? { total: 12.5 } : { count: 45 });
  }
  all() { this.log.push({ model: this.model, steps: this.steps, all: true }); return Promise.resolve([]); }
  first() { this.log.push({ model: this.model, steps: this.steps, first: true }); return Promise.resolve(null); }
}

test("data queries use bounded projections, aggregates, and server-side pagination", async () => {
  const log = [];
  const client = { public: {
    Customer: new QuerySpy("Customer", log),
    Order: new QuerySpy("Order", log),
    Subscription: new QuerySpy("Subscription", log),
  } };
  const dashboard = await getDashboardData(client);
  assert.equal(dashboard.totalCustomers, 45);
  assert.equal(dashboard.totalDataUsedGb, 12.5);
  assert.ok(log.some((query) => query.model === "Order" && query.steps.some(([step, value]) => step === "limit" && value === 8)));
  assert.ok(log.some((query) => query.model === "Order" && query.selected?.count &&
    query.steps.some(([step, value]) => step === "where" && value.status === "PENDING_PAYMENT") &&
    query.steps.filter(([step]) => step === "where").length === 2));
  assert.ok(log.some((query) => query.model === "Subscription" && query.selected?.count &&
    query.steps.filter(([step]) => step === "where").length === 5));
  const users = await getUsersData(client, { q: "Alice", status: "active", page: "3" });
  assert.equal(users.page, 3);
  const userRead = log.find((query) => query.model === "Customer" && query.all);
  assert.ok(userRead);
  assert.equal(userRead.steps.filter(([step]) => step === "where").length, 2);
  assert.ok(userRead.steps.some(([step, value]) => step === "offset" && value === 40));
  assert.ok(userRead.steps.some(([step, value]) => step === "limit" && value === 20));
  const detailRow = await getUserDetail(client, 7);
  assert.equal(detailRow, null);
  assert.ok(log.some((query) => query.model === "Customer" && query.first &&
    query.steps.some(([step, value]) => step === "where" && value.id === 7)));
  assert.equal(JSON.stringify(log).includes('"vpnKey"'), false);
  assert.equal(JSON.stringify(log).includes('"paymentProof"'), false);
});
