const assert = require("node:assert/strict");
const { test } = require("node:test");
const bcrypt = require("bcryptjs");
const express = require("express");
const { Temporal } = require("@js-temporal/polyfill");
const { createAdminRouter, validateAdminConfig } = require("./admin-auth");
const {
  getOrdersData, getOrderDetail, getOrderProof, getPaymentsData,
} = require("./admin-data");
const { loadTelegramPaymentProof } = require("./admin-proof");

const email = "admin@example.test";
const password = "synthetic-test-password";
const createdAt = Temporal.Instant.from("2026-01-01T00:00:00Z");
const order = {
  id: 7, orderNumber: '<script>order</script>', plan: "Standard", totalDurationDays: 60,
  price: "120000", paymentMethod: "KBZPay", paymentReference: '<img src=x onerror=alert(2)>',
  paymentProof: "telegram-photo-file-id", status: "PENDING_PAYMENT", createdAt,
  paidAt: null, startedAt: null, expiresAt: null, vpnKeyId: "key-7",
  vpnKey: "ss://hidden-order-key",
  customer: {
    telegramId: "123456789", username: '<svg onload=alert(1)>', firstName: "Mya",
  },
  package: { name: '<b>Standard</b>' },
};
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function makeDataApi() {
  const calls = [];
  return {
    calls,
    getOrdersData: async (_client, params) => {
      calls.push({ route: "orders", q: params.q, status: params.status, page: params.page });
      return {
        orders: params.status === "PAID" ? [] : [order], count: 41,
        page: Number(params.page || 1), totalPages: 3,
        q: params.q || "", status: params.status || "all",
      };
    },
    getOrderDetail: async (_client, id) => id === 7 ? order : null,
    getOrderProof: async (_client, id) => id === 7
      ? { paymentProof: order.paymentProof }
      : id === 9 ? { paymentProof: null } : null,
    getPaymentsData: async (_client, params) => {
      calls.push({ route: "payments", status: params.status, page: params.page });
      return {
        orders: params.status === "rejected" ? [] : [order], count: 41,
        page: Number(params.page || 1), totalPages: 3,
        filter: params.status || "all",
      };
    },
  };
}

async function startServer(dataApi, proofLoader = async () => ({ bytes: jpeg, contentType: "image/jpeg" }), proofLogger = () => {}) {
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = validateAdminConfig({
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 10),
    ADMIN_SESSION_SECRET: "synthetic-session-secret-for-order-tests-only",
    NODE_ENV: "test",
  });
  app.use("/admin", createAdminRouter({
    ...config, expectedOrigin: base, getClient: () => ({}), dataApi, proofLoader, proofLogger,
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

test("orders, payments, and proof routes are protected and do not invoke data before login", async (t) => {
  const api = makeDataApi();
  let proofCalls = 0;
  const site = await startServer(api, async () => { proofCalls++; return null; });
  t.after(site.close);
  for (const path of ["/admin/orders", "/admin/orders/7", "/admin/payments", "/admin/payment-proof/7"]) {
    const response = await site.request(path);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin/login");
  }
  assert.equal(api.calls.length, 0);
  assert.equal(proofCalls, 0);
  assert.equal((await site.request("/payment-proof/7")).status, 404);
});

test("orders list searches, filters, paginates, and escapes customer text", async (t) => {
  const api = makeDataApi();
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/orders?q=123456789&status=PENDING_PAYMENT&page=2", {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.deepEqual(api.calls[0], {
    route: "orders", q: "123456789", status: "PENDING_PAYMENT", page: "2",
  });
  for (const value of ["Orders", "60 days", "120,000 MMK", "KBZPay", "Page 2 of 3"]) {
    assert.ok(html.includes(value), value);
  }
  assert.match(html, /q=123456789&amp;status=PENDING_PAYMENT&amp;page=3/);
  assert.match(html, /href="\/admin\/orders\/7"/);
  assert.ok(html.includes("&lt;script&gt;order&lt;/script&gt;"));
  assert.ok(html.includes("&lt;svg onload=alert(1)&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(html.includes("&lt;b&gt;Standard&lt;/b&gt;"));
  assert.equal(html.includes("ss://"), false);
  assert.equal(html.includes(order.paymentProof), false);
  const paid = await site.request("/admin/orders?status=PAID", { headers: { Cookie: cookie } });
  assert.equal(paid.status, 200);
  assert.match(await paid.text(), /No orders match this search/);
});

test("order detail shows a protected slip preview and hides credentials and access keys", async (t) => {
  const site = await startServer(makeDataApi());
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/orders/7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const value of ["Payment Proof", "View Full Slip", "key-7", "123456789", "120,000 MMK"]) {
    assert.ok(html.includes(value), value);
  }
  assert.match(html, /src="\/admin\/payment-proof\/7"/);
  assert.match(response.headers.get("content-security-policy"), /img-src 'self'/);
  assert.equal(html.includes(order.paymentProof), false);
  assert.equal(html.includes("ss://"), false);
  assert.equal(html.includes("BOT_TOKEN"), false);
  assert.ok(html.includes("&lt;svg onload=alert(1)&gt;"));
  assert.equal((await site.request("/admin/orders/8", { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await site.request("/admin/orders/not-an-id", { headers: { Cookie: cookie } })).status, 404);
});

test("historical mock order IDs are marked without exposing access URLs", async (t) => {
  const api = makeDataApi();
  const mockOrder = { ...order, vpnKeyId: "mock-legacy-7" };
  api.getOrdersData = async () => ({
    orders: [mockOrder], count: 1, page: 1, totalPages: 1, q: "", status: "all",
  });
  api.getOrderDetail = async () => mockOrder;
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  for (const path of ["/admin/orders", "/admin/orders/7"]) {
    const response = await site.request(path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Legacy mock · review required/);
    assert.equal(html.includes("ss://"), false);
  }
});

test("payments list shows proof availability, filters, pagination, and working All link", async (t) => {
  const api = makeDataApi();
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/payments?status=all&page=2", {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.deepEqual(api.calls[0], { route: "payments", status: "all", page: "2" });
  assert.match(html, /Proof available<\/dt><dd>Yes<\/dd>/);
  assert.match(html, /View Payment Proof/);
  assert.match(html, /Created at/);
  assert.equal(html.includes("BOT_TOKEN"), false);
  assert.equal(html.includes(process.env.BOT_TOKEN || "SYNTHETIC_TOKEN"), false);
  assert.equal(html.includes("api.telegram.org"), false);
  assert.match(html, /href="\/admin\/payment-proof\/7"/);
  assert.match(html, /href="\/admin\/payments\?status=all&amp;page=3"/);
  assert.match(html, /href="\/admin\/payments\?status=all"/);
  assert.equal(html.includes(order.paymentProof), false);
  assert.equal(html.includes("ss://"), false);
  const rejected = await site.request("/admin/payments?status=rejected", { headers: { Cookie: cookie } });
  assert.equal(rejected.status, 200);
  assert.match(await rejected.text(), /No payments in this view/);
});

test("proof proxy requires a session, returns a private image, and 404s missing proof", async (t) => {
  const calls = [];
  const site = await startServer(makeDataApi(), async (fileId) => {
    calls.push(fileId);
    return { bytes: jpeg, contentType: "image/jpeg" };
  });
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/payment-proof/7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.match(response.headers.get("content-disposition"), /inline/);
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; img-src 'self'; sandbox");
  assert.match(response.headers.get("x-content-type-options"), /nosniff/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
  assert.deepEqual(calls, [order.paymentProof]);
  assert.equal((await site.request("/admin/payment-proof/8", { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await site.request("/admin/payment-proof/9", { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await site.request("/admin/payment-proof/bad-id", { headers: { Cookie: cookie } })).status, 404);
  assert.deepEqual(calls, [order.paymentProof]);
});

test("Telegram file_id is resolved and downloaded only from Telegram's fixed host", async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, "error");
    if (url.endsWith("/getFile")) {
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("file_id"), "telegram-photo-file-id");
      return Response.json({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: jpeg.length } });
    }
    return new Response(jpeg, { headers: { "content-length": String(jpeg.length), "content-type": "image/jpeg" } });
  };
  const proof = await loadTelegramPaymentProof("telegram-photo-file-id", {
    token: "12345:SYNTHETIC_TOKEN", fetchImpl,
  });
  assert.equal(proof.contentType, "image/jpeg");
  assert.deepEqual(proof.bytes, jpeg);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith("https://api.telegram.org/")));

  let fetchCount = 0;
  const hostileFetch = async () => {
    fetchCount++;
    return Response.json({ ok: true, result: { file_path: "https://foreign.example.test/secret.jpg" } });
  };
  await assert.rejects(loadTelegramPaymentProof("telegram-photo-file-id", {
    token: "12345:SYNTHETIC_TOKEN", fetchImpl: hostileFetch,
  }));
  assert.equal(fetchCount, 1);
  await assert.rejects(loadTelegramPaymentProof("telegram-photo-file-id", {
    token: "12345:SYNTHETIC_TOKEN",
    fetchImpl: async () => Response.json({ ok: true, result: {
      file_path: "photos/file_1.jpg", file_size: 20 * 1024 * 1024 + 1,
    } }),
  }));
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
}

test("order and payment queries use bounded pages and omit full VPN keys", async () => {
  const log = [];
  const client = { public: { Order: new QuerySpy("Order", log) } };
  const orders = await getOrdersData(client, { q: "123456789", status: "PENDING_PAYMENT", page: "3" });
  assert.equal(orders.page, 3);
  const orderRead = log.find((query) => query.all);
  assert.equal(orderRead.steps.filter(([step]) => step === "where").length, 2);
  assert.ok(orderRead.steps.some(([step, value]) => step === "offset" && value === 40));
  assert.ok(orderRead.steps.some(([step, value]) => step === "limit" && value === 20));
  await getOrderDetail(client, 7);
  await getOrderProof(client, 7);
  await getPaymentsData(client, { status: "pending", page: "3" });
  const paymentRead = log.filter((query) => query.all).at(-1);
  assert.equal(paymentRead.steps.filter(([step]) => step === "where").length, 2);
  assert.ok(paymentRead.steps.some(([step, value]) => step === "limit" && value === 20));
  assert.equal(JSON.stringify(log).includes('"vpnKey"'), false);
});

class PaymentRows extends QuerySpy {
  constructor(rows, steps = []) { super("Order", [], steps); this.rows = rows; }
  clone(name, value) { return new PaymentRows(this.rows, [...this.steps, [name, value]]); }
  where(predicate) {
    const matches = (expr) => expr.kind === "or" ? expr.exprs.some(matches) : expr.matches;
    const rows = this.rows.filter((row) => typeof predicate === "function"
      ? matches(predicate(new Proxy({}, { get: (_, name) => ({
        isNotNull: () => ({ matches: row[name] != null }),
      }) })))
      : Object.entries(predicate).every(([key, value]) => row[key] === value));
    return new PaymentRows(rows, this.steps);
  }
  aggregate() { return Promise.resolve({ count: this.rows.length }); }
  all() {
    const offset = this.steps.find(([step]) => step === "offset")[1];
    const limit = this.steps.find(([step]) => step === "limit")[1];
    const fields = this.steps.find(([step]) => step === "select")[1];
    return Promise.resolve(this.rows.slice(offset, offset + limit).map((row) => ({
      ...Object.fromEntries(fields.map((field) => [field, row[field]])),
      customer: row.customer, package: row.package,
    })));
  }
}

test("payment query includes pending proofs, processing, paid history and pending without proof", async () => {
  const rows = [
    { ...order, id: 1, paymentMethod: null },
    { ...order, id: 2, status: "PAID" },
    { ...order, id: 3, status: "PROCESSING" },
    { ...order, id: 4, status: "PAYMENT_REJECTED" },
    { ...order, id: 5, paymentProof: null },
    { ...order, id: 6, status: "CANCELLED" },
    { ...order, id: 7, paymentProof: null, paymentMethod: null },
  ];
  const client = { public: { Order: new PaymentRows(rows) } };
  for (const [status, ids] of [[undefined, [1, 2, 3, 4, 5, 6]],
    ["all", [1, 2, 3, 4, 5, 6]], ["pending", [1, 5]], ["paid", [2]],
    ["processing", [3]], ["rejected", [4]]]) {
    const data = await getPaymentsData(client, { status });
    assert.deepEqual(data.orders.map((row) => row.id), ids);
    assert.equal(data.count, ids.length);
    assert.equal(data.filter, status || "all");
    assert.equal(data.orders[0].createdAt, createdAt);
  }
});

test("web default payments renders pending and paid proof records through the real query", async (t) => {
  const rows = [{ ...order }, { ...order, id: 8, status: "PAID", orderNumber: "ORD-PAID" }];
  const api = makeDataApi();
  api.getPaymentsData = (_client, params) => getPaymentsData({ public: { Order: new PaymentRows(rows) } }, params);
  const site = await startServer(api);
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/payments", { headers: { Cookie: cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /ORD-PAID/);
  assert.match(html, /href="\/admin\/payment-proof\/7"/);
  assert.match(html, /href="\/admin\/payment-proof\/8"/);
  assert.match(html, /status=all" class="selected"/);
  assert.equal(html.includes(order.paymentProof), false);
  assert.equal(html.includes(process.env.BOT_TOKEN || "SYNTHETIC_TOKEN"), false);
  assert.equal(html.includes("api.telegram.org"), false);
});

test("invalid Telegram response returns safe 502 and logs only allowed diagnostics", async (t) => {
  const logs = [];
  const site = await startServer(makeDataApi(), (fileId, options) => loadTelegramPaymentProof(fileId, {
    ...options, token: "12345:SYNTHETIC_TOKEN",
    fetchImpl: async () => Response.json({ ok: false, result: {
      file_path: "photos/secret.jpg", description: "12345:SYNTHETIC_TOKEN",
    } }),
  }), (_label, event) => logs.push(event));
  t.after(site.close);
  const cookie = await site.login();
  const response = await site.request("/admin/payment-proof/7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 502);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(await response.text(), "Payment proof is temporarily unavailable.");
  assert.deepEqual(logs, [{ orderId: 7, proofPresent: true },
    { orderId: 7, stage: "get_file", status: 200 },
    { orderId: 7, code: "GET_FILE_INVALID", status: 502 }]);
  assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC_TOKEN|telegram-photo-file-id|secret\.jpg|api\.telegram/);
});

test("proof fetch accepts Telegram binary photo transport only with valid image signature", async () => {
  const options = { token: "12345:SYNTHETIC_TOKEN", fetchImpl: async (url) =>
    url.endsWith("/getFile") ? Response.json({ ok: true, result: { file_path: "photos/a.jpg" } })
      : new Response(jpeg, { headers: { "content-type": "application/octet-stream" } }) };
  assert.deepEqual((await loadTelegramPaymentProof("file-id", options)).bytes, jpeg);
  await assert.rejects(loadTelegramPaymentProof("file-id", { ...options, fetchImpl: async (url) =>
    url.endsWith("/getFile") ? Response.json({ ok: true, result: { file_path: "photos/a.jpg" } })
      : new Response("<html>unsafe</html>", { headers: { "content-type": "application/octet-stream" } }),
  }), { proofCode: "INVALID_IMAGE" });
});

test("proof fetch bounds lookup and image bodies and rejects unsafe paths and MIME types", async () => {
  const token = "12345:SYNTHETIC_TOKEN";
  for (const file_path of ["photos/../a.jpg", "photos//a.jpg", "/photos/a.jpg",
    "https://evil.test/a.jpg", "photos/a.jpg?secret", "documents/a.jpg"]) {
    await assert.rejects(loadTelegramPaymentProof("file-id", { token,
      fetchImpl: async () => Response.json({ ok: true, result: { file_path } }),
    }), { proofCode: "INVALID_FILE_PATH" });
  }
  for (const [response, code] of [
    [() => new Response("x".repeat(8193)), "GET_FILE_TOO_LARGE"],
    [() => new Response("invalid JSON"), "GET_FILE_INVALID"],
    [() => Response.json({ ok: true, result: {} }), "INVALID_FILE_PATH"],
    [() => new Response("error", { status: 503 }), "GET_FILE_FAILED"],
  ]) {
    await assert.rejects(loadTelegramPaymentProof("file-id", { token, fetchImpl: async () => response() }),
      { proofCode: code });
  }
  for (const [download, code] of [
    [() => new Response(jpeg, { headers: { "content-type": "text/html" } }), "UNSUPPORTED_CONTENT_TYPE"],
    [() => new Response(jpeg, { headers: { "content-type": "image/png" } }), "UNSUPPORTED_CONTENT_TYPE"],
    [() => new Response("error", { status: 500 }), "DOWNLOAD_FAILED"],
    [() => new Response(jpeg, { headers: { "content-type": "image/jpeg", "content-length": "20971521" } }), "PROOF_TOO_LARGE"],
    [() => new Response(Buffer.alloc(20971521), { headers: { "content-type": "image/jpeg" } }), "PROOF_TOO_LARGE"],
  ]) {
    await assert.rejects(loadTelegramPaymentProof("file-id", { token, fetchImpl: async (url) =>
      url.endsWith("/getFile") ? Response.json({ ok: true, result: { file_path: "photos/a.jpg" } }) : download(),
    }), { proofCode: code });
  }
  assert.equal(await loadTelegramPaymentProof("file-id", { token,
    fetchImpl: async () => new Response("missing", { status: 404 }),
  }), null);
});
