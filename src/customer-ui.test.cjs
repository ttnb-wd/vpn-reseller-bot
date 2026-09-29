const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { Temporal } = require("@js-temporal/polyfill");

// Exercise the real registered handlers using synthetic data, without polling
// Telegram or connecting to production PostgreSQL / Outline.
async function loadBot() {
  const file = path.join(__dirname, "bot.js");
  const source = readFileSync(file, "utf8");
  const localRequire = createRequire(file);
  const tables = {
    Customer: [], Order: [], Subscription: [],
    Package: [
      { id: 7, name: "Basic", dataLimitGb: 50, durationDays: 30, priceMmk: "3200", active: true, sortOrder: 1 },
      { id: 19, name: "Standard", dataLimitGb: 213, durationDays: 31, priceMmk: "7650", active: true, sortOrder: 2 },
      { id: 25, name: "Premium", dataLimitGb: 400, durationDays: 32, priceMmk: "12000", active: true, sortOrder: 3 },
      { id: 99, name: "Retired", active: false, sortOrder: 4 },
    ],
  };
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
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
        const selected = () => rows.filter((row) => matches(row, filter));
        return {
          async first() { const row = selected()[0]; return row ? { ...row } : null; },
          async all() { return selected().map((row) => ({ ...row })); },
          orderBy() { return this; },
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
      },
    };
  }
  const handlers = [];
  const events = {};
  const sent = [];
  const keyCalls = [];
  const limitCalls = [];
  const missingKeys = new Set();
  let usageByKeyId = {};
  let existingKeyIds = new Set();
  let metricsUnavailable = false;
  const fakeApp = {
    set() {}, get() {},
    listen() {
      const server = new EventEmitter();
      queueMicrotask(() => server.emit("listening"));
      return server;
    },
  };
  class FakeTelegraf {
    constructor() {
      this.telegram = {
        async sendMessage(...args) { sent.push({ type: "message", args }); },
        async sendPhoto(...args) { sent.push({ type: "photo", args }); },
      };
    }
    start(fn) { events.start = fn; }
    command() {}
    action(pattern, fn) { handlers.push({ pattern, fn }); }
    on(event, fn) { events[event] = fn; }
    catch() {}
    async launch() {}
  }
  const context = vm.createContext({
    __dirname: __dirname,
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "express") return () => fakeApp;
      if (name === "telegraf") return { ...localRequire(name), Telegraf: FakeTelegraf };
      if (name === "./db") return { async createDatabase() { return { client }; } };
      if (name === "./outline") return {
        validateOutlineConfig() {}, async testOutlineConnection() {},
        async getAllAccessKeyUsage() {
          if (metricsUnavailable) throw new Error("Private management URL");
          return usageByKeyId;
        },
        async getExistingAccessKeyIds() { return existingKeyIds; },
        async createAccessKey(order) {
          keyCalls.push(order.id);
          return { id: `real-test-${keyCalls.length}`, accessUrl: `ss://synthetic@192.0.2.1:1234#${keyCalls.length}` };
        },
        async setAccessKeyDataLimit(id, bytes) {
          limitCalls.push({ id, bytes });
          if (missingKeys.has(id)) throw Object.assign(new Error("Missing"), { missing: true });
        },
        isAccessKeyNotFoundError(error) { return error.missing === true; },
      };
      return localRequire(name);
    },
    process: {
      env: { ADMIN_TELEGRAM_ID: "999", PUBLIC_BASE_URL: "https://vpn.example.test", CONNECT_TOKEN_SECRET: "test-secret-".repeat(4) },
      once() {},
    },
    Buffer, URL, setTimeout, clearTimeout, setInterval() {},
    console: { log() {}, error() {}, warn() {} }, module: { exports: {} },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("\nstartBot().catch(")) + `
    module.exports = { startBot, recoverStuckProcessingOrders, syncAccessKeyUsage };
  `, context, { filename: file });
  await context.module.exports.startBot();
  await new Promise(setImmediate);

  function ctx(userId = 123, messageId = 1) {
    const replies = [];
    return {
      from: { id: userId, first_name: "Test" }, replies,
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
  return { tables, events, handlers, sent, keyCalls, limitCalls, missingKeys, ctx, action,
    recover: context.module.exports.recoverStuckProcessingOrders,
    syncUsage: context.module.exports.syncAccessKeyUsage,
    setUsage(value, ids) { usageByKeyId = value; existingKeyIds = new Set(ids); },
    setMetricsUnavailable(value) { metricsUnavailable = value; } };
}

function buttons(reply) { return reply[1].reply_markup.inline_keyboard; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

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
  assert.equal(bot.tables.Subscription[1].dataUsedGb, 4);
  assert.equal(bot.tables.Subscription[2].dataUsedGb, 4);
  assert.equal(bot.keyCalls.length, 0);
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /1\.5 GB \/ 213 GB/);
  assert.match(myVpn.replies[0][0], /30 ရက်/);

  bot.setUsage({ "real-1": Number.MAX_SAFE_INTEGER + 1 }, ["real-1"]);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 1.5);
  bot.setMetricsUnavailable(true);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 1.5);
  bot.setMetricsUnavailable(false);
  bot.setUsage({}, ["real-1"]);
  await bot.syncUsage();
  assert.equal(subscription.dataUsedGb, 0);
  assert.equal(bot.keyCalls.length, 0);
});

test("welcome, packages, confirmation and help only read customer data", async () => {
  const bot = await loadBot();
  const welcome = bot.ctx();
  await bot.events.start(welcome);
  assert.match(welcome.replies[0][0], /Metro VPN မှ ကြိုဆိုပါတယ်/);
  assert.deepEqual(plain(buttons(welcome.replies[0]).map((row) => row.map((b) => b.text))), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["🗂️ My Orders", "🛰️ Setup VPN"], ["🎧 Help"],
  ]);
  const packages = await bot.action("buy_vpn");
  assert.deepEqual(plain(buttons(packages.replies[0])[0].map((b) => b.callback_data)), ["package_7", "package_19"]);
  assert.equal(buttons(packages.replies[0])[1][0].text, "💎 Premium");
  assert.equal(JSON.stringify(packages.replies).includes("Retired"), false);
  const detail = await bot.action("package_19");
  assert.match(detail.replies[0][0], /STANDARD PLAN[\s\S]*213 GB[\s\S]*31 ရက်[\s\S]*7,650\n/);
  assert.equal(buttons(detail.replies[0])[0][0].callback_data, "duration_19_1");
  assert.equal(buttons(detail.replies[0])[1].length, 2);
  const confirm = await bot.action("duration_19_3");
  assert.match(confirm.replies[0][0], /မှာယူမှု အတည်ပြုပါ[\s\S]*639 GB[\s\S]*93 ရက်[\s\S]*22,950\n/);
  assert.equal(buttons(confirm.replies[0])[0][0].callback_data, "confirm_package_19_3");
  assert.match((await bot.action("package_99")).replies[0][0], /လောလောဆယ် မရနိုင်ပါ/);
  assert.match((await bot.action("help")).replies[0][0], /Metro VPN အကူအညီ/);
  assert.match((await bot.action("payment_help")).replies[0][0], /ငွေပမာဏအတိအကျ/);
  assert.equal(bot.tables.Order.length, 0);
  assert.equal(bot.keyCalls.length, 0);
});

test("repeated confirmations reuse one order and preserve its price and terminal status", async () => {
  const bot = await loadBot();
  await Promise.all(Array.from({ length: 5 }, () => bot.action("confirm_package_19_1", 123, 40)));
  assert.equal(bot.tables.Order.length, 1);
  const order = bot.tables.Order[0];
  const payment = await bot.action("confirm_package_19_1", 123, 40);
  assert.match(payment.replies[0][0], /🧾 Payment[\s\S]*7,650\n/);
  assert.equal(buttons(payment.replies[0])[0].length, 2);
  bot.tables.Package[1].priceMmk = "8000";
  await bot.action("confirm_package_19_1", 123, 40);
  assert.equal(order.price, 7650);
  for (const status of ["PAID", "PROCESSING", "CANCELLED", "PAYMENT_REJECTED"]) {
    order.status = status;
    const repeated = await bot.action("confirm_package_19_1", 123, 40);
    assert.equal(bot.tables.Order.length, 1);
    assert.equal(order.status, status);
    assert.match(repeated.replies[0][0], /My Orders ကိုနှိပ်ပါ/);
  }
  await bot.action("confirm_package_19_1", 123, 41);
  assert.equal(bot.tables.Order.length, 2);
  assert.equal(bot.keyCalls.length, 0);
});

test("payment proof, approval, My VPN, setup and renewal retain a single real key", async () => {
  const bot = await loadBot();
  await bot.action("confirm_package_19_1");
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
  assert.match(activated[1], /VPN အဆင်သင့်ဖြစ်ပါပြီ/);
  assert.equal(activated[1].includes(key), false);
  assert.equal(activated[2].reply_markup.inline_keyboard[0][1].copy_text.text, key);
  subscription.dataUsedGb = 35;
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /35 GB \/ 213 GB/);
  assert.equal(myVpn.replies[0][0].includes(key), false);
  assert.deepEqual(plain(buttons(myVpn.replies[0]).map((row) => row.length)), [2, 2]);
  for (const callback of ["setup_vpn", "add_device", "connection_link", "setup_platform_ios"]) {
    const setup = await bot.action(callback);
    assert.equal(buttons(setup.replies[0])[0][0].copy_text.text, key);
    assert.match(buttons(setup.replies[0])[0][1].url, /^https:\/\/vpn.example.test\/connect\/v1\./);
  }
  await bot.action("copy_vpn_key");
  await bot.action("my_orders");
  assert.equal(bot.keyCalls.length, 1);
  const originalExpiry = subscription.expiresAt;
  await bot.action("renew_vpn");
  await bot.action("renew_package_19");
  await bot.action("renew_duration_19_3");
  await Promise.all([bot.action("confirm_renewal_19_3", 123, 50), bot.action("confirm_renewal_19_3", 123, 50)]);
  assert.equal(bot.tables.Order.length, 2);
  await bot.action("approve_payment_2", 999);
  assert.equal(bot.keyCalls.length, 1);
  assert.equal(bot.tables.Subscription.length, 1);
  assert.equal(subscription.vpnKey, key);
  assert.equal(subscription.dataLimitGb, 852);
  assert.equal(subscription.expiresAt.toString(), originalExpiry.add({ hours: 93 * 24 }).toString());
  assert.equal(bot.limitCalls.at(-1).bytes, 852 * 1024 ** 3);
});

test("missing-key replacement, rejection, cancellation and PROCESSING recovery still work", async () => {
  const bot = await loadBot();
  await bot.action("confirm_package_7_1");
  await bot.action("approve_payment_1", 999);
  const subscription = bot.tables.Subscription[0];
  bot.missingKeys.add(subscription.vpnKeyId);
  await bot.action("confirm_renewal_7_1", 123, 2);
  await bot.action("approve_payment_2", 999);
  assert.equal(bot.keyCalls.length, 2);
  assert.equal(bot.tables.Subscription.length, 1);
  assert.equal(subscription.vpnKeyId, "real-test-2");
  await bot.action("approve_payment_2", 999);
  assert.equal(bot.keyCalls.length, 2);
  await bot.action("confirm_package_7_1", 123, 3);
  await bot.action("reject_payment_3", 999);
  assert.equal(bot.tables.Order[2].status, "PAYMENT_REJECTED");
  await bot.action("confirm_package_7_1", 123, 4);
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
