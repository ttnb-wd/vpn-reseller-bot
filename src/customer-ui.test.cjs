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
async function loadBot() {
  const file = path.join(__dirname, "bot.js");
  const source = readFileSync(file, "utf8");
  const localRequire = createRequire(file);
  const tables = {
    Customer: [], Order: [], Subscription: [], SupportTicket: [],
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
    set() {}, get() {}, use() {},
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
      if (name === "./admin-auth") return {
        validateAdminConfig() { return { email: "admin@example.test" }; },
        createAdminRouter() { return () => {}; },
      };
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
  return { tables, client, events, handlers, sent, keyCalls, limitCalls, missingKeys, ctx, action,
    recover: context.module.exports.recoverStuckProcessingOrders,
    syncUsage: context.module.exports.syncAccessKeyUsage,
    setUsage(value, ids) { usageByKeyId = value; existingKeyIds = new Set(ids); },
    setMetricsUnavailable(value) { metricsUnavailable = value; } };
}

function buttons(reply) { return reply[1].reply_markup.inline_keyboard; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
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
  assert.match(buttons(confirm.replies[0])[0][0].callback_data, /^confirm_package_19_3_[a-f0-9]{16}$/);
  assert.match((await bot.action("package_99")).replies[0][0], /Package အသစ်ရွေးပေးပါ/);
  const help = await bot.action("help");
  assert.match(help.replies[0][0], /🎧 Help/);
  assert.equal(buttons(help.replies[0])[0][0].callback_data, "contact_support");
  assert.equal(JSON.stringify(help.replies).includes("tg://user"), false);
  assert.match((await bot.action("payment_help")).replies[0][0], /ငွေပမာဏအတိအကျ/);
  assert.equal(bot.tables.Order.length, 0);
  assert.equal(bot.keyCalls.length, 0);
});

test("support opens persistent per-customer tickets and relays text and photos to admin", async () => {
  const bot = await loadBot();
  const first = await bot.action("contact_support", 123);
  const second = await bot.action("contact_support", 456);
  assert.match(first.replies[1][0], /SUP-0001/);
  assert.match(second.replies[1][0], /SUP-0002/);
  assert.equal(bot.tables.SupportTicket.length, 2);
  const textMessage = bot.ctx(123);
  textMessage.message = { text: "Please help with my VPN" };
  await bot.events.text(textMessage);
  assert.equal(bot.sent.at(-1).args[0], "999");
  assert.match(bot.sent.at(-1).args[1], /SUP-0001[\s\S]*Telegram ID: 123[\s\S]*Please help/);
  assert.equal(bot.sent.at(-1).args[2].reply_markup.inline_keyboard[0][0].callback_data,
    "support_reply_1");
  const sensitiveText = bot.ctx(123);
  sensitiveText.message = { text: "Please inspect ss://private-key-data" };
  await bot.events.text(sensitiveText);
  assert.equal(bot.sent.at(-1).args[1].includes("ss://private-key-data"), false);
  const photo = bot.ctx(456);
  photo.message = { photo: [{ file_id: "support-image" }], caption: "Screenshot" };
  await bot.events.photo(photo);
  assert.equal(bot.sent.at(-1).type, "photo");
  assert.equal(bot.sent.at(-1).args[0], "999");
  assert.equal(bot.sent.at(-1).args[1], "support-image");
  assert.match(bot.sent.at(-1).args[2].caption, /SUP-0002[\s\S]*Screenshot/);
  assert.equal(bot.tables.Order.length, 0);
  const repeat = await bot.action("contact_support", 123);
  assert.match(repeat.replies[1][0], /SUP-0001/);
  assert.equal(bot.tables.SupportTicket.length, 2);
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
  assert.equal(bot.tables.SupportTicket[1].adminReplySelected, false);
  await bot.action("support_reply_1", 999);
  const adminPhoto = bot.ctx(999);
  adminPhoto.message = { photo: [{ file_id: "admin-image" }], caption: "Try this" };
  await bot.events.photo(adminPhoto);
  assert.equal(bot.sent.at(-1).args[0], "123");
  assert.match(bot.sent.at(-1).args[2].caption, /Metro Secure Support[\s\S]*Try this/);
  assert.equal(bot.sent.at(-1).args[2].caption.includes("999"), false);
  const nonAdminClose = await bot.action("support_close_2", 123);
  assert.equal(nonAdminClose.replies.length, 0);
  assert.equal(bot.tables.SupportTicket[1].status, "OPEN");
  await bot.action("support_close_2", 999);
  assert.equal(bot.tables.SupportTicket[1].status, "CLOSED");
  assert.ok(bot.tables.SupportTicket[1].closedAt);
  assert.equal(bot.sent.at(-1).args[0], "456");
  assert.match(bot.sent.at(-1).args[1], /Support ticket ပိတ်ပြီးပါပြီ/);
  const reopened = await bot.action("contact_support", 456);
  assert.match(reopened.replies[1][0], /SUP-0003/);
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
  await bot.action("payment_wallet_1");
  assert.equal(bot.tables.SupportTicket[0].customerInputActive, false);
});

test("admin package edits appear on the next Buy VPN read and disabled packages reject old buttons", async () => {
  const bot = await loadBot();
  const originalScreen = await bot.action("buy_vpn");
  assert.match(originalScreen.replies[0][0], /🛡️ Basic • 50 GB • 30 Days • 3,200/);
  const oldCallback = await confirmationButton(bot, 7);
  await updatePackage(bot.client, 7, {
    name: "Basic", dataLimitGb: 150, durationDays: 29,
    priceMmk: "6000", active: true, sortOrder: 1,
  });
  const updatedScreen = await bot.action("buy_vpn");
  assert.match(updatedScreen.replies[0][0], /🛡️ Basic • 150 GB • 29 Days • 6,000/);
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
    assert.equal(buttons(result.replies[0])[0][0].callback_data, "buy_vpn");
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
  assert.equal(firstOrder.plan, "Standard - 1 Month");
  assert.equal(firstOrder.totalDataGb, 213);
  assert.equal(firstOrder.totalDurationDays, 31);
  assert.equal(firstOrder.price, 7650);
  await bot.action("approve_payment_1", 999);
  const subscription = bot.tables.Subscription[0];
  assert.equal(subscription.plan, firstOrder.plan);
  assert.equal(subscription.dataLimitGb, 213);
  assert.equal(subscription.expiresAt.toString(), firstOrder.expiresAt.toString());
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /Package: Standard - 1 Month/);
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
  assert.equal(renewal.plan, "Renamed - 1 Month");
  assert.equal(renewal.price, 9500);
  assert.equal(renewal.totalDataGb, 320);
  assert.equal(renewal.totalDurationDays, 46);
  assert.equal(subscription.dataLimitGb, 213);
  assert.equal(subscription.expiresAt.toString(), originalExpiry.toString());
  await bot.action("approve_payment_2", 999);
  assert.equal(subscription.dataLimitGb, 533);
  assert.equal(subscription.expiresAt.toString(), originalExpiry.add({ hours: 46 * 24 }).toString());
});

test("repeated confirmations reuse one order and preserve its price and terminal status", async () => {
  const bot = await loadBot();
  const callback = await confirmationButton(bot, 19);
  await Promise.all(Array.from({ length: 5 }, () => bot.action(callback, 123, 40)));
  assert.equal(bot.tables.Order.length, 1);
  const order = bot.tables.Order[0];
  const payment = await bot.action(callback, 123, 40);
  assert.match(payment.replies[0][0], /🧾 Payment[\s\S]*7,650\n/);
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

test("payment proof, approval, My VPN, setup and renewal retain a single real key", async () => {
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
  const renewalCallback = await confirmationButton(bot, 19, 3, true);
  await Promise.all([bot.action(renewalCallback, 123, 50), bot.action(renewalCallback, 123, 50)]);
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
