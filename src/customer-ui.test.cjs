const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { Temporal } = require("@js-temporal/polyfill");
const { updatePackage } = require("./admin-data");

// Exercise the real registered handlers using synthetic data, without polling
// Telegram or connecting to production PostgreSQL / Outline.
async function loadBot(existingTables = null, outlineKeys = new Map(), options = {}) {
  const file = path.join(__dirname, "bot.js");
  const source = readFileSync(file, "utf8");
  const localRequire = createRequire(file);
  const tables = existingTables || {
    Customer: [], Order: [], Subscription: [], SupportTicket: [], SupportMessage: [],
    Package: [
      { id: 7, name: "Basic", dataLimitGb: 50, durationDays: 30, priceMmk: "3200", active: true, sortOrder: 1 },
      { id: 19, name: "Standard", dataLimitGb: 213, durationDays: 31, priceMmk: "7650", active: true, sortOrder: 2 },
      { id: 25, name: "Premium", dataLimitGb: 400, durationDays: 32, priceMmk: "12000", active: true, sortOrder: 3 },
      { id: 99, name: "Retired", active: false, sortOrder: 4 },
    ],
  };
  existingTables && (tables.SupportMessage ||= []);
  if (!tables.notificationAttempts) Object.defineProperty(tables, "notificationAttempts", { value: [], enumerable: false });
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) =>
    row[key] === value || value === null && row[key] == null);
  const predicateFor = (filter) => typeof filter === "function"
    ? filter(new Proxy({}, { get: (_target, field) => ({
      isNull: () => (row) => row[field] == null,
    }) }))
    : (row) => matches(row, filter);
  const lockTails = new Map();
  const coordination = options.coordination || { owned: true, async acquire() { return true; },
    async release() { this.owned = false; }, async close() {},
    async customer(id, work) {
      const previous = lockTails.get(id) || Promise.resolve();
      let release;
      const next = new Promise(resolve => { release = resolve; });
      lockTails.set(id, next);
      await previous;
      try { return await work(() => {}); }
      finally { release(); if (lockTails.get(id) === next) lockTails.delete(id); }
    } };
  const client = { public: {} };
  for (const [name, rows] of Object.entries(tables)) {
    const create = (data) => {
      const row = { id: rows.length + 1, createdAt: Temporal.Now.instant(), ...data };
      rows.push(row);
      return row;
    };
    client.public[name] = {
      async create(data) { return create(data); },
      async upsert({ conflictOn, create: data, update }) {
        const filter = Object.fromEntries(Object.keys(conflictOn).map((key) => [key, data[key]]));
        const row = rows.find((row) => matches(row, filter));
        if (row) { Object.assign(row, update); return { ...row }; }
        return { ...create(data) };
      },
      where(filter) {
        const predicates = [predicateFor(filter)];
        const selected = () => rows.filter((row) => predicates.every((predicate) => predicate(row)));
        const query = {
          where(nextFilter) { predicates.push(predicateFor(nextFilter)); return this; },
          async first() { const row = selected()[0]; return row ? { ...row } : null; },
          async all() { return selected().map((row) => ({ ...row })); },
          orderBy() { return this; },
          limit() { return this; },
          async update(data) {
            const row = selected()[0];
            assert.ok(row, `Missing ${name} for update`);
            Object.assign(row, data);
            return { ...row };
          },
          async updateAll(data) {
            return selected().map((row) => { Object.assign(row, data); return { ...row }; });
          },
        };
        return query;
      },
    };
  }
  const handlers = [];
  const events = {};
  const sent = [];
  const menuButtonCalls = [];
  const menuButtonReads = [];
  const launchCalls = [];
  const stopCalls = [];
  const signals = {};
  const exits = [];
  const runtimeCloses = [];
  const serverCloses = [];
  const expiryStarts = [], expiryStops = [];
  const errors = [];
  const keyCalls = [];
  const limitCalls = [];
  const missingKeys = new Set();
  let failZeroLimitOnce = false;
  let miniAppCallbacks;
  let usageByKeyId = {};
  let metricsCalls = 0;
  let metricsGate = null;
  const scheduledIntervals = [];
  const cancelledIntervals = [];
  let existingKeyIds = new Set();
  let metricsUnavailable = false;
  let rejectMiniPhotoOnce = Boolean(options.rejectMiniPhotoOnce);
  let ambiguousMiniPhotoOnce = Boolean(options.ambiguousMiniPhotoOnce);
  const fakeApp = options.realHttp ? localRequire("express")() : {
    set() {}, get() {}, use() {}, disable() {},
    listen() {
      const server = new EventEmitter();
      server.close = (done) => { serverCloses.push(true); done(); };
      queueMicrotask(() => server.emit("listening"));
      return server;
    },
  };
  class FakeTelegraf {
    constructor() {
      this.telegram = {
        async callApi(method, payload) {
          assert.equal(method, "sendMessage");
          const { chat_id, text, ...extra } = payload;
          sent.push({ type: "message", args: [chat_id, text, extra] });
          return { message_id: sent.length };
        },
        async sendMessage(...args) { sent.push({ type: "message", args }); return { message_id: sent.length }; },
        async sendPhoto(...args) {
          if (typeof args[1] !== "string" && rejectMiniPhotoOnce) {
            rejectMiniPhotoOnce = false;
            throw Object.assign(new Error("Synthetic Telegram rejection"),
              { response: { error_code: 400 } });
          }
          sent.push({ type: "photo", args });
          if (typeof args[1] !== "string" && ambiguousMiniPhotoOnce) {
            ambiguousMiniPhotoOnce = false;
            throw new Error("Synthetic transport ambiguity");
          }
          return { message_id: sent.length, photo: [{ file_id: typeof args[1] === "string"
            ? args[1] : `mini-upload-${sent.length}` }] };
        },
        async editMessageReplyMarkup(...args) { sent.push({ type: "editMarkup", args }); },
        async setChatMenuButton(request) {
          menuButtonCalls.push(request);
          if (options.menuWriteFails) throw new Error("Temporary Telegram menu failure");
          return true;
        },
        async getChatMenuButton(request) {
          menuButtonReads.push(request);
          if (options.menuReadFails) throw new Error("Temporary Telegram menu failure");
          return menuButtonCalls.at(-1)?.menuButton;
        },
      };
    }
    start(fn) { events.start = fn; }
    command() {}
    action(pattern, fn) { handlers.push({ pattern, fn }); }
    on(event, fn) { events[event] = fn; }
    catch() {}
    async launch(_config, onLaunch) {
      launchCalls.push(true);
      onLaunch?.();
      if (options.pollingStaysActive) await new Promise(() => {});
    }
    stop(signal) { stopCalls.push(signal); }
  }
  const context = vm.createContext({
    __dirname: __dirname,
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "./singleton-startup" && options.ownershipTimers) return {
        ...localRequire(name),
        createSingletonStartup(args) { return localRequire(name).createSingletonStartup({
          ...args, ...options.ownershipTimers }); },
      };
      if (name === "./coordination" && options.captureLoss) return {
        createCoordination(args) { options.captureLoss(args.onLost); return coordination; },
      };
      if (name === "./notification-store") return { createNotificationStore() {
        return localRequire("./notification-test-fixture.cjs").createMemoryStore(tables.Subscription, tables.notificationAttempts, tables.Order);
      } };
      if (name === "./mini-app") return { createMiniAppRouter(args) {
        miniAppCallbacks = args;
        return options.realHttp ? localRequire(name).createMiniAppRouter(args) : () => {};
      } };
      if (name === "./expiry-worker") return { createExpiryWorker() {
        return { start() { expiryStarts.push(true); }, stop() { expiryStops.push(true); },
          stopScheduling() {} };
      } };
      if (name === "express") return () => fakeApp;
      if (name === "telegraf") return { ...localRequire(name), Telegraf: FakeTelegraf };
      if (name === "./db") return { async createDatabase() {
        return { client, coordination: options.captureLoss ? undefined : coordination,
          runtime: { async close() { runtimeCloses.push(true); } } };
      } };
      if (name === "./admin-auth") return {
        validateAdminConfig() { return { email: "admin@example.test" }; },
        createAdminRouter() { return () => {}; },
      };
      if (name === "./safe-diagnostics") return {
        ...localRequire(name),
        logHandlerFailure(handler, error) {
          errors.push(["Telegram handler failed:", localRequire(name).describeHandlerFailure(handler, error)]);
        },
      };
      if (name === "./telegram-admin" && options.adminDataApi) return {
        createTelegramAdmin(args) {
          return localRequire(name).createTelegramAdmin({ ...args, dataApi: options.adminDataApi });
        },
      };
      if (name === "./outline") return {
        validateOutlineConfig() {}, async testOutlineConnection() {},
        async getAllAccessKeyUsage() {
          metricsCalls++;
          if (metricsGate) await metricsGate;
          if (metricsUnavailable) throw new Error("Private management URL");
          return usageByKeyId;
        },
        async getExistingAccessKeyIds() { return existingKeyIds; },
        async createOrderAccessKey(order) {
          if (outlineKeys.has(order.id)) return outlineKeys.get(order.id);
          keyCalls.push(order.id);
          const key = { id: `real-test-${order.id}`,
            accessUrl: `ss://synthetic@192.0.2.1:1234#${order.id}` };
          outlineKeys.set(order.id, key);
          return key;
        },
        async setAccessKeyDataLimit(id, bytes) {
          limitCalls.push({ id, bytes });
          if (bytes === 0 && failZeroLimitOnce) {
            failZeroLimitOnce = false;
            throw new Error("synthetic Outline failure");
          }
          if (missingKeys.has(id)) throw Object.assign(new Error("Missing"), { missing: true });
        },
        isAccessKeyNotFoundError(error) { return error.missing === true; },
      };
      return localRequire(name);
    },
    process: {
      env: { PORT: "0", ADMIN_TELEGRAM_ID: "999", PUBLIC_BASE_URL: "https://vpn.example.test", CONNECT_TOKEN_SECRET: "test-secret-".repeat(4) },
      once(signal, handler) { signals[signal] = handler; },
      exit(code) { exits.push(code); },
    },
    Buffer, URL, AbortSignal, setTimeout, clearTimeout,
    clearInterval(id) { cancelledIntervals.push(id); },
    setInterval(fn, ms) { scheduledIntervals.push({ fn, ms }); return scheduledIntervals.length; },
    console: { log() {}, error(...args) { errors.push(args); }, warn() {} }, module: { exports: {} },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("\nstartBot().catch(")) + `
    module.exports = { startBot, recoverStuckProcessingOrders, syncAccessKeyUsage,
      miniAppCreateOrder, packageVersion, app, getServer: () => server,
      getState: () => singletonStartup.state };
  `, context, { filename: file });
  await context.module.exports.startBot();
  await new Promise(setImmediate);

  function ctx(userId = 123, messageId = 1) {
    const replies = [];
    return {
      from: { id: userId, first_name: "Test" }, replies,
      chat: { id: userId, type: "private" },
      callbackQuery: { message: { chat: { id: userId }, message_id: messageId } },
      async answerCbQuery() {}, async editMessageCaption() {}, async replyWithPhoto() {},
      async reply(...args) { replies.push(args); },
    };
  }
  async function action(data, userId = 123, messageId = 1) {
    const call = ctx(userId, messageId);
    const found = handlers.filter(({ pattern }) => typeof pattern === "string" ? pattern === data : pattern.test(data));
    assert.equal(found.length, 1, `Exactly one handler for ${data}`);
    call.match = typeof found[0].pattern === "string" ? null : data.match(found[0].pattern);
    await found[0].fn(call);
    return call;
  }
  return { tables, client, events, handlers, sent, menuButtonCalls, menuButtonReads,
    expiryStarts, expiryStops, app: fakeApp, getServer: context.module.exports.getServer,
    getState: context.module.exports.getState,
    miniAppCallbacks,
    launchCalls, stopCalls, signals, exits, runtimeCloses, serverCloses, errors,
    keyCalls, limitCalls, missingKeys, ctx, action,
    recover: context.module.exports.recoverStuckProcessingOrders,
    syncUsage: context.module.exports.syncAccessKeyUsage,
    miniAppCreateOrder: context.module.exports.miniAppCreateOrder,
    packageVersion: context.module.exports.packageVersion,
    setUsage(value, ids) { usageByKeyId = value; existingKeyIds = new Set(ids); },
    scheduledIntervals, cancelledIntervals,
    get metricsCalls() { return metricsCalls; },
    setMetricsGate(value) { metricsGate = value; },
    failNextZeroLimit() { failZeroLimitOnce = true; },
    setMetricsUnavailable(value) { metricsUnavailable = value; } };
}

function buttons(reply) { return reply[1].reply_markup.inline_keyboard; }

test("existing customer Connect and Copy Key refresh only profile metadata using the same key and dynamic URL", async t => {
  const bot = await loadBot(null, new Map(), { realHttp: true });
  t.after(async () => {
    bot.signals.SIGTERM();
    for (let i = 0; i < 200 && !bot.exits.length; i++) await new Promise(setImmediate);
    assert.equal(bot.exits.length, 1);
  });
  const customer = { id: 1, telegramId: "123", username: " @ShinHtetMaung ", firstName: "Shin Htet" };
  bot.tables.Customer.push(customer);
  const subscription = { id: 1, customerId: 1, status: "ACTIVE",
    vpnKeyId: "existing-profile-key", dynamicTokenHash: null,
    vpnKey: `ss://${Buffer.from("aes-256-gcm:synthetic-secret").toString("base64url")}@192.0.2.1:1234#Old`,
    expiresAt: Temporal.Now.instant().add({ hours: 24 }), dataUsedGb: 0, dataLimitGb: 100 };
  bot.tables.Subscription.push(subscription);
  const keys = require("./dynamic-config").createDynamicKeys({ client: bot.client,
    baseUrl: "https://vpn.example.test", secret: "test-secret-".repeat(4) });
  await keys.ensure(subscription); // Fixture already has a persisted dynamic token.
  const before = plain(subscription);
  const oldLink = keys.accessUrl(subscription).split("#")[0] + "#Metro%20Secure";
  const helper = await bot.miniAppCallbacks.getConnectUrl(123);
  const origin = `http://127.0.0.1:${bot.getServer().address().port}`;
  async function handedOffName(expected) {
    const response = await fetch(origin + new URL(helper).pathname + "?lang=en", {
      headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const link = JSON.parse(html.match(/let vpnKey = (".*");/)[1]);
    assert.equal(decodeURIComponent(new URL(link).hash.slice(1)), expected);
    assert.equal(link.split("#")[0], oldLink.split("#")[0]);
    return link;
  }
  const namedLink = await handedOffName("Metro Secure | ShinHtetMaung");
  const setup = await bot.action("setup_vpn");
  assert.equal(buttons(setup.replies[0])[0][0].copy_text.text, namedLink);
  const copied = await bot.action("copy_vpn_key");
  assert.ok(copied.replies[0][0].includes(namedLink));
  customer.username = null;
  await handedOffName("Metro Secure | Shin Htet");
  customer.firstName = null;
  await handedOffName("Metro Secure | Customer");
  assert.deepEqual(plain(subscription), before);
  assert.equal(bot.keyCalls.length, 0);
  assert.equal(bot.limitCalls.length, 0);
  assert.equal(bot.tables.Subscription.length, 1);
});

test("real bot HTTP standby remains live, fences APIs, and takes over only after incumbent shutdown", async t => {
  let holder;
  const coordinators = ['old', 'replacement'].map(owner => ({ owner,
    get owned() { return holder === owner; },
    async acquire() { if (holder && holder !== owner) return false; holder = owner; return true; },
    async release() { if (holder === owner) holder = undefined; }, async close() {},
    async customer(_id, work) { assert.equal(holder, owner); return work(() => assert.equal(holder, owner)); },
  }));
  const retries = new Map(); let nextRetry = 0;
  const ownershipTimers = {
    schedule(fn, ms) { assert.ok(ms >= 3000 && ms < 3500); retries.set(++nextRetry, fn); return nextRetry; },
    cancel(id) { retries.delete(id); },
  };
  async function waitFor(predicate) {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(setImmediate);
    assert.ok(predicate());
  }
  const old = await loadBot(null, new Map(), { coordination: coordinators[0], realHttp: true, pollingStaysActive: true });
  const replacement = await loadBot(null, new Map(), { coordination: coordinators[1], realHttp: true,
    pollingStaysActive: true, ownershipTimers });
  t.after(async () => {
    old.signals.SIGTERM(); replacement.signals.SIGTERM();
    await waitFor(() => old.exits.length && replacement.exits.length);
  });
  const origin = instance => `http://127.0.0.1:${instance.getServer().address().port}`;
  const replacementOrigin = origin(replacement);
  assert.equal(old.getState(), 'READY');
  assert.equal(replacement.getState(), 'STANDBY');
  assert.equal(replacement.exits.length, 0);
  assert.equal(replacement.launchCalls.length, 0);
  assert.equal(replacement.expiryStarts.length, 0);
  assert.equal(replacement.scheduledIntervals.length, 0);
  assert.equal(replacement.metricsCalls, 0);
  assert.equal((await fetch(origin(old) + '/ready')).status, 200);
  assert.equal((await fetch(replacementOrigin + '/live')).status, 200);
  const standbyReady = await fetch(replacementOrigin + '/ready');
  assert.equal(standbyReady.status, 503); assert.deepEqual(await standbyReady.json(), { ready: false });
  for (const path of ['/app/', '/app/app.js', '/app/app.css', '/mini-app/'])
    assert.equal((await fetch(replacementOrigin + path)).status, 200, path);
  for (const [path, method] of [
    ['/app/api/overview', 'POST'], ['/app/api/order/create', 'POST'],
    ['/app/api/connect', 'POST'], ['/mini-app/api/order/payment-proof-upload', 'POST'],
    ['/app/api/support/events?session=synthetic', 'GET'],
    ['/app/api/support/send', 'POST'], ['/admin/login', 'GET'], ['/admin/login', 'POST'],
  ]) {
    const response = await fetch(replacementOrigin + path, { method });
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: 'Service restarting. Try again in a moment.' });
  }
  await replacement.recover(); await replacement.syncUsage();
  assert.equal(replacement.metricsCalls, 0);
  old.signals.SIGTERM(); await waitFor(() => old.exits.length === 1);
  assert.equal(old.stopCalls.length, 1); assert.equal(old.expiryStops.length, 1);
  assert.equal(holder, undefined);
  assert.equal(retries.size, 1);
  const [id, retry] = retries.entries().next().value; retries.delete(id); retry();
  await waitFor(() => replacement.getState() === 'READY');
  assert.equal(holder, 'replacement');
  assert.equal(replacement.launchCalls.length, 1); assert.equal(replacement.expiryStarts.length, 1);
  assert.equal(replacement.scheduledIntervals.length, 2);
  assert.equal(replacement.metricsCalls, 1); assert.equal(retries.size, 0);
  assert.equal((await fetch(replacementOrigin + '/ready')).status, 200);
  // A cancelled/stale callback cannot start services again.
  retry(); await new Promise(setImmediate);
  assert.equal(replacement.launchCalls.length, 1); assert.equal(replacement.expiryStarts.length, 1);
});

test('real bot standby SIGTERM cancels retry and lease loss immediately fences active work', async () => {
  let owned = false, retry, cancelled = 0, acquireCalls = 0, lost;
  const coordination = { owner: 'synthetic-owner', get owned() { return owned; },
    async acquire() { acquireCalls++; return owned; }, async release() { owned = false; }, async close() {},
    async customer(_id, work) { assert.ok(owned); return work(() => assert.ok(owned)); },
  };
  const standby = await loadBot(null, new Map(), { coordination,
    ownershipTimers: { schedule(fn) { retry = fn; return 1; }, cancel() { cancelled++; } } });
  standby.signals.SIGTERM();
  for (let i = 0; i < 100 && !standby.exits.length; i++) await new Promise(setImmediate);
  assert.deepEqual(standby.exits, [0]); assert.ok(cancelled);
  owned = true; retry(); await new Promise(setImmediate);
  assert.equal(acquireCalls, 1); assert.equal(standby.launchCalls.length, 0);
  const active = await loadBot(null, new Map(), { coordination, pollingStaysActive: true,
    captureLoss(fn) { lost = fn; } });
  assert.equal(active.launchCalls.length, 1);
  owned = false; lost();
  await active.syncUsage(); await active.recover();
  assert.equal(active.metricsCalls, 1);
  await assert.rejects(active.miniAppCallbacks.createOrder({ id: 123 }, {}, 7, 'synthetic'));
  for (let i = 0; i < 100 && !active.exits.length; i++) await new Promise(setImmediate);
  assert.deepEqual(active.exits, [1]); assert.equal(active.stopCalls.length, 1);
  assert.equal(active.expiryStops.length, 1); assert.equal(active.runtimeCloses.length, 1);
});

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function backCode(reply) {
  const matches = buttons(reply).flat().filter((button) => button.text === "⬅️ Back");
  assert.equal(matches.length, 1);
  return matches[0].callback_data;
}
function assertNoCustomerTicketDetails(message) {
  assert.doesNotMatch(message, /SUP-|\bTicket\b|ticket/i);
}
async function confirmationButton(bot, packageId, months = 1, isRenewal = false) {
  const prefix = isRenewal ? "renew_duration" : "duration";
  const screen = await bot.action(`${prefix}_${packageId}_${months}`);
  return buttons(screen.replies[0])[0][0].callback_data;
}

test("usage sync records real 30-day key usage and skips unsafe or missing metrics", async () => {
  const bot = await loadBot();
  bot.tables.Customer.push({ id: 1, telegramId: "123" });
  const subscription = {
    id: 1, customerId: 1, packageId: 19, plan: "Standard", status: "ACTIVE",
    vpnKeyId: "real-1", vpnKey: "ss://synthetic@192.0.2.1:1234",
    dataUsedGb: 7, dataLimitGb: 213, revokedAt: null,
    expiresAt: Temporal.Now.instant().add({ hours: 24 }),
  };
  bot.tables.Subscription.push(subscription);
  bot.tables.Subscription.push({ ...subscription, id: 2, customerId: 2, vpnKeyId: "missing", dataUsedGb: 4 });
  bot.tables.Subscription.push({ ...subscription, id: 3, customerId: 3, vpnKeyId: "mock-test", dataUsedGb: 4 });
  bot.setUsage({ "real-1": 1.5 * 1024 ** 3 }, ["real-1"]);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 1.5);
  assert.ok(subscription.lastUsageSyncedAt);
  const syncedAt = subscription.lastUsageSyncedAt.toString();
  assert.equal(bot.tables.Subscription[1].dataUsedGb, 4);
  assert.equal(bot.tables.Subscription[2].dataUsedGb, 4);
  assert.equal(bot.keyCalls.length, 0);
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /1\.5 GB \/ 213 GB/);
  assert.match(myVpn.replies[0][0], /30 ရက်/);

  bot.setUsage({ "real-1": Number.MAX_SAFE_INTEGER + 1 }, ["real-1"]);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 1.5);
  assert.equal(subscription.lastUsageSyncedAt.toString(), syncedAt);
  bot.setMetricsUnavailable(true);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 1.5);
  assert.equal(subscription.lastUsageSyncedAt.toString(), syncedAt);
  bot.setMetricsUnavailable(false);
  bot.setUsage({}, ["real-1"]);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 0);
  assert.equal(bot.keyCalls.length, 0);
});

test("a failed subscription write preserves its previous sync timestamp and isolates the next row", async () => {
  const bot = await loadBot();
  const previous = Temporal.Instant.from("2026-09-29T00:00:00Z");
  const subscriptions = [1, 2].map((id) => ({ id, customerId: id,
    status: "ACTIVE", vpnKeyId: `key-${id}`, dataLimitGb: 100,
    dataUsedGb: 5, lastUsageSyncedAt: previous,
    expiresAt: Temporal.Now.instant().add({ hours: 24 }), revokedAt: null }));
  bot.tables.Subscription.push(...subscriptions);
  bot.setUsage({ "key-1": 10 * 1024 ** 3, "key-2": 20 * 1024 ** 3 }, ["key-1", "key-2"]);
  const originalWhere = bot.client.public.Subscription.where;
  bot.client.public.Subscription.where = (filter) => {
    const query = originalWhere(filter);
    if (filter.id === 1) query.updateAll = async () => { throw new Error("DB unavailable"); };
    return query;
  };
  await bot.syncUsage();
  assert.equal(subscriptions[0].dataUsedGb, 5);
  assert.equal(subscriptions[0].lastUsageSyncedAt.toString(), previous.toString());
  assert.equal(subscriptions[1].dataUsedGb, 20);
  assert.ok(Temporal.Instant.compare(subscriptions[1].lastUsageSyncedAt, previous) > 0);
});

test("quota block failure leaves the previous sync timestamp for retry", async () => {
  const bot = await loadBot();
  const previous = Temporal.Instant.from("2026-09-29T00:00:00Z");
  const subscription = { id: 1, customerId: 1, status: "ACTIVE",
    vpnKeyId: "quota-key", dataLimitGb: 50, dataUsedGb: 2,
    lastUsageSyncedAt: previous,
    expiresAt: Temporal.Now.instant().add({ hours: 24 }), revokedAt: null };
  bot.tables.Subscription.push(subscription);
  bot.setUsage({ "quota-key": 50 * 1024 ** 3 }, ["quota-key"]);
  bot.failNextZeroLimit();
  await bot.syncUsage();
  assert.equal(subscription.status, "DATA_LIMIT_REACHED");
  assert.equal(subscription.lastUsageSyncedAt.toString(), previous.toString());
  await bot.syncUsage();
  assert.ok(Temporal.Instant.compare(subscription.lastUsageSyncedAt, previous) > 0);
});

test("usage sync starts immediately, schedules 60 seconds and skips overlap", async () => {
  const bot = await loadBot();
  assert.ok(bot.metricsCalls >= 1);
  assert.equal(bot.scheduledIntervals.filter((timer) => timer.ms === 60000).length, 1);
  let release;
  bot.setMetricsGate(new Promise((resolve) => { release = resolve; }));
  const before = bot.metricsCalls;
  const first = bot.syncUsage();
  const second = bot.syncUsage();
  assert.equal(bot.metricsCalls, before + 1);
  release();
  await Promise.all([first, second]);
});

test("shutdown waits for an in-flight usage sync before closing the database", async () => {
  const bot = await loadBot();
  let release;
  bot.setMetricsGate(new Promise((resolve) => { release = resolve; }));
  const sync = bot.syncUsage();
  bot.signals.SIGTERM();
  await new Promise(setImmediate);
  assert.equal(bot.runtimeCloses.length, 0);
  release();
  await sync;
  await new Promise(setImmediate);
  assert.equal(bot.runtimeCloses.length, 1);
});

test("reaching a purchased quota latches the existing key closed until renewal", async () => {
  const bot = await loadBot();
  bot.tables.Customer.push({ id: 1, telegramId: "123" });
  const subscription = { id: 1, customerId: 1, packageId: 7, plan: "Basic",
    status: "ACTIVE", vpnKeyId: "real-quota-1",
    vpnKey: "ss://synthetic@192.0.2.1:1234", dataUsedGb: 0,
    dataLimitGb: 50, revokedAt: null,
    expiresAt: Temporal.Now.instant().add({ hours: 24 }) };
  bot.tables.Subscription.push(subscription);
  bot.setUsage({ "real-quota-1": 50 * 1024 ** 3 }, ["real-quota-1"]);
  await bot.syncUsage();
  assert.equal(subscription.status, "DATA_LIMIT_REACHED");
  assert.equal(subscription.dataUsedGb, 50);
  assert.ok(subscription.lastUsageSyncedAt);
  assert.equal(bot.limitCalls.at(-1).bytes, 0);
  const account = await bot.miniAppCallbacks.getAccount(123);
  assert.equal(account.status, "DATA_LIMIT_REACHED");
  assert.equal(account.lastUsageSyncedAt, subscription.lastUsageSyncedAt.toString());
  assert.equal(await bot.miniAppCallbacks.getConnectUrl(123), null);
  assert.match((await bot.action("my_vpn")).replies[0][0], /Data အကုန်သုံးပြီးပါပြီ/);
  bot.setUsage({ "real-quota-1": 1 * 1024 ** 3 }, ["real-quota-1"]);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 50);
  assert.equal(subscription.status, "DATA_LIMIT_REACHED");
  assert.equal(bot.limitCalls.at(-1).bytes, 0);
  assert.equal(bot.keyCalls.length, 0);
});

test("welcome, packages, confirmation and help only read customer data", async () => {
  const bot = await loadBot();
  assert.deepEqual(plain(bot.menuButtonCalls), [{ menuButton: {
    type: "web_app", text: "Metro", web_app: { url: "https://vpn.example.test/app" },
  } }]);
  assert.equal(bot.menuButtonReads.length, 1);
  assert.equal(bot.menuButtonReads[0], undefined);
  const menuUrl = new URL(bot.menuButtonCalls[0].menuButton.web_app.url);
  assert.equal(menuUrl.protocol, "https:");
  assert.equal(menuUrl.pathname, "/app");
  assert.equal(menuUrl.search, "");
  assert.equal(menuUrl.hash, "");
  const welcome = bot.ctx();
  await bot.events.start(welcome);
  assert.match(welcome.replies[0][0], /Metro Secure မှ ကြိုဆိုပါတယ်/);
  assert.deepEqual(plain(buttons(welcome.replies[0]).map((row) => row.map((b) => b.text))), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["🗂️ My Orders", "🛰️ Setup VPN"], ["🎧 Support"],
  ]);
  assert.equal(JSON.stringify(welcome.replies).includes("Open Metro"), false);
  assert.deepEqual(plain(welcome.replies[1][1].reply_markup.keyboard), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["📊 Usage", "♻️ Renew"], ["⚡ Connect", "🎧 Support"],
  ]);
  assert.equal(welcome.replies[1][1].reply_markup.input_field_placeholder, "Send a message");
  assert.equal(welcome.replies[1][1].reply_markup.is_persistent, true);
  assert.equal(welcome.replies[1][1].reply_markup.resize_keyboard, true);
  assert.equal(welcome.replies[1][1].reply_markup.one_time_keyboard, false);
  assert.equal(JSON.stringify(welcome.replies[1][1]).includes("Metro"), false);
  const packages = await bot.action("buy_vpn");
  assert.deepEqual(plain(buttons(packages.replies[0])[0].map((b) => b.callback_data)), ["package_7", "package_19"]);
  assert.equal(buttons(packages.replies[0])[1][0].text, "💎 Premium");
  assert.equal(JSON.stringify(packages.replies).includes("Retired"), false);
  const detail = await bot.action("package_19");
  assert.match(detail.replies[0][0], /Standard[\s\S]*213 GB[\s\S]*31 ရက်[\s\S]*7,650 ကျပ်\n/);
  assert.equal(buttons(detail.replies[0])[0][0].callback_data, "duration_19_1");
  assert.equal(buttons(detail.replies[0])[1].length, 2);
  const confirm = await bot.action("duration_19_3");
  assert.match(confirm.replies[0][0], /VPN အသုံးပြုဖို့ Outline app လိုပါတယ်။/);
  assert.match(confirm.replies[0][0], /ဒီ package ကို ရွေးထားပါတယ်။[\s\S]*639 GB[\s\S]*93 ရက်[\s\S]*22,950 ကျပ်\n/);
  assert.match(buttons(confirm.replies[0])[0][0].callback_data, /^confirm_package_19_3_[a-f0-9]{16}$/);
  assert.match((await bot.action("package_99")).replies[0][0], /Package အသစ်ရွေးပေးပါ/);
  const help = await bot.action("help");
  assert.match(help.replies[0][0], /🎧 Support/);
  assert.equal(buttons(help.replies[0])[0][0].callback_data, "contact_support");
  assert.equal(JSON.stringify(help.replies).includes("tg://user"), false);
  assert.match((await bot.action("payment_help")).replies[0][0], /ငွေပမာဏအတိအကျ/);
  assert.equal(bot.tables.Order.length, 0);
  assert.equal(bot.keyCalls.length, 0);
});

test("polling remains active while the native menu is configured and callbacks still run", async () => {
  const bot = await loadBot(null, new Map(), { pollingStaysActive: true });
  assert.equal(bot.launchCalls.length, 1);
  assert.equal(bot.menuButtonCalls.length, 1);
  assert.equal(bot.menuButtonReads.length, 1);
  assert.match((await bot.action("buy_vpn")).replies[0][0], /လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။/);
  const adminWelcome = bot.ctx(999);
  await bot.events.start(adminWelcome);
  const keyboard = adminWelcome.replies[1][1].reply_markup;
  assert.deepEqual(plain(keyboard.keyboard.slice(0, 3)), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["📊 Usage", "♻️ Renew"], ["⚡ Connect", "🎧 Support"],
  ]);
  assert.deepEqual(plain(keyboard.keyboard.slice(3)), [
    ["📊 Admin Panel"], ["👥 Users", "🗂️ Orders"], ["🧾 Payments", "💎 Packages"],
  ]);
  assert.equal(keyboard.input_field_placeholder, "Send a message");
});

test("one polling launch stops and closes resources on SIGTERM or SIGINT", async () => {
  const source = readFileSync(path.join(__dirname, "bot.js"), "utf8");
  assert.equal((source.match(/bot\.launch\(/g) || []).length, 1);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const bot = await loadBot(null, new Map(), { pollingStaysActive: true });
    assert.equal(bot.launchCalls.length, 1);
    bot.signals[signal]();
    await new Promise(setImmediate);
    assert.deepEqual(bot.stopCalls, [signal]);
    assert.equal(bot.serverCloses.length, 1);
    assert.equal(bot.runtimeCloses.length, 1);
    assert.deepEqual(bot.exits, [0]);
  }
});

test("customer Back follows package, confirmation, and payment screens", async () => {
  const bot = await loadBot();
  const start = bot.ctx();
  await bot.events.start(start);
  assert.equal(JSON.stringify(start.replies).includes("⬅️ Back"), false);
  assert.deepEqual(plain(start.replies[1][1].reply_markup.keyboard), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["📊 Usage", "♻️ Renew"], ["⚡ Connect", "🎧 Support"],
  ]);
  const list = await bot.action("buy_vpn");
  assert.match(backCode(list.replies.at(-1)), /^nav_back_/);
  const detail = await bot.action("package_19");
  const detailBack = await bot.action(backCode(detail.replies[0]));
  assert.match(detailBack.replies[0][0], /လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။/);
  await bot.action("package_19");
  const confirmation = await bot.action("duration_19_1");
  const confirmationBack = await bot.action(backCode(confirmation.replies[0]));
  assert.match(confirmationBack.replies.at(-1)[0], /လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။/);
  await bot.action("package_19");
  const secondConfirmation = await bot.action("duration_19_1");
  const payment = await bot.action(buttons(secondConfirmation.replies[0])[0][0].callback_data);
  assert.match(payment.replies[0][0], /Payment/);
  const paymentBack = await bot.action(backCode(payment.replies[0]));
  assert.match(paymentBack.replies[0][0], /ဒီ package ကို ရွေးထားပါတယ်။/);
  const paymentAgain = await bot.action(buttons(paymentBack.replies[0])[0][0].callback_data);
  const methodCode = buttons(paymentAgain.replies[0])[0][0].callback_data;
  const instructions = await bot.action(methodCode);
  assert.match(instructions.replies[0][0], /အကောင့်နံပါတ်/);
  const paymentHelp = await bot.action("payment_help");
  const helpBack = await bot.action(backCode(paymentHelp.replies[0]));
  assert.match(helpBack.replies[0][0], /အကောင့်နံပါတ်/);
  const methodBack = await bot.action(backCode(helpBack.replies[0]));
  assert.match(methodBack.replies[0][0], /Payment/);
  assert.equal(bot.tables.Order.length, 1);
  const proof = bot.ctx();
  proof.message = { photo: [{ file_id: "proof-after-back", file_size: 1000 }] };
  await bot.events.photo(proof);
  assert.equal(bot.tables.Order[0].paymentProof, undefined);
});

test("My VPN, Usage, Connect, Renew, and Support Back keep their entry context", async () => {
  const bot = await loadBot();
  const start = bot.ctx();
  await bot.events.start(start);
  bot.tables.Subscription.push({ id: 1, customerId: 1, packageId: 19, plan: "Standard",
    status: "ACTIVE", vpnKeyId: "real-1", vpnKey: "ss://synthetic@192.0.2.1:1234",
    dataUsedGb: 7, dataLimitGb: 213, revokedAt: null,
    expiresAt: Temporal.Now.instant().add({ hours: 24 }) });
  const myVpn = await bot.action("my_vpn");
  assert.match(backCode(myVpn.replies[0]), /^nav_back_/);
  const setup = await bot.action("setup_vpn");
  const setupBack = await bot.action(backCode(setup.replies[0]));
  assert.match(setupBack.replies[0][0], /🌐 My VPN/);
  const vpnBack = await bot.action(backCode(setupBack.replies[0]));
  assert.match(vpnBack.replies[0][0], /ကြိုဆိုပါတယ်/);
  const connectText = bot.ctx();
  connectText.message = { text: "⚡ Connect" };
  await bot.events.text(connectText);
  const directConnectBack = await bot.action(backCode(connectText.replies[0]));
  assert.match(directConnectBack.replies[0][0], /ကြိုဆိုပါတယ်/);
  const usageText = bot.ctx();
  usageText.message = { text: "📊 Usage" };
  await bot.events.text(usageText);
  assert.match(backCode(usageText.replies[0]), /^nav_back_/);
  assert.match((await bot.action(backCode(usageText.replies[0]))).replies[0][0], /ကြိုဆိုပါတယ်/);
  const renew = await bot.action("renew_vpn");
  assert.match(backCode(renew.replies[0]), /^nav_back_/);
  await bot.action("renew_package_19");
  const renewConfirm = await bot.action("renew_duration_19_1");
  assert.match((await bot.action(backCode(renewConfirm.replies[0]))).replies[0][0], /VPN သက်တမ်းတိုးပါ/);
  const support = await bot.action("contact_support");
  const supportBack = await bot.action(backCode(support.replies[0]));
  assert.match(supportBack.replies[0][0], /ကြိုဆိုပါတယ်/);
  assert.equal(bot.tables.SupportTicket[0].customerInputActive, false);
  const sentBefore = bot.sent.length;
  const ordinary = bot.ctx(); ordinary.message = { text: "not a support reply" };
  await bot.events.text(ordinary);
  assert.equal(bot.sent.length, sentBefore);
});

test("admin Back returns to lists and prior pages, clears edit input, and rejects stale users", async () => {
  const user = { id: 3, telegramId: "123", username: "buyer", firstName: "Buyer",
    subscription: null };
  const order = { id: 4, orderNumber: "ORD-4", customerId: 3, customer: user,
    plan: "Basic", price: "5000", status: "PAID", createdAt: new Date() };
  const pkg = { id: 8, name: "Basic", priceMmk: "5000", dataLimitGb: 100,
    durationDays: 31, active: true, sortOrder: 1 };
  const adminDataApi = {
    getDashboardData: async () => ({ totalCustomers: 1 }),
    getUsersData: async (_db, { page }) => ({ customers: [user], count: 14,
      page, totalPages: 2 }),
    getUserDetail: async () => user,
    getOrdersData: async (_db, { page }) => ({ orders: [order], count: 14,
      page, totalPages: 2 }),
    getOrderDetail: async () => order,
    getPaymentsData: async () => ({ orders: [order], count: 1, page: 1, totalPages: 1 }),
    getPackagesData: async () => ({ packages: [pkg], count: 1, page: 1, totalPages: 1 }),
    getPackageDetail: async () => pkg,
  };
  const bot = await loadBot(null, new Map(), { adminDataApi });
  const originalWhere = bot.client.public.Order.where;
  bot.client.public.Order.where = (filter) => ({ ...originalWhere(filter),
    aggregate: async () => ({ count: 1 }) });
  const start = bot.ctx(999);
  await bot.events.start(start);
  assert.equal(JSON.stringify(start.replies).includes("⬅️ Back"), false);
  const dashboard = await bot.action("ta_dashboard", 999);
  assert.match((await bot.action(backCode(dashboard.replies[0]), 999)).replies[0][0],
    /ကြိုဆိုပါတယ်/);
  await bot.action("ta_dashboard", 999);
  const usersPage1 = await bot.action("ta_users_1", 999);
  const usersPage2 = await bot.action("ta_users_2", 999);
  assert.match((await bot.action(backCode(usersPage2.replies[0]), 999)).replies[0][0],
    /Users \(14\) • 1\/2/);
  const userDetail = await bot.action("ta_user_3_1", 999);
  assert.match((await bot.action(backCode(userDetail.replies[0]), 999)).replies[0][0],
    /Users \(14\)/);
  const orderList = await bot.action("ta_orders_1", 999);
  const orderDetail = await bot.action("ta_order_4_1", 999);
  assert.match((await bot.action(backCode(orderDetail.replies[0]), 999)).replies[0][0],
    /Orders \(14\)/);
  assert.match(backCode(orderList.replies[0]), /^nav_back_/);
  const payments = await bot.action("ta_payments_1", 999);
  const paymentDetail = await bot.action("ta_order_4_1", 999);
  assert.match((await bot.action(backCode(paymentDetail.replies[0]), 999)).replies[0][0],
    /Payments \(1\)/);
  assert.match(backCode(payments.replies[0]), /^nav_back_/);
  await bot.action("ta_packages_1", 999);
  await bot.action("ta_package_8_1", 999);
  const edit = await bot.action("ta_edit_8_1", 999);
  assert.match((await bot.action(backCode(edit.replies[0]), 999)).replies[0][0],
    /Packages \(1\)/);
  await bot.action("ta_package_8_1", 999);
  await bot.action("ta_edit_8_1", 999);
  const input = await bot.action("ta_field_8_1_name", 999);
  const fieldBack = await bot.action(backCode(input.replies[0]), 999);
  assert.match(fieldBack.replies[0][0], /Edit Basic/);
  const ordinary = bot.ctx(999); ordinary.message = { text: "Should not edit" };
  await bot.events.text(ordinary);
  assert.equal(pkg.name, "Basic");
  const stale = await bot.action(backCode(input.replies[0]), 999);
  assert.match(stale.replies[0][0], /ဒီခလုတ်က သုံးလို့မရတော့ပါဘူး/);
  const forbidden = await bot.action(backCode(fieldBack.replies[0]), 123);
  assert.match(forbidden.replies[0][0], /ဒီခလုတ်က သုံးလို့မရတော့ပါဘူး/);
  assert.equal(JSON.stringify(forbidden.replies).includes("Customer ID"), false);
});

test("admin support-reply Back clears the selected reply state", async () => {
  const bot = await loadBot();
  await bot.events.start(bot.ctx(999));
  await bot.events.start(bot.ctx(123));
  await bot.action("contact_support", 123);
  const ticket = bot.tables.SupportTicket[0];
  const reply = await bot.action(`support_reply_${ticket.id}`, 999);
  assert.equal(ticket.adminReplySelected, true);
  assert.match(backCode(reply.replies[0]), /^nav_back_/);
  await bot.action(backCode(reply.replies[0]), 999);
  assert.equal(ticket.adminReplySelected, false);
});

test("a Telegram menu API failure does not prevent polling or customer actions", async () => {
  for (const failure of ["menuWriteFails", "menuReadFails"]) {
    const bot = await loadBot(null, new Map(), { [failure]: true });
    assert.equal(bot.launchCalls.length, 1);
    assert.match((await bot.action("buy_vpn")).replies[0][0], /လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။/);
    assert.match(bot.errors[0][0], /Telegram menu button setup failed/);
  }
});

test("admin text reaches private admin screens without blocking customer text", async () => {
  const emptyPage = { customers: [], orders: [], packages: [], count: 0, page: 1, totalPages: 1 };
  const bot = await loadBot(null, new Map(), { adminDataApi: {
    async getDashboardData() { return { totalCustomers: 0, activeSubscriptions: 0,
      expiredSubscriptions: 0, pendingPayments: 0, totalOrders: 0,
      activeVpnKeys: 0, totalDataUsedGb: 0 }; },
    async getUsersData() { return emptyPage; },
    async getOrdersData() { return emptyPage; },
    async getPaymentsData() { return emptyPage; },
    async getPackagesData() { return emptyPage; },
  } });
  for (const [label, heading] of [
    ["📊 Admin Panel", "Metro Secure Admin"], ["👥 Users", "Users (0)"],
    ["🗂️ Orders", "Orders (0)"], ["🧾 Payments", "Payments (0)"],
    ["💎 Packages", "Packages (0)"],
  ]) {
    const admin = bot.ctx(999);
    admin.message = { text: label };
    await bot.events.text(admin);
    assert.match(admin.replies[0][0], new RegExp(heading.replace(/[()]/g, "\\$&")));
  }
  const customer = bot.ctx(123);
  customer.message = { text: "🛡️ Buy VPN" };
  await bot.events.text(customer);
  assert.match(customer.replies[0][0], /လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။/);
});

test("persistent reply buttons keep the existing customer actions functional", async () => {
  const bot = await loadBot();
  bot.tables.Customer.push({ id: 1, telegramId: "123" });
  bot.tables.Subscription.push({
    id: 1, customerId: 1, plan: "Basic", status: "ACTIVE", dataUsedGb: 35,
    dataLimitGb: 100, vpnKeyId: "real-1",
    vpnKey: "ss://synthetic@192.0.2.1:1234",
    expiresAt: Temporal.Now.instant().add({ hours: 24 * 20 }), revokedAt: null,
  });
  async function press(text) {
    const ctx = bot.ctx();
    ctx.message = { text };
    await bot.events.text(ctx);
    return ctx;
  }
  assert.match((await press("🛡️ Buy VPN")).replies[0][0], /လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။/);
  assert.match((await press("🌐 My VPN")).replies[0][0], /35 GB \/ 100 GB/);
  assert.match((await press("📊 Usage")).replies[0][0], /35 GB \/ 100 GB/);
  assert.match((await press("♻️ Renew")).replies[0][0], /VPN သက်တမ်းတိုးပါ/);
  assert.match((await press("⚡ Connect")).replies[0][0], /Setup VPN/);
  assert.match((await press("🎧 Support")).replies[0][0], /Metro Secure Support/);
  assert.equal(bot.tables.SupportTicket.length, 1);
});

test("Mini App checkout reuses current package snapshots and prevents rapid duplicate orders", async () => {
  const bot = await loadBot();
  bot.tables.Customer.push({ id: 1, telegramId: "123", firstName: "Buyer" });
  bot.tables.Customer.push({ id: 2, telegramId: "456", firstName: "Renewing" });
  const basic = bot.tables.Package.find((pkg) => pkg.id === 7);
  const originalVersion = bot.packageVersion(basic);
  basic.priceMmk = "3450";
  basic.dataLimitGb = 55;
  basic.durationDays = 33;
  const changed = await bot.miniAppCreateOrder({ id: 123, first_name: "Buyer" }, {}, 7, originalVersion);
  assert.equal(changed.changed, true);
  assert.equal(bot.tables.Order.length, 0);
  const currentVersion = bot.packageVersion(basic);
  const bought = await bot.miniAppCreateOrder({ id: 123, first_name: "Buyer" }, {}, 7, currentVersion);
  assert.equal(bought.order.status, "PENDING_PAYMENT");
  assert.equal(bought.order.customerId, 1);
  assert.equal(bought.order.plan, "Basic - 33 Days");
  assert.equal(Number(bought.order.price), 3450);
  assert.equal(bought.order.totalDataGb, 55);
  assert.equal(bought.order.totalDurationDays, 33);
  const repeated = await bot.miniAppCreateOrder({ id: 123, first_name: "Buyer" }, {}, 7, currentVersion);
  assert.equal(repeated.inProgress, true);
  assert.equal(repeated.order.orderNumber, bought.order.orderNumber);
  assert.equal(bot.tables.Order.length, 1);
  bot.tables.Subscription.push({ id: 1, customerId: 2, status: "ACTIVE",
    expiresAt: Temporal.Now.instant().add({ hours: 24 * 20 }), revokedAt: null,
    vpnKeyId: "existing-key", vpnKey: "ss://synthetic@192.0.2.1:1234" });
  const renewed = await bot.miniAppCreateOrder({ id: 456, first_name: "Renewing" }, {}, 7, currentVersion);
  assert.equal(renewed.order.customerId, 2);
  assert.equal(renewed.order.status, "PENDING_PAYMENT");
  assert.equal(renewed.order.totalDataGb, 55);
  assert.equal(bot.tables.Subscription[0].dataLimitGb, undefined);
  assert.equal(bot.keyCalls.length, 0);
});

test("Mini App payment handoff keeps order ownership and uses the bot photo review flow", async () => {
  const bot = await loadBot();
  bot.tables.Customer.push({ id: 1, telegramId: "123", firstName: "Buyer" });
  bot.tables.Customer.push({ id: 2, telegramId: "456", firstName: "Other" });
  const pkg = bot.tables.Package.find((item) => item.id === 7);
  const { order } = await bot.miniAppCreateOrder({ id: 123, first_name: "Buyer" }, {},
    pkg.id, bot.packageVersion(pkg));
  assert.equal((await bot.miniAppCallbacks.getOrder(456, order.orderNumber)), null);
  assert.equal((await bot.miniAppCallbacks.getOrders(456)).length, 0);
  assert.equal((await bot.miniAppCallbacks.getOrders(123)).length, 1);
  assert.equal((await bot.miniAppCallbacks.selectPaymentMethod(456, order.orderNumber, "mobile_wallet")), null);
  assert.equal((await bot.miniAppCallbacks.handoffProof(456, order.orderNumber)), false);
  const methods = await bot.miniAppCallbacks.getPaymentMethods();
  assert.equal(methods.some((method) => method.accountNumber === "YOUR_ACCOUNT_NUMBER"), false);
  assert.equal(methods.some((method) => method.code === "mobile_wallet"), true);
  const selected = await bot.miniAppCallbacks.selectPaymentMethod(123, order.orderNumber, "mobile_wallet");
  assert.equal(selected.paymentMethod, "mobile_wallet");
  assert.equal(await bot.miniAppCallbacks.handoffProof(123, order.orderNumber), true);
  assert.match(bot.sent.at(-1).args[1], /ငွေလွှဲပြီးရင် slip ပုံကို/);
  const photo = bot.ctx(123);
  photo.message = { photo: [{ file_id: "synthetic-proof", file_size: 1024 }] };
  await bot.events.photo(photo);
  assert.equal(bot.tables.Order[0].paymentProof, "synthetic-proof");
  const waitingOrder = await bot.action("my_orders");
  assert.match(waitingOrder.replies[0][0], /Slip ရပါပြီ။ စစ်ဆေးပေးနေပါတယ်/);
  assert.equal(bot.keyCalls.length, 0);
});

test("Mini App upload stores one Telegram proof on the existing order and admin review channel", async () => {
  const bot = await loadBot();
  bot.tables.Customer.push({ id: 1, telegramId: "123", firstName: "Buyer" });
  bot.tables.Customer.push({ id: 2, telegramId: "456", firstName: "Other" });
  const pkg = bot.tables.Package.find((item) => item.id === 7);
  const { order } = await bot.miniAppCreateOrder({ id: 123, first_name: "Buyer" }, {},
    pkg.id, bot.packageVersion(pkg));
  await bot.miniAppCallbacks.selectPaymentMethod(123, order.orderNumber, "mobile_wallet");
  assert.equal(await bot.miniAppCallbacks.uploadProof(456, order.orderNumber,
    Buffer.from("synthetic"), "image/png"), null);
  const uploaded = await bot.miniAppCallbacks.uploadProof(123, order.orderNumber,
    Buffer.from("synthetic"), "image/png");
  assert.equal(uploaded.order.status, "PENDING_PAYMENT");
  assert.equal(uploaded.order.paymentProof.startsWith("mini-upload-"), true);
  assert.equal(uploaded.order.paymentReference, null);
  const adminPhotos = bot.sent.filter((item) => item.type === "photo");
  assert.equal(adminPhotos.length, 1);
  assert.match(adminPhotos[0].args[2].caption, /PAYMENT VERIFICATION/);
  assert.equal(bot.sent.filter((item) => item.type === "editMarkup").length, 1);
  const duplicate = await bot.miniAppCallbacks.uploadProof(123, order.orderNumber,
    Buffer.from("synthetic"), "image/png");
  assert.equal(duplicate.already, true);
  assert.equal(bot.sent.filter((item) => item.type === "photo").length, 1);
  assert.equal(bot.keyCalls.length, 0);
  assert.equal(bot.tables.Subscription.length, 0);
  await bot.action(`approve_payment_${order.id}`, 999);
  assert.equal(bot.tables.Order[0].status, "PAID");
  assert.equal(bot.tables.Subscription.length, 1);
});

test("definite Telegram rejection permits retry while ambiguous delivery never duplicates admin proof", async () => {
  for (const [option, mayRetry] of [["rejectMiniPhotoOnce", true], ["ambiguousMiniPhotoOnce", false]]) {
    const bot = await loadBot(null, new Map(), { [option]: true });
    bot.tables.Customer.push({ id: 1, telegramId: "123", firstName: "Buyer" });
    const pkg = bot.tables.Package.find((item) => item.id === 7);
    const { order } = await bot.miniAppCreateOrder({ id: 123, first_name: "Buyer" }, {},
      pkg.id, bot.packageVersion(pkg));
    await bot.miniAppCallbacks.selectPaymentMethod(123, order.orderNumber, "mobile_wallet");
    await assert.rejects(bot.miniAppCallbacks.uploadProof(123, order.orderNumber,
      Buffer.from("synthetic"), "image/png"));
    assert.equal(bot.tables.Order[0].paymentReference === null, mayRetry);
    if (mayRetry) {
      const retried = await bot.miniAppCallbacks.uploadProof(123, order.orderNumber,
        Buffer.from("synthetic"), "image/png");
      assert.equal(Boolean(retried.order.paymentProof), true);
    } else {
      assert.equal((await bot.miniAppCallbacks.uploadProof(123, order.orderNumber,
        Buffer.from("synthetic"), "image/png")).busy, true);
    }
    assert.equal(bot.sent.filter((item) => item.type === "photo").length, 1);
  }
});

test("start registers a customer and empty VPN states stay customer friendly", async () => {
  const bot = await loadBot();
  const welcome = bot.ctx(456);
  await bot.events.start(welcome);
  assert.equal(bot.tables.Customer.find((row) => row.telegramId === "456")?.firstName, "Test");
  const myVpn = await bot.action("my_vpn", 456);
  assert.match(myVpn.replies[0][0], /လက်ရှိ VPN မရှိသေးပါဘူး/);
  assert.doesNotMatch(myVpn.replies[0][0], /အခုကြည့်လို့မရသေးပါဘူး/);
  const usage = bot.ctx(456);
  usage.message = { text: "📊 Usage" };
  await bot.events.text(usage);
  assert.match(usage.replies[0][0], /လက်ရှိ VPN မရှိသေးပါဘူး/);
  assert.match((await bot.action("renew_vpn", 456)).replies[0][0], /လက်ရှိ VPN မရှိသေးပါဘူး/);
  const connect = bot.ctx(456);
  connect.message = { text: "⚡ Connect" };
  await bot.events.text(connect);
  assert.match(connect.replies[0][0], /လက်ရှိ VPN မရှိသေးပါဘူး/);
});

test("Buy VPN uses live Package rows and handles an empty package table", async () => {
  const bot = await loadBot();
  assert.match((await bot.action("buy_vpn")).replies[0][0], /လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။/);
  bot.tables.Package.splice(0);
  assert.match((await bot.action("buy_vpn")).replies[0][0], /package မရှိသေးပါဘူး/);
});

test("database failures use safe fallbacks and log codes without secrets", async () => {
  const bot = await loadBot();
  const error = Object.assign(new Error("query failed postgres://user:password@db.invalid/x ss://private-key token=private"),
    { code: "CONTRACT.MARKER_MISMATCH" });
  bot.client.public.Customer.where = () => { throw error; };
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /အခုကြည့်လို့မရသေးပါဘူး/);
  bot.client.public.Package.where = () => { throw error; };
  const buy = await bot.action("buy_vpn");
  assert.match(buy.replies[0][0], /Package တွေကို အခုကြည့်လို့မရသေးပါဘူး/);
  const logged = JSON.stringify(bot.errors);
  assert.match(logged, /my_vpn|buy_vpn/);
  assert.match(logged, /CONTRACT\.MARKER_MISMATCH/);
  assert.match(logged, /contract/);
  assert.doesNotMatch(logged, /private-key|postgres:\/\/|token=private|password@/);
});

test("support opens persistent per-customer tickets and relays text and photos to admin", async () => {
  const bot = await loadBot();
  const first = await bot.action("contact_support", 123);
  const second = await bot.action("contact_support", 456);
  const startText = "🎧 Metro Secure Support\n\nဘာအကူအညီလိုလဲ ရေးပို့ပေးပါ။ ပုံလည်း ပို့လို့ရပါတယ်။\nတတ်နိုင်သမျှ အမြန်ပြန်ဖြေပေးပါမယ်။";
  assert.equal(first.replies.length, 1);
  assert.equal(first.replies[0][0], startText);
  assert.equal(second.replies[0][0], startText);
  assert.match(buttons(first.replies[0]).flat().find((button) => button.text === "⬅️ Back").callback_data,
    /^nav_back_/);
  assertNoCustomerTicketDetails(first.replies[0][0]);
  assertNoCustomerTicketDetails(second.replies[0][0]);
  assert.equal(bot.tables.SupportTicket.length, 2);
  const textMessage = bot.ctx(123);
  textMessage.message = { text: "Please help with my VPN" };
  await bot.events.text(textMessage);
  assert.equal(textMessage.replies[0][0],
    "စာရပါပြီ။\nတတ်နိုင်သမျှ အမြန်ပြန်ဖြေပေးပါမယ်။");
  assert.equal(buttons(textMessage.replies[0])[0][0].callback_data, "support_main_menu");
  assertNoCustomerTicketDetails(textMessage.replies[0][0]);
  assert.equal(bot.sent.at(-1).args[0], "999");
  assert.match(bot.sent.at(-1).args[1], /SUP-0001[\s\S]*Telegram ID: 123[\s\S]*Please help/);
  assert.equal(bot.sent.at(-1).args[2].reply_markup.inline_keyboard[0][0].callback_data,
    "support_reply_1");
  assert.ok(bot.tables.SupportTicket[0].acknowledgedAt);
  const sensitiveText = bot.ctx(123);
  sensitiveText.message = { text: "Please inspect ss://private-key-data" };
  await bot.events.text(sensitiveText);
  assert.equal(sensitiveText.replies.length, 0);
  assert.equal(bot.sent.at(-1).args[1].includes("ss://private-key-data"), false);
  const photo = bot.ctx(456);
  photo.message = { photo: [{ file_id: "support-image" }], caption: "Screenshot" };
  await bot.events.photo(photo);
  assert.equal(photo.replies[0][0], textMessage.replies[0][0]);
  assertNoCustomerTicketDetails(photo.replies[0][0]);
  assert.ok(bot.tables.SupportTicket[1].acknowledgedAt);
  assert.equal(bot.sent.at(-1).type, "photo");
  assert.equal(bot.sent.at(-1).args[0], "999");
  assert.equal(bot.sent.at(-1).args[1], "support-image");
  assert.match(bot.sent.at(-1).args[2].caption, /SUP-0002[\s\S]*Screenshot/);
  const laterPhoto = bot.ctx(456);
  laterPhoto.message = { photo: [{ file_id: "later-support-image" }] };
  await bot.events.photo(laterPhoto);
  assert.equal(laterPhoto.replies.length, 0);
  assert.equal(bot.sent.at(-1).args[1], "later-support-image");
  const restarted = await loadBot(bot.tables);
  const afterRestart = restarted.ctx(123);
  afterRestart.message = { text: "After restart" };
  await restarted.events.text(afterRestart);
  assert.equal(afterRestart.replies.length, 0);
  assert.match(restarted.sent.at(-1).args[1], /SUP-0001[\s\S]*After restart/);
  assert.equal(bot.tables.Order.length, 0);
  const repeat = await bot.action("contact_support", 123);
  assert.equal(repeat.replies[0][0], startText);
  assertNoCustomerTicketDetails(repeat.replies[0][0]);
  assert.equal(bot.tables.SupportTicket.length, 2);
});

test("bot and Mini App share support messages and keep customer conversations separate", async () => {
  const bot = await loadBot();
  await bot.action("contact_support", 123);
  await bot.action("contact_support", 456);
  const service = bot.miniAppCallbacks.getSupportService();
  const botMessage = bot.ctx(123);
  botMessage.message = { text: "Bot question" };
  await bot.events.text(botMessage);
  assert.equal((await service.listMessages(123)).messages[0].text, "Bot question");
  assert.equal((await service.listMessages(456)).messages.length, 0);
  const sent = await service.sendCustomerMessage(456, "App question");
  assert.equal(sent.ok, true);
  assert.equal(sent.message.text, "App question");
  assert.match(sent.message.key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(bot.sent.at(-1).args[1], /App question/);
  assert.equal((await service.listMessages(456)).messages[0].text, "App question");
  await bot.action("support_reply_2", 999);
  const admin = bot.ctx(999);
  admin.message = { text: "Support answer" };
  await bot.events.text(admin);
  assert.equal((await service.listMessages(456)).messages[1].text, "Support answer");
  assert.equal((await service.listMessages(456)).messages[1].sender, "support");
  assert.equal((await service.listMessages(123)).messages.length, 1);
  assert.equal(Object.hasOwn((await service.listMessages(456)).messages[0], "ticketId"), false);
});

test("simultaneous first support messages claim only one acknowledgement", async () => {
  const bot = await loadBot();
  await bot.action("contact_support");
  const textMessage = bot.ctx();
  textMessage.message = { text: "First question" };
  const photoMessage = bot.ctx();
  photoMessage.message = { photo: [{ file_id: "first-image" }] };
  await Promise.all([bot.events.text(textMessage), bot.events.photo(photoMessage)]);
  assert.equal(textMessage.replies.length + photoMessage.replies.length, 1);
  assert.equal(bot.sent.length, 2);
  assert.ok(bot.tables.SupportTicket[0].acknowledgedAt);
});

test("admin reply and close use ticket ownership and keep admin identity inside the bot", async () => {
  const bot = await loadBot();
  await bot.action("contact_support", 123);
  await bot.action("contact_support", 456);
  const unauthorized = await bot.action("support_reply_2", 123);
  assert.equal(unauthorized.replies.length, 0);
  assert.equal(bot.tables.SupportTicket[1].adminReplySelected, false);
  await bot.action("support_reply_2", 999);
  const adminText = bot.ctx(999);
  adminText.message = { text: "We can help you here." };
  await bot.events.text(adminText);
  const customerReply = bot.sent.at(-1);
  assert.equal(customerReply.args[0], "456");
  assert.match(customerReply.args[1], /^🎧 Metro Secure Support\n\nWe can help/);
  assert.equal(customerReply.args[1].includes("999"), false);
  assertNoCustomerTicketDetails(customerReply.args[1]);
  assert.equal(customerReply.args[2].reply_markup.inline_keyboard[0][0].callback_data,
    "support_main_menu");
  assert.equal(bot.tables.SupportTicket[1].adminReplySelected, false);
  await bot.action("support_reply_1", 999);
  const adminPhoto = bot.ctx(999);
  adminPhoto.message = { photo: [{ file_id: "admin-image" }], caption: "Try this" };
  await bot.events.photo(adminPhoto);
  assert.equal(bot.sent.at(-1).args[0], "123");
  assert.match(bot.sent.at(-1).args[2].caption, /Metro Secure Support[\s\S]*Try this/);
  assert.equal(bot.sent.at(-1).args[2].caption.includes("999"), false);
  assertNoCustomerTicketDetails(bot.sent.at(-1).args[2].caption);
  assert.equal(bot.sent.at(-1).args[2].reply_markup.inline_keyboard[0][0].callback_data,
    "support_main_menu");
  const nonAdminClose = await bot.action("support_close_2", 123);
  assert.equal(nonAdminClose.replies.length, 0);
  assert.equal(bot.tables.SupportTicket[1].status, "OPEN");
  await bot.action("support_close_2", 999);
  assert.equal(bot.tables.SupportTicket[1].status, "CLOSED");
  assert.ok(bot.tables.SupportTicket[1].closedAt);
  assert.equal(bot.sent.at(-1).args[0], "456");
  assert.match(bot.sent.at(-1).args[1], /ဒီမေးခွန်းအတွက် Support ကို ပိတ်ထားပါပြီ/);
  assertNoCustomerTicketDetails(bot.sent.at(-1).args[1]);
  const reopened = await bot.action("contact_support", 456);
  assertNoCustomerTicketDetails(reopened.replies[0][0]);
  assert.equal(bot.tables.SupportTicket[2].id, 3);
  const newTicketMessage = bot.ctx(456);
  newTicketMessage.message = { text: "New question" };
  await bot.events.text(newTicketMessage);
  assert.equal(newTicketMessage.replies.length, 1);
  assert.match(bot.sent.at(-1).args[1], /SUP-0003[\s\S]*New question/);
});

test("support mode keeps screenshots separate from payment proof and Cancel returns to payment mode", async () => {
  const bot = await loadBot();
  await bot.action(await confirmationButton(bot, 19));
  await bot.action("payment_wallet_1");
  await bot.action("contact_support");
  const supportPhoto = bot.ctx();
  supportPhoto.message = { photo: [{ file_id: "support-proof" }], caption: "Question" };
  await bot.events.photo(supportPhoto);
  assert.equal(bot.tables.Order[0].paymentProof, undefined);
  assert.equal(bot.sent.at(-1).args[0], "999");
  await bot.action("support_cancel");
  assert.equal(bot.tables.SupportTicket[0].customerInputActive, false);
  const sentBefore = bot.sent.length;
  const idleText = bot.ctx();
  idleText.message = { text: "This should stay outside support" };
  await bot.events.text(idleText);
  assert.equal(bot.sent.length, sentBefore);
  const paymentPhoto = bot.ctx();
  paymentPhoto.message = { photo: [{ file_id: "actual-payment-proof" }] };
  await bot.events.photo(paymentPhoto);
  assert.equal(bot.tables.Order[0].paymentProof, "actual-payment-proof");
  await bot.action("contact_support");
  assert.equal(bot.tables.SupportTicket[0].customerInputActive, true);
  assert.equal(bot.tables.SupportTicket.length, 1);
  const afterResume = bot.ctx();
  afterResume.message = { text: "Another question" };
  await bot.events.text(afterResume);
  assert.equal(afterResume.replies.length, 1);
  await bot.action("payment_wallet_1");
  assert.equal(bot.tables.SupportTicket[0].customerInputActive, false);
});

test("support flood is stopped before forwarding to admin", async () => {
  const bot = await loadBot();
  await bot.action("contact_support");
  for (let index = 0; index < 10; index++) {
    const message = bot.ctx();
    message.message = { text: `question ${index}` };
    await bot.events.text(message);
  }
  const forwarded = bot.sent.length;
  const blocked = bot.ctx();
  blocked.message = { text: "flood" };
  await bot.events.text(blocked);
  assert.equal(bot.sent.length, forwarded);
  assert.match(blocked.replies[0][0], /ဆက်တိုက်ပို့နေပါတယ်/i);
});

test("payment photo upload rechecks ownership and image size", async () => {
  const bot = await loadBot();
  await bot.action(await confirmationButton(bot, 19));
  await bot.action("payment_wallet_1");
  const oversized = bot.ctx();
  oversized.message = { photo: [{ file_id: "oversized", file_size: 20 * 1024 * 1024 + 1 }] };
  await bot.events.photo(oversized);
  assert.equal(bot.tables.Order[0].paymentProof, undefined);
  bot.tables.Order[0].customerId = 99;
  const alien = bot.ctx();
  alien.message = { photo: [{ file_id: "alien" }] };
  await bot.events.photo(alien);
  assert.equal(bot.tables.Order[0].paymentProof, undefined);
});

test("rapid distinct order confirmations are limited per customer", async () => {
  const bot = await loadBot();
  const callback = await confirmationButton(bot, 19);
  for (let messageId = 1; messageId <= 8; messageId++) {
    await bot.action(callback, 123, messageId);
    const order = bot.tables.Order.at(-1);
    if (order) order.status = "PAID";
  }
  assert.equal(bot.tables.Order.length, 6);
});

test("Main Menu pauses support while retaining the ticket and starts a fresh acknowledgement session on re-entry", async () => {
  const bot = await loadBot();
  await bot.action("contact_support", 123);
  const first = bot.ctx(123);
  first.message = { text: "hello" };
  await bot.events.text(first);
  assert.equal(first.replies.length, 1);
  const second = bot.ctx(123);
  second.message = { text: "another message" };
  await bot.events.text(second);
  assert.equal(second.replies.length, 0);
  const ticket = bot.tables.SupportTicket[0];
  const ordersBefore = bot.tables.Order.length;
  const subscriptionsBefore = bot.tables.Subscription.length;
  const menu = await bot.action("support_main_menu", 123);
  assert.equal(menu.replies.length, 2);
  assert.match(menu.replies[0][0], /Metro Secure မှ ကြိုဆိုပါတယ်/);
  assert.equal(buttons(menu.replies[0])[0][0].callback_data, "buy_vpn");
  assert.equal(ticket.status, "OPEN");
  assert.equal(ticket.customerInputActive, false);
  assert.equal(ticket.acknowledgedAt, null);
  assert.equal(bot.tables.SupportTicket.length, 1);
  assert.equal(bot.tables.Order.length, ordersBefore);
  assert.equal(bot.tables.Subscription.length, subscriptionsBefore);
  const whileInMenu = bot.ctx(123);
  whileInMenu.message = { text: "not a support message" };
  const adminMessagesBefore = bot.sent.length;
  await bot.events.text(whileInMenu);
  assert.equal(bot.sent.length, adminMessagesBefore);
  await bot.action("support_reply_1", 999);
  const adminReply = bot.ctx(999);
  adminReply.message = { text: "We are still here." };
  await bot.events.text(adminReply);
  assert.equal(bot.sent.at(-1).args[0], "123");
  assert.match(bot.sent.at(-1).args[1], /^🎧 Metro Secure Support\n\nWe are still here/);
  assertNoCustomerTicketDetails(bot.sent.at(-1).args[1]);
  await bot.action("contact_support", 123);
  assert.equal(bot.tables.SupportTicket.length, 1);
  assert.equal(ticket.id, 1);
  assert.equal(ticket.customerInputActive, true);
  const resumed = bot.ctx(123);
  resumed.message = { text: "hello again" };
  await bot.events.text(resumed);
  assert.equal(resumed.replies.length, 1);
  assert.match(bot.sent.at(-1).args[1], /SUP-0001[\s\S]*hello again/);
  const resumedSecond = bot.ctx(123);
  resumedSecond.message = { photo: [{ file_id: "second-session-image" }] };
  await bot.events.photo(resumedSecond);
  assert.equal(resumedSecond.replies.length, 0);
  assert.equal(bot.sent.at(-1).args[1], "second-session-image");
  const restarted = await loadBot(bot.tables);
  const afterRestart = restarted.ctx(123);
  afterRestart.message = { text: "still same session" };
  await restarted.events.text(afterRestart);
  assert.equal(afterRestart.replies.length, 0);
});

test("admin package edits appear on the next Buy VPN read and disabled packages reject old buttons", async () => {
  const bot = await loadBot();
  const originalScreen = await bot.action("buy_vpn");
  assert.match(originalScreen.replies[0][0], /🛡️ Basic\n50 GB\n30 ရက်\n3,200 ကျပ်/);
  const oldCallback = await confirmationButton(bot, 7);
  await updatePackage(bot.client, 7, {
    name: "Basic", dataLimitGb: 150, durationDays: 29,
    priceMmk: "6000", active: true, sortOrder: 1,
  });
  const updatedScreen = await bot.action("buy_vpn");
  assert.match(updatedScreen.replies[0][0], /🛡️ Basic\n150 GB\n29 ရက်\n6,000 ကျပ်/);
  assert.doesNotMatch(updatedScreen.replies[0][0], /\b(?:MMK|Ks)\b|\$6,000/);
  const stale = await bot.action(oldCallback);
  assert.match(stale.replies[0][0], /150 GB[\s\S]*29 ရက်[\s\S]*6,000/);
  assert.equal(bot.tables.Order.length, 0);
  const legacy = await bot.action("confirm_package_7_1");
  assert.match(legacy.replies[0][0], /6,000/);
  assert.equal(bot.tables.Order.length, 0);
  await updatePackage(bot.client, 7, {
    name: "Basic", dataLimitGb: 150, durationDays: 29,
    priceMmk: "6000", active: false, sortOrder: 1,
  });
  const inactiveScreen = await bot.action("buy_vpn");
  assert.doesNotMatch(inactiveScreen.replies[0][0], /Basic/);
  bot.tables.Package[2].sortOrder = 2;
  const tiedScreen = await bot.action("buy_vpn");
  assert.deepEqual(plain(buttons(tiedScreen.replies[0]).flat().map((button) => button.callback_data)
    .filter((value) => value.startsWith("package_"))),
    ["package_19", "package_25"]);
  for (const callback of ["package_7", "duration_7_1", oldCallback]) {
    const result = await bot.action(callback);
    assert.match(result.replies[0][0], /Package အသစ်ရွေးပေးပါ/);
    assert.match(backCode(result.replies[0]), /^nav_back_/);
  }
  assert.equal(bot.tables.Order.length, 0);
});

test("orders and approved entitlements keep snapshots when an admin edits the Package", async () => {
  const bot = await loadBot();
  const firstCallback = await confirmationButton(bot, 19);
  await bot.action(firstCallback);
  const firstOrder = bot.tables.Order[0];
  assert.equal(firstOrder.totalDataGb, 213);
  assert.equal(firstOrder.totalDurationDays, 31);
  assert.equal(firstOrder.price, 7650);
  await updatePackage(bot.client, 19, {
    name: "Renamed", dataLimitGb: 300, durationDays: 45,
    priceMmk: "9000", active: true, sortOrder: 2,
  });
  assert.equal(firstOrder.plan, "Standard - 31 Days");
  assert.equal(firstOrder.totalDataGb, 213);
  assert.equal(firstOrder.totalDurationDays, 31);
  assert.equal(firstOrder.price, 7650);
  await bot.action("approve_payment_1", 999);
  const subscription = bot.tables.Subscription[0];
  assert.equal(subscription.plan, firstOrder.plan);
  assert.equal(subscription.dataLimitGb, 213);
  assert.equal(subscription.expiresAt.toString(), firstOrder.expiresAt.toString());
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /Package: Standard - 31 ရက်/);
  assert.doesNotMatch(myVpn.replies[0][0], /Renamed/);
  const originalExpiry = subscription.expiresAt;
  await updatePackage(bot.client, 19, {
    name: "Renamed", dataLimitGb: 320, durationDays: 46,
    priceMmk: "9500", active: true, sortOrder: 2,
  });
  assert.equal(subscription.dataLimitGb, 213);
  assert.equal(subscription.expiresAt.toString(), originalExpiry.toString());
  const renewalCallback = await confirmationButton(bot, 19, 1, true);
  await bot.action(renewalCallback, 123, 2);
  const renewal = bot.tables.Order[1];
  assert.equal(renewal.plan, "Renamed - 46 Days");
  assert.equal(renewal.price, 9500);
  assert.equal(renewal.totalDataGb, 320);
  assert.equal(renewal.totalDurationDays, 46);
  assert.equal(subscription.dataLimitGb, 213);
  assert.equal(subscription.expiresAt.toString(), originalExpiry.toString());
  await bot.action("approve_payment_2", 999);
  assert.equal(subscription.dataLimitGb, 533);
  assert.equal(subscription.expiresAt.toString(), originalExpiry.add({ hours: 46 * 24 }).toString());
});

test("30-day activation and renewal add exactly 60 days in total, including retry", async () => {
  const bot = await loadBot();
  await bot.action(await confirmationButton(bot, 7));
  const first = bot.tables.Order[0];
  assert.equal(first.totalDurationDays, 30);
  await bot.action("approve_payment_1", 999);
  const subscription = bot.tables.Subscription[0];
  assert.equal(first.status, "PAID");
  assert.equal(first.expiresAt.epochMilliseconds - first.startedAt.epochMilliseconds, 30 * 86400000);
  const initialExpiry = subscription.expiresAt;
  await bot.action(await confirmationButton(bot, 7, 1, true), 123, 140);
  const renewal = bot.tables.Order[1];
  assert.equal(renewal.totalDurationDays, 30);
  await bot.action("approve_payment_2", 999);
  assert.equal(renewal.status, "PAID");
  assert.equal(subscription.expiresAt.epochMilliseconds - initialExpiry.epochMilliseconds, 30 * 86400000);
  assert.equal(subscription.expiresAt.epochMilliseconds - first.startedAt.epochMilliseconds, 60 * 86400000);
  await bot.action("approve_payment_2", 999);
  assert.equal(subscription.expiresAt.epochMilliseconds - first.startedAt.epochMilliseconds, 60 * 86400000);
});

test("expired 30-day renewal restarts from approval time", async () => {
  const bot = await loadBot();
  await bot.action(await confirmationButton(bot, 7));
  await bot.action("approve_payment_1", 999);
  const subscription = bot.tables.Subscription[0];
  subscription.expiresAt = Temporal.Now.instant().subtract({ hours: 5 * 24 });
  await bot.action(await confirmationButton(bot, 7, 1, true), 123, 141);
  const before = Temporal.Now.instant().epochMilliseconds;
  await bot.action("approve_payment_2", 999);
  const after = Temporal.Now.instant().epochMilliseconds;
  assert.equal(bot.tables.Order[1].totalDurationDays, 30);
  assert.ok(subscription.expiresAt.epochMilliseconds >= before + 30 * 86400000);
  assert.ok(subscription.expiresAt.epochMilliseconds <= after + 30 * 86400000);
});

test("My Orders uses saved days and omits activated status without changing database status", async () => {
  const bot = await loadBot();
  await bot.action(await confirmationButton(bot, 7));
  const first = bot.tables.Order[0];
  first.status = "PAID";
  first.plan = "Basic - 1 Month"; // Historical label, preserved in storage.
  bot.tables.Order.push({ ...first, id: 2, orderNumber: "VPN-HISTORICAL-60",
    totalDurationDays: 60, durationMonths: 2, status: "PROCESSING" });
  bot.tables.Package[0].durationDays = 45;
  const result = await bot.action("my_orders");
  const message = result.replies[0][0];
  assert.match(message, /သက်တမ်း: 30 ရက်/);
  assert.match(message, /သက်တမ်း: 60 ရက်/);
  assert.doesNotMatch(message, /သက်တမ်း: .* လ|1 Month|2 Months/);
  assert.doesNotMatch(message, /အခြေအနေ: ငွေပေးချေပြီး/);
  assert.match(message, /အခြေအနေ: ခဏစောင့်ပေးပါ/);
  assert.equal(first.status, "PAID");
  assert.equal(first.totalDurationDays, 30);
  assert.equal(first.plan, "Basic - 1 Month");
});

test("repeated confirmations reuse one order and preserve its price and terminal status", async () => {
  const bot = await loadBot();
  const callback = await confirmationButton(bot, 19);
  await Promise.all(Array.from({ length: 5 }, () => bot.action(callback, 123, 40)));
  assert.equal(bot.tables.Order.length, 1);
  const order = bot.tables.Order[0];
  const payment = await bot.action(callback, 123, 40);
  assert.match(payment.replies[0][0], /Payment[\s\S]*7,650 ကျပ်\n/);
  assert.equal(buttons(payment.replies[0])[0].length, 2);
  for (const status of ["PAID", "PROCESSING", "CANCELLED", "PAYMENT_REJECTED"]) {
    order.status = status;
    const repeated = await bot.action(callback, 123, 40);
    assert.equal(bot.tables.Order.length, 1);
    assert.equal(order.status, status);
    assert.match(repeated.replies[0][0], /My Orders ကိုနှိပ်ပါ/);
  }
  bot.tables.Package[1].priceMmk = "8000";
  const stale = await bot.action(callback, 123, 40);
  assert.match(stale.replies[0][0], /8,000/);
  assert.equal(order.price, 7650);
  assert.equal(bot.tables.Order.length, 1);
  const refreshed = await confirmationButton(bot, 19);
  await bot.action(refreshed, 123, 41);
  assert.equal(bot.tables.Order.length, 2);
  assert.equal(bot.keyCalls.length, 0);
});

test("purchase without Outline, approval, setup and renewal retain a single real key and dynamic token", async () => {
  const bot = await loadBot();
  await bot.action(await confirmationButton(bot, 19));
  await bot.action("payment_wallet_1");
  const photo = bot.ctx();
  photo.message = { photo: [{ file_id: "synthetic-proof" }] };
  await bot.events.photo(photo);
  assert.equal(bot.tables.Order[0].paymentProof, "synthetic-proof");
  assert.equal(bot.sent[0].type, "photo");
  await bot.action("approve_payment_1", 123);
  assert.equal(bot.keyCalls.length, 0);
  await Promise.all([bot.action("approve_payment_1", 999), bot.action("approve_payment_1", 999)]);
  assert.equal(bot.keyCalls.length, 1);
  assert.equal(bot.tables.Order[0].status, "PAID");
  const subscription = bot.tables.Subscription[0];
  const key = subscription.vpnKey;
  const activated = bot.sent.find((sent) => sent.type === "message").args;
  assert.match(activated[1], /VPN ဖွင့်ပေးပြီးပါပြီ။/);
  assert.match(activated[1], /VPN ချိတ်ဆက်ဖို့ Outline app လိုပါတယ်။/);
  assert.match(activated[1], /Outline မရှိသေးရင် အရင်ဆုံး download လုပ်ပေးပါ။/);
  assert.equal(activated[1].includes(key), false);
  const dynamicKey = activated[2].reply_markup.inline_keyboard[1][0].copy_text.text;
  assert.equal(decodeURIComponent(new URL(dynamicKey).hash.slice(1)), "Metro Secure | Test");
  const keyId = subscription.vpnKeyId;
  const dynamicState = Object.fromEntries(Object.entries(subscription).filter(([field]) => field.startsWith("dynamicToken")));
  assert.ok(Object.keys(dynamicState).length > 0);
  assert.match(dynamicKey, /^ssconf:\/\//);
  assert.match(activated[1], /ssconf:\/\//);
  assert.equal(activated[1].includes(key), false);
  subscription.dataUsedGb = 35;
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /35 GB \/ 213 GB/);
  assert.equal(myVpn.replies[0][0].includes(key), false);
  assert.deepEqual(plain(buttons(myVpn.replies[0]).map((row) => row.length)), [2, 2, 1]);
  for (const callback of ["setup_vpn", "add_device", "connection_link", "setup_platform_ios"]) {
    const setup = await bot.action(callback);
    assert.equal(buttons(setup.replies[0])[0][0].copy_text.text, dynamicKey);
    assert.match(buttons(setup.replies[0])[0][1].url, /^https:\/\/vpn.example.test\/connect\/v1\./);
    assert.deepEqual(Object.fromEntries(Object.entries(subscription).filter(([field]) => field.startsWith("dynamicToken"))), dynamicState);
  }
  await bot.action("copy_vpn_key");
  await bot.action("my_orders");
  assert.equal(bot.keyCalls.length, 1);
  const originalExpiry = subscription.expiresAt;
  await bot.action("renew_vpn");
  await bot.action("renew_package_19");
  const renewalCallback = await confirmationButton(bot, 19, 3, true);
  await Promise.all([bot.action(renewalCallback, 123, 50), bot.action(renewalCallback, 123, 50)]);
  assert.equal(bot.tables.Order.length, 2);
  await bot.action("approve_payment_2", 999);
  assert.equal(bot.keyCalls.length, 1);
  assert.equal(bot.tables.Subscription.length, 1);
  assert.equal(subscription.vpnKey, key);
  const renewed = await bot.action("setup_vpn");
  assert.equal(subscription.vpnKeyId, keyId);
  assert.deepEqual(Object.fromEntries(Object.entries(subscription).filter(([field]) => field.startsWith("dynamicToken"))), dynamicState);
  assert.equal(buttons(renewed.replies[0])[0][0].copy_text.text, dynamicKey);
  assert.equal(subscription.dataLimitGb, 852);
  assert.equal(subscription.expiresAt.toString(), originalExpiry.add({ hours: 93 * 24 }).toString());
  assert.equal(bot.limitCalls.at(-1).bytes, 852 * 1024 ** 3);
});

test("restart after failed order key write recovers the same Outline key", async () => {
  const outlineKeys = new Map();
  const first = await loadBot(null, outlineKeys);
  await first.action(await confirmationButton(first, 19));
  const originalWhere = first.client.public.Order.where;
  let failed = false;
  first.client.public.Order.where = (filter) => {
    const query = originalWhere(filter);
    const originalUpdate = query.update;
    query.update = async (data) => {
      if (data.vpnKey && !failed) { failed = true; throw new Error("synthetic DB failure"); }
      return originalUpdate(data);
    };
    return query;
  };
  await first.action("approve_payment_1", 999);
  assert.equal(first.tables.Order[0].status, "PROCESSING");
  assert.equal(first.tables.Order[0].vpnKey, undefined);
  assert.equal(outlineKeys.size, 1);
  first.tables.Order[0].processingAt = Temporal.Now.instant().subtract({ minutes: 20 });
  const restarted = await loadBot(first.tables, outlineKeys);
  await restarted.action("approve_payment_1", 999);
  assert.equal(restarted.tables.Order[0].status, "PAID");
  assert.equal(restarted.keyCalls.length, 0);
  assert.equal(outlineKeys.size, 1);
});

test("renewal retry after the subscription write keeps the exact expiry and data limit", async () => {
  const bot = await loadBot();
  await bot.action(await confirmationButton(bot, 7));
  await bot.action("approve_payment_1", 999);
  bot.tables.Subscription[0].status = "DATA_LIMIT_REACHED";
  bot.tables.Subscription[0].dataUsedGb = bot.tables.Subscription[0].dataLimitGb;
  await bot.action(await confirmationButton(bot, 7, 1, true), 123, 88);
  const originalWhere = bot.client.public.Order.where;
  let failed = false;
  bot.client.public.Order.where = (filter) => {
    const query = originalWhere(filter);
    const originalUpdate = query.updateAll;
    query.updateAll = async (data) => {
      if (filter.id === 2 && data.status === "PAID" && !failed) {
        failed = true;
        throw new Error("synthetic order write failure");
      }
      return originalUpdate(data);
    };
    return query;
  };
  await bot.action("approve_payment_2", 999);
  const subscription = bot.tables.Subscription[0];
  const expiry = subscription.expiresAt.toString();
  const limit = subscription.dataLimitGb;
  assert.equal(subscription.status, "ACTIVE");
  assert.equal(bot.tables.Order[1].status, "PROCESSING");
  bot.tables.Order[1].processingAt = Temporal.Now.instant().subtract({ minutes: 20 });
  await bot.recover();
  await bot.action("approve_payment_2", 999);
  assert.equal(subscription.expiresAt.toString(), expiry);
  assert.equal(subscription.dataLimitGb, limit);
  assert.equal(bot.tables.Order[1].status, "PAID");
});

test("legacy orders reuse a saved order but do not create an untraceable new key", async () => {
  const bot = await loadBot();
  const callback = await confirmationButton(bot, 19);
  await bot.action(callback, 123, 73);
  const order = bot.tables.Order[0];
  order.orderNumber = order.orderNumber.replace("VPN-I", "VPN-");
  await bot.action(callback, 123, 73);
  assert.equal(bot.tables.Order.length, 1);
  await bot.action("approve_payment_1", 999);
  assert.equal(bot.keyCalls.length, 0);
  assert.equal(order.status, "PROCESSING");
});

test("missing-key replacement, rejection, cancellation and PROCESSING recovery still work", async () => {
  const bot = await loadBot();
  const purchaseCallback = await confirmationButton(bot, 7);
  await bot.action(purchaseCallback);
  await bot.action("approve_payment_1", 999);
  const subscription = bot.tables.Subscription[0];
  bot.missingKeys.add(subscription.vpnKeyId);
  await bot.action(await confirmationButton(bot, 7, 1, true), 123, 2);
  await bot.action("approve_payment_2", 999);
  assert.equal(bot.keyCalls.length, 2);
  assert.equal(bot.tables.Subscription.length, 1);
  assert.equal(subscription.vpnKeyId, "real-test-2");
  await bot.action("approve_payment_2", 999);
  assert.equal(bot.keyCalls.length, 2);
  await bot.action(purchaseCallback, 123, 3);
  await bot.action("reject_payment_3", 999);
  assert.equal(bot.tables.Order[2].status, "PAYMENT_REJECTED");
  await bot.action(purchaseCallback, 123, 4);
  await bot.action("cancel_order_4");
  assert.equal(bot.tables.Order[3].status, "CANCELLED");
  const order = bot.tables.Order[0];
  order.status = "PROCESSING";
  order.processingAt = Temporal.Now.instant().subtract({ minutes: 20 });
  const savedKey = order.vpnKey;
  await bot.recover();
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(order.vpnKey, savedKey);
  assert.equal(bot.keyCalls.length, 2);
});
