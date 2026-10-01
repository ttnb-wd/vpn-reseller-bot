const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { Temporal } = require("@js-temporal/polyfill");
const { createOrderAccessKey } = require("./outline");
const { prepareDatabaseUrl } = require("./db");
const { Client } = require("pg");
const express = require("express");
const bcrypt = require("bcryptjs");
const { createAdminRouter } = require("./admin-auth");

// Reuse the existing synthetic handler fixture, without registering its tests.
// All provider calls, polling, database writes and timers stay in memory.
const fixturePath = path.join(__dirname, "customer-ui.test.cjs");
const fixtureSource = fs.readFileSync(fixturePath, "utf8");
const fixtureEnd = fixtureSource.indexOf('test("usage sync records');
assert.ok(fixtureEnd > 0);
const fixture = new Module(fixturePath, module);
fixture.filename = fixturePath;
fixture.paths = module.paths;
const syntheticFixture = fixtureSource.slice(0, fixtureEnd).replace(
  "limitCalls.push({ id, bytes });",
  "await options.beforeLimit?.(id, bytes); limitCalls.push({ id, bytes });"
);
fixture._compile(syntheticFixture + "\nmodule.exports = { loadBot };", fixturePath);
const { loadBot } = fixture.exports;

async function pending(bot, message = 1) {
  const pkg = bot.tables.Package[0];
  const version = bot.packageVersion(pkg);
  await bot.action(`confirm_package_${pkg.id}_1_${version}`, 123, message);
  return bot.tables.Order.at(-1);
}

function interceptWhere(table, afterRead) {
  const original = table.where.bind(table);
  table.where = (filter) => {
    const query = original(filter);
    const first = query.first.bind(query);
    query.first = async () => {
      const row = await first();
      await afterRead(row, filter);
      return row;
    };
    return query;
  };
}

test("cross-user Telegram payment and cancellation cannot mutate another customer's order", async () => {
  const bot = await loadBot();
  const order = await pending(bot);
  const before = { ...order };
  await bot.action(`payment_wallet_${order.id}`, 456);
  await bot.action(`cancel_order_${order.id}`, 456);
  assert.deepEqual(order, before);
  assert.equal(bot.keyCalls.length, 0);
});

test("forged Telegram approve and reject do not read or change payment state", async () => {
  const bot = await loadBot();
  const order = await pending(bot);
  const original = bot.client.public.Order.where;
  bot.client.public.Order.where = () => { throw new Error("Unauthorized DB read"); };
  await bot.action(`approve_payment_${order.id}`, 456);
  await bot.action(`reject_payment_${order.id}`, 456);
  bot.client.public.Order.where = original;
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(bot.keyCalls.length, 0);
});

test("concurrent duplicate approve creates one key and one entitlement", async () => {
  const bot = await loadBot();
  const order = await pending(bot);
  await Promise.all([bot.action(`approve_payment_${order.id}`, 999),
    bot.action(`approve_payment_${order.id}`, 999)]);
  assert.equal(order.status, "PAID");
  assert.equal(bot.keyCalls.length, 1);
  assert.equal(bot.tables.Subscription.length, 1);
});

test("restart after subscription persistence and failed PAID write reuses key and exact allowance", async () => {
  const keys = new Map();
  const bot = await loadBot(null, keys);
  const order = await pending(bot);
  const original = bot.client.public.Order.where.bind(bot.client.public.Order);
  let failOnce = true;
  bot.client.public.Order.where = (filter) => {
    const query = original(filter);
    const update = query.updateAll.bind(query);
    query.updateAll = async (data) => {
      if (data.status === "PAID" && failOnce) { failOnce = false; throw new Error("Synthetic DB unavailable"); }
      return update(data);
    };
    return query;
  };
  await bot.action(`approve_payment_${order.id}`, 999);
  assert.equal(order.status, "PROCESSING");
  const before = { ...bot.tables.Subscription[0] };
  order.processingAt = Temporal.Now.instant().subtract({ minutes: 20 });
  const restarted = await loadBot(bot.tables, keys);
  await restarted.action(`approve_payment_${order.id}`, 999);
  assert.equal(order.status, "PAID");
  assert.equal(keys.size, 1);
  assert.equal(restarted.tables.Subscription[0].dataLimitGb, before.dataLimitGb);
  assert.equal(restarted.tables.Subscription[0].expiresAt.toString(), before.expiresAt.toString());
});

test("approval DB lookup outage fails before provisioning and sends no exception detail", async () => {
  const bot = await loadBot();
  const order = await pending(bot);
  bot.client.public.Order.where = () => { throw new Error("postgres://synthetic-private-error"); };
  const ctx = await bot.action(`approve_payment_${order.id}`, 999);
  assert.equal(bot.keyCalls.length, 0);
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.doesNotMatch(JSON.stringify(ctx.replies), /synthetic-private-error/);
});

test("Telegram proof transport uncertainty survives restart without resending", async () => {
  const bot = await loadBot(null, new Map(), { ambiguousMiniPhotoOnce: true });
  const order = await pending(bot);
  order.paymentMethod = "mobile_wallet";
  await assert.rejects(bot.miniAppCallbacks.uploadProof(123, order.orderNumber, Buffer.alloc(30), "image/png"));
  assert.match(order.paymentReference, /^MINI_UPLOAD_V1:/);
  const restarted = await loadBot(bot.tables);
  assert.equal((await restarted.miniAppCallbacks.uploadProof(123, order.orderNumber,
    Buffer.alloc(30), "image/png")).busy, true);
  assert.equal(restarted.sent.filter((item) => item.type === "photo").length, 0);
});

for (const status of [401, 403, 500]) {
  test(`Outline ${status} fails closed without attempting key creation`, async () => {
    let puts = 0;
    const error = { response: { status, data: { code: "SyntheticError" } } };
    const client = { async get() { throw error; }, async put() { puts++; } };
    await assert.rejects(createOrderAccessKey({ id: 7, orderNumber: "VPN-I" + "a".repeat(32) }, { client }),
      (actual) => actual === error);
    assert.equal(puts, 0);
  });
}

test("unclassified Outline 404 is not permission to create a replacement", async () => {
  let puts = 0;
  const error = { response: { status: 404, data: { message: "Route missing" } } };
  await assert.rejects(createOrderAccessKey({ id: 7, orderNumber: "VPN-I" + "a".repeat(32) }, {
    client: { async get() { throw error; }, async put() { puts++; } },
  }), (actual) => actual === error);
  assert.equal(puts, 0);
});

test("Outline lookup timeout cannot fall back to random creation", async () => {
  const error = Object.assign(new Error("Synthetic timeout"), { code: "ETIMEDOUT" });
  let puts = 0;
  await assert.rejects(createOrderAccessKey({ id: 7, orderNumber: "VPN-I" + "a".repeat(32) }, {
    client: { async get() { throw error; }, async put() { puts++; } },
  }), /Synthetic timeout/);
  assert.equal(puts, 0);
});

// These executable regressions deliberately fail while the launch blockers exist.
test("reject must not overwrite an order claimed by approval", async () => {
  const bot = await loadBot();
  const order = await pending(bot);
  let injected = false;
  interceptWhere(bot.client.public.Order, async (row) => {
    if (row?.id === order.id && !injected) { injected = true; order.status = "PROCESSING"; }
  });
  await bot.action(`reject_payment_${order.id}`, 999);
  assert.equal(order.status, "PROCESSING");
});

test("cancel must not overwrite an order claimed by approval", async () => {
  const bot = await loadBot();
  const order = await pending(bot);
  let injected = false;
  interceptWhere(bot.client.public.Customer, async (row) => {
    if (row && !injected) { injected = true; order.status = "PROCESSING"; }
  });
  await bot.action(`cancel_order_${order.id}`, 123);
  assert.equal(order.status, "PROCESSING");
});

test("different orders for one customer must serialize first activation", async () => {
  const bot = await loadBot();
  const first = await pending(bot);
  bot.tables.Order.push({ ...first, id: first.id + 1, orderNumber: "VPN-I" + "b".repeat(32) });
  const second = bot.tables.Order.at(-1);
  let arrivals = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  interceptWhere(bot.client.public.Order, async (row, filter) => {
    if (filter.id && row?.status === "PENDING_PAYMENT" && arrivals < 2) { arrivals++; if (arrivals === 2) release(); await gate; }
  });
  const create = bot.client.public.Subscription.create.bind(bot.client.public.Subscription);
  bot.client.public.Subscription.create = async (data) => {
    if (bot.tables.Subscription.some((row) => row.customerId === data.customerId))
      throw new Error("Synthetic real customerId unique constraint");
    return create(data);
  };
  await Promise.all([bot.action(`approve_payment_${first.id}`, 999),
    bot.action(`approve_payment_${second.id}`, 999)]);
  assert.equal(bot.keyCalls.length, 1);
});

test("external production database URL must not bypass certificate verification", () => {
  const url = "postgres://synthetic:fake@db.example/test?sslmode=require&uselibpqcompat=true";
  let normalized;
  try { normalized = prepareDatabaseUrl(url, "production"); }
  catch { return; } // Rejecting unsafe configuration also satisfies the contract.
  const client = new Client({ connectionString: normalized.toString() });
  assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
});

test("Mini App callbacks isolate order, payment, proof and subscription ownership", async () => {
  const bot = await loadBot();
  const order = await pending(bot);
  await bot.action("my_vpn", 456); // Establish the second customer independently.
  const before = { ...order };
  assert.equal(await bot.miniAppCallbacks.getOrder(456, order.orderNumber), null);
  assert.equal(await bot.miniAppCallbacks.selectPaymentMethod(456, order.orderNumber, "mobile_wallet"), null);
  assert.equal(await bot.miniAppCallbacks.uploadProof(456, order.orderNumber, Buffer.alloc(30), "image/png"), null);
  assert.equal(await bot.miniAppCallbacks.getConnectUrl(456), null);
  assert.deepEqual(order, before);
  assert.equal(bot.sent.filter((item) => item.type === "photo").length, 0);
});

test("parallel wrong passwords must consume separate admin login attempts", async () => {
  const app = express();
  app.use("/admin", createAdminRouter({ email: "synthetic@example.test",
    passwordHash: bcrypt.hashSync("synthetic-correct-password", 10),
    sessionSecret: "synthetic-".repeat(5), production: false }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const attempt = () => fetch(`${base}/admin/login`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base },
    body: new URLSearchParams({ email: "synthetic@example.test", password: "wrong" }) });
  try {
    await Promise.all(Array.from({ length: 8 }, attempt));
    assert.equal((await attempt()).status, 429);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("stale usage scan must not restore a subscription expired by the expiry worker", async () => {
  let armed = false, sub;
  const bot = await loadBot(null, new Map(), { async beforeLimit(_id, bytes) {
    if (!armed || bytes <= 0) return;
    armed = false;
    // Expiry occurs while the positive Outline write is in flight. Simulate
    // the expiry worker completing its zero-limit write and durable revocation
    // before the pending usage write is accepted by Outline.
    const remaining = Number(sub.expiresAt.epochMilliseconds) - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 30));
    sub.revokedAt = Temporal.Now.instant();
  } });
  const order = await pending(bot);
  await bot.action(`approve_payment_${order.id}`, 999);
  sub = bot.tables.Subscription[0];
  sub.expiresAt = Temporal.Now.instant().add({ seconds: 1 });
  bot.setUsage({ [sub.vpnKeyId]: 1000 }, [sub.vpnKeyId]);
  armed = true;
  const start = bot.limitCalls.length;
  await bot.syncUsage();
  assert.equal(bot.limitCalls.slice(start).filter((call) => call.bytes > 0).length, 0);
});


test("two different concurrent renewals retain both purchases on the same key", async () => {
  const bot = await loadBot();
  const first = await pending(bot);
  await bot.action(`approve_payment_${first.id}`, 999);
  const subscription = bot.tables.Subscription[0];
  const beforeExpiry = subscription.expiresAt;
  const beforeData = subscription.dataLimitGb;
  const renewal = await pending(bot, 2);
  bot.tables.Order.push({ ...renewal, id: renewal.id + 1, orderNumber: "VPN-I" + "c".repeat(32) });
  const second = bot.tables.Order.at(-1);
  await Promise.all([bot.action(`approve_payment_${renewal.id}`, 999),
    bot.action(`approve_payment_${second.id}`, 999)]);
  assert.equal(renewal.status, "PAID"); assert.equal(second.status, "PAID");
  assert.equal(subscription.dataLimitGb, beforeData + renewal.totalDataGb + second.totalDataGb);
  assert.equal(subscription.expiresAt.toString(), beforeExpiry.add({ hours: 60 * 24 }).toString());
  assert.equal(bot.keyCalls.length, 1);
});

test("stale approval completion cannot complete a newer claim", async () => {
  const bot = await loadBot(); const order = await pending(bot);
  const original = bot.client.public.Order.where.bind(bot.client.public.Order);
  const newer = Temporal.Now.instant().add({ seconds: 10 });
  bot.client.public.Order.where = filter => {
    const query = original(filter), updateAll = query.updateAll.bind(query);
    query.updateAll = async data => {
      if (data.status === "PAID") order.processingAt = newer;
      return updateAll(data);
    };
    return query;
  };
  await bot.action(`approve_payment_${order.id}`, 999);
  assert.equal(order.status, "PROCESSING"); assert.equal(order.processingAt, newer);
});

test("Telegram duplicate proof and Mini App reservation cannot overwrite an existing proof", async () => {
  const bot = await loadBot(); const order = await pending(bot);
  await bot.action(`payment_wallet_${order.id}`);
  order.paymentReference = "MINI_UPLOAD_V1:synthetic";
  const ctx = bot.ctx(); ctx.message = { photo: [{ file_id: "telegram-new", file_size: 100 }] };
  await bot.events.photo(ctx);
  assert.equal(order.paymentProof, undefined);
  order.paymentReference = null;
  await bot.events.photo(ctx);
  assert.equal(order.paymentProof, "telegram-new");
  await bot.action(`payment_wallet_${order.id}`);
  ctx.message.photo[0].file_id = "telegram-overwrite";
  await bot.events.photo(ctx);
  assert.equal(order.paymentProof, "telegram-new");
});

test("proof conditional save loses safely to cancellation", async () => {
  const bot = await loadBot(); const order = await pending(bot);
  await bot.action(`payment_wallet_${order.id}`);
  const original = bot.client.public.Order.where.bind(bot.client.public.Order);
  bot.client.public.Order.where = filter => {
    const query = original(filter), updateAll = query.updateAll.bind(query);
    query.updateAll = async data => {
      if (data.paymentProof) order.status = "CANCELLED";
      return updateAll(data);
    };
    return query;
  };
  const ctx = bot.ctx(); ctx.message = { photo: [{ file_id: "synthetic", file_size: 100 }] };
  await bot.events.photo(ctx);
  assert.equal(order.status, "CANCELLED"); assert.equal(order.paymentProof, undefined);
  assert.equal(bot.sent.filter(item => item.type === "photo").length, 0);
});

test("shutdown stops polling before drain and prevents a new approval", async () => {
  const bot = await loadBot(); const order = await pending(bot);
  bot.signals.SIGTERM();
  await bot.action(`approve_payment_${order.id}`, 999);
  assert.equal(order.status, "PENDING_PAYMENT"); assert.equal(bot.keyCalls.length, 0);
  await new Promise(setImmediate);
  assert.deepEqual(bot.stopCalls, ["SIGTERM"]);
});

test('cancelled partial activation reconciles its remote checkpoint on the next purchase', async () => {
  const keys = new Map(); const bot = await loadBot(null, keys);
  const order = await pending(bot);
  const original = bot.client.public.Order.where.bind(bot.client.public.Order);
  let failed = false;
  bot.client.public.Order.where = filter => {
    const query = original(filter), update = query.update.bind(query);
    query.update = async data => {
      if (data.vpnKeyId && !failed) { failed = true; throw new Error('Synthetic checkpoint failure'); }
      return update(data);
    };
    return query;
  };
  await bot.action(`approve_payment_${order.id}`, 999);
  assert.equal(keys.size, 1); assert.equal(bot.tables.Subscription.length, 0);
  order.processingAt = Temporal.Now.instant().subtract({ minutes: 20 });
  await bot.recover(); await bot.action(`cancel_order_${order.id}`);
  assert.equal(order.status, 'CANCELLED');
  const next = await pending(bot, 2);
  await bot.action(`approve_payment_${next.id}`, 999);
  assert.equal(next.status, 'PAID'); assert.equal(keys.size, 1);
  assert.equal(bot.tables.Subscription[0].vpnKeyId, `real-test-${order.id}`);
});


test('shutdown clears recovery and usage timers and drains an active approval before closing DB', async () => {
  let entered, release, armed = true;
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const remoteGate = new Promise(resolve => { release = resolve; });
  const bot = await loadBot(null, new Map(), { async beforeLimit() {
    if (armed) { armed = false; entered(); await remoteGate; }
  } });
  const order = await pending(bot);
  const approving = bot.action(`approve_payment_${order.id}`, 999);
  await enteredGate;
  bot.signals.SIGTERM(); await new Promise(setImmediate);
  assert.deepEqual(bot.stopCalls, ['SIGTERM']);
  assert.equal(bot.runtimeCloses.length, 0);
  for (let id = 1; id <= bot.scheduledIntervals.length; id++)
    assert.ok(bot.cancelledIntervals.includes(id), 'Every bot interval must be cleared');
  release(); await approving; await new Promise(setImmediate);
  assert.equal(order.status, 'PAID'); assert.equal(bot.runtimeCloses.length, 1);
  bot.signals.SIGINT(); await new Promise(setImmediate);
  assert.deepEqual(bot.stopCalls, ['SIGTERM']); assert.equal(bot.runtimeCloses.length, 1);
});
