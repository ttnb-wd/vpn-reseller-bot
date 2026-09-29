const assert = require("node:assert/strict");
const { test } = require("node:test");
const bcrypt = require("bcryptjs");
const express = require("express");
const { Temporal } = require("@js-temporal/polyfill");
const { createAdminRouter, validateAdminConfig } = require("./admin-auth");
const {
  getVpnKeysData, getPackagesData, getPackageDetail, validatePackageInput, updatePackage,
} = require("./admin-data");

const email = "admin@example.test";
const password = "synthetic-test-password";
const createdAt = Temporal.Instant.from("2026-01-01T00:00:00Z");
const expiresAt = Temporal.Instant.from("2099-01-01T00:00:00Z");
const subscription = {
  id: 3, plan: "Standard", status: "ACTIVE", vpnKeyId: "key-3",
  vpnKey: "ss://hidden-subscription-access-key", vpnKeyCreatedAt: createdAt,
  dataUsedGb: 35.25, dataLimitGb: 200, startedAt: createdAt, expiresAt, revokedAt: null,
  customer: { id: 7, telegramId: "123456789", username: '<img src=x onerror=alert(1)>',
    firstName: '<script>alert(1)</script>' },
  package: { name: '<b>Standard</b>' },
};
const pkg = {
  id: 8, name: '<script>Package</script>', dataLimitGb: 200,
  durationDays: 30, priceMmk: "12000.50", active: true, sortOrder: 2,
  createdAt, updatedAt: createdAt,
};

function makeApi() {
  const calls = [];
  const packageRow = { ...pkg };
  return {
    calls, packageRow,
    getVpnKeysData: async (_client, params) => {
      calls.push({ route: "keys", q: params.q, status: params.status, page: params.page });
      return { subscriptions: params.status === "missing"
        ? [{ ...subscription, vpnKeyId: null }] : [subscription], count: 41,
        page: Number(params.page || 1), totalPages: 3, q: params.q || "",
        status: params.status || "all", now: Temporal.Now.instant() };
    },
    getPackagesData: async (_client, params) => {
      calls.push({ route: "packages", page: params.page });
      return { packages: [packageRow], count: 21, page: Number(params.page || 1), totalPages: 2 };
    },
    getPackageDetail: async (_client, id) => id === 8 ? packageRow : null,
    validatePackageInput,
    updatePackage: async (_client, id, values) => {
      calls.push({ route: "update", id, values });
      Object.assign(packageRow, values);
    },
  };
}

async function startServer(dataApi) {
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = validateAdminConfig({
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 10),
    ADMIN_SESSION_SECRET: "synthetic-session-secret-for-step-five-tests",
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

function formToken(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)[1];
}

test("VPN Keys and Packages routes require admin authentication", async (t) => {
  const api = makeApi();
  const site = await startServer(api);
  t.after(site.close);
  for (const path of ["/admin/vpn-keys", "/admin/packages", "/admin/packages/8/edit"]) {
    const response = await site.request(path);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin/login");
  }
  const response = await site.request("/admin/packages/8/edit", { method: "POST" });
  assert.equal(response.status, 303);
  assert.equal(api.calls.length, 0);
});

test("VPN Keys renders only safe IDs with search, filters, and pagination", async (t) => {
  const api = makeApi();
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/vpn-keys?q=123456789&status=active&page=2", {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.deepEqual(api.calls[0], { route: "keys", q: "123456789", status: "active", page: "2" });
  for (const value of ["key-3", "35.25 GB", "200 GB", "Page 2 of 3", "Key created at"]) {
    assert.ok(html.includes(value), value);
  }
  assert.match(html, /q=123456789&amp;status=active&amp;page=3/);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;Standard&lt;/b&gt;"));
  assert.equal(html.includes("ss://"), false);
  assert.equal(html.includes("BOT_TOKEN"), false);
  const missing = await site.request("/admin/vpn-keys?status=missing", { headers: { Cookie: cookie } });
  assert.equal(missing.status, 200);
  const missingHtml = await missing.text();
  assert.match(missingHtml, /Missing/);
  assert.equal(missingHtml.includes("ss://"), false);
  for (const status of ["expired", "revoked"]) {
    const filtered = await site.request(`/admin/vpn-keys?status=${status}`, { headers: { Cookie: cookie } });
    assert.equal(filtered.status, 200);
    assert.equal(api.calls.at(-1).status, status);
  }
});

test("Packages list and edit page render database values and escape the package name", async (t) => {
  const api = makeApi();
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/packages?page=2", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.deepEqual(api.calls[0], { route: "packages", page: "2" });
  for (const value of ["200 GB", "30 days", "12,000.5 MMK", "Page 2 of 2", "Sort order"]) {
    assert.ok(html.includes(value), value);
  }
  assert.match(html, /href="\/admin\/packages\/8\/edit"/);
  assert.ok(html.includes("&lt;script&gt;Package&lt;/script&gt;"));
  assert.equal(html.includes("<script>Package</script>"), false);
  assert.equal(html.includes("ss://"), false);
  const edit = await site.request("/admin/packages/8/edit", { headers: { Cookie: cookie } });
  assert.equal(edit.status, 200);
  const editHtml = await edit.text();
  assert.match(editHtml, /name="priceMmk" value="12000.50"/);
  assert.match(editHtml, /name="_csrf" value="/);
  assert.equal((await site.request("/admin/packages/999/edit", { headers: { Cookie: cookie } })).status, 404);
});

test("valid package edit updates only Package and redirects to a success message", async (t) => {
  const api = makeApi();
  const site = await startServer(api);
  t.after(site.close);
  const sessionCookie = await site.login();
  const edit = await site.request("/admin/packages/8/edit", { headers: { Cookie: sessionCookie } });
  const token = formToken(await edit.text());
  const formCookie = edit.headers.get("set-cookie").split(";")[0];
  const response = await site.request("/admin/packages/8/edit", {
    method: "POST", headers: { Cookie: `${sessionCookie}; ${formCookie}`, Origin: site.base },
    body: new URLSearchParams({ _csrf: token, name: "  New Plan  ", dataLimitGb: "250.5",
      durationDays: "45", priceMmk: "14000.25", active: "false", sortOrder: "-3" }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/packages?saved=1");
  const update = api.calls.find((call) => call.route === "update");
  assert.equal(update.id, 8);
  assert.deepEqual(update.values, { name: "New Plan", dataLimitGb: 250.5,
    durationDays: 45, priceMmk: "14000.25", active: false, sortOrder: -3 });
  assert.equal(api.packageRow.name, "New Plan");
  assert.equal(api.calls.some((call) => call.route === "order" || call.route === "subscription"), false);
  const saved = await site.request("/admin/packages?saved=1", { headers: { Cookie: sessionCookie } });
  assert.match(await saved.text(), /Package changes saved/);
});

test("invalid edits preserve input and cannot update; origin and signed CSRF token are required", async (t) => {
  const api = makeApi();
  const site = await startServer(api);
  t.after(site.close);
  const sessionCookie = await site.login();
  const edit = await site.request("/admin/packages/8/edit", { headers: { Cookie: sessionCookie } });
  const token = formToken(await edit.text());
  const formCookie = edit.headers.get("set-cookie").split(";")[0];
  const cookies = `${sessionCookie}; ${formCookie}`;
  const invalid = { _csrf: token, name: '<img src=x onerror=alert(2)>', dataLimitGb: "0",
    durationDays: "1.5", priceMmk: "-2", active: "yes", sortOrder: "100001" };
  const response = await site.request("/admin/packages/8/edit", {
    method: "POST", headers: { Cookie: cookies, Origin: site.base },
    body: new URLSearchParams(invalid),
  });
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /Data limit must be greater than 0/);
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.equal(html.includes('<img src=x onerror=alert(2)>'), false);
  assert.equal(api.calls.some((call) => call.route === "update"), false);
  const foreign = await site.request("/admin/packages/8/edit", {
    method: "POST", headers: { Cookie: cookies, Origin: "https://foreign.example.test" },
    body: new URLSearchParams({ ...invalid, dataLimitGb: "100" }),
  });
  assert.equal(foreign.status, 403);
  const noToken = await site.request("/admin/packages/8/edit", {
    method: "POST", headers: { Cookie: cookies, Origin: site.base },
    body: new URLSearchParams({ ...invalid, _csrf: "" }),
  });
  assert.equal(noToken.status, 403);
  assert.equal(api.calls.some((call) => call.route === "update"), false);
});

class QuerySpy {
  constructor(model, log, steps = []) { this.model = model; this.log = log; this.steps = steps; }
  clone(name, value) { return new QuerySpy(this.model, this.log, [...this.steps, [name, value]]); }
  where(value) { return this.clone("where", value); }
  select(...fields) { return this.clone("select", fields); }
  include(name, callback) {
    const child = callback(new QuerySpy(`${this.model}.${name}`, this.log));
    return this.clone("include", [name, child.steps]);
  }
  orderBy(value) { return this.clone("orderBy", value); }
  offset(value) { return this.clone("offset", value); }
  limit(value) { return this.clone("limit", value); }
  aggregate(selector) {
    this.log.push({ model: this.model, steps: this.steps, aggregate: true });
    selector({ count: () => "count" });
    return Promise.resolve({ count: 45 });
  }
  all() { this.log.push({ model: this.model, steps: this.steps, all: true }); return Promise.resolve([]); }
  first() { this.log.push({ model: this.model, steps: this.steps, first: true }); return Promise.resolve(null); }
  update(values) { this.log.push({ model: this.model, steps: this.steps, update: values }); return Promise.resolve(); }
}

test("database queries are paginated and never select vpnKey; edits touch only Package", async () => {
  const log = [];
  const client = { public: {
    Subscription: new QuerySpy("Subscription", log), Package: new QuerySpy("Package", log),
  } };
  const keys = await getVpnKeysData(client, { q: "key-3", status: "active", page: "3" });
  assert.equal(keys.page, 3);
  const keyRead = log.find((entry) => entry.model === "Subscription" && entry.all);
  assert.ok(keyRead.steps.some(([step, value]) => step === "offset" && value === 40));
  assert.ok(keyRead.steps.some(([step, value]) => step === "limit" && value === 20));
  assert.equal(JSON.stringify(keyRead).includes('"vpnKey"'), false);
  const packages = await getPackagesData(client, { page: "2" });
  assert.equal(packages.page, 2);
  assert.ok(log.find((entry) => entry.model === "Package" && entry.all)
    .steps.some(([step, value]) => step === "limit" && value === 20));
  await getPackageDetail(client, 8);
  const valid = validatePackageInput({ name: "A", dataLimitGb: "1", durationDays: "30",
    priceMmk: "0", active: "true", sortOrder: "0" });
  assert.deepEqual(valid.errors, []);
  await updatePackage(client, 8, valid.values);
  const updates = log.filter((entry) => entry.update);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].model, "Package");
  assert.equal(JSON.stringify(log).includes('"vpnKey"'), false);
});
