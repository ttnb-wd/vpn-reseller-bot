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
    Customer: [], Order: [], Subscription: [], SupportTicket: [],
    Package: [
      { id: 7, name: "Basic", dataLimitGb: 50, durationDays: 30, priceMmk: "3200", active: true, sortOrder: 1 },
      { id: 19, name: "Standard", dataLimitGb: 213, durationDays: 31, priceMmk: "7650", active: true, sortOrder: 2 },
      { id: 25, name: "Premium", dataLimitGb: 400, durationDays: 32, priceMmk: "12000", active: true, sortOrder: 3 },
      { id: 99, name: "Retired", active: false, sortOrder: 4 },
    ],
  };
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const predicateFor = (filter) => typeof filter === "function"
    ? filter(new Proxy({}, { get: (_target, field) => ({
      isNull: () => (row) => row[field] == null,
    }) }))
    : (row) => matches(row, filter);
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
  const errors = [];
  const keyCalls = [];
  const limitCalls = [];
  const missingKeys = new Set();
  let miniAppCallbacks;
  let usageByKeyId = {};
  let existingKeyIds = new Set();
  let metricsUnavailable = false;
  const fakeApp = {
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
        async sendMessage(...args) { sent.push({ type: "message", args }); },
        async sendPhoto(...args) { sent.push({ type: "photo", args }); },
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
    async launch() {
      launchCalls.push(true);
      if (options.pollingStaysActive) await new Promise(() => {});
    }
    stop(signal) { stopCalls.push(signal); }
  }
  const context = vm.createContext({
    __dirname: __dirname,
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "./mini-app") return { createMiniAppRouter(args) { miniAppCallbacks = args; return () => {}; } };
      if (name === "express") return () => fakeApp;
      if (name === "telegraf") return { ...localRequire(name), Telegraf: FakeTelegraf };
      if (name === "./db") return { async createDatabase() {
        return { client, runtime: { async close() { runtimeCloses.push(true); } } };
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
          if (missingKeys.has(id)) throw Object.assign(new Error("Missing"), { missing: true });
        },
        isAccessKeyNotFoundError(error) { return error.missing === true; },
      };
      return localRequire(name);
    },
    process: {
      env: { ADMIN_TELEGRAM_ID: "999", PUBLIC_BASE_URL: "https://vpn.example.test", CONNECT_TOKEN_SECRET: "test-secret-".repeat(4) },
      once(signal, handler) { signals[signal] = handler; },
      exit(code) { exits.push(code); },
    },
    Buffer, URL, setTimeout, clearTimeout, clearInterval, setInterval() {},
    console: { log() {}, error(...args) { errors.push(args); }, warn() {} }, module: { exports: {} },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("\nstartBot().catch(")) + `
    module.exports = { startBot, recoverStuckProcessingOrders, syncAccessKeyUsage,
      miniAppCreateOrder, packageVersion };
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
    miniAppCallbacks,
    launchCalls, stopCalls, signals, exits, runtimeCloses, serverCloses, errors,
    keyCalls, limitCalls, missingKeys, ctx, action,
    recover: context.module.exports.recoverStuckProcessingOrders,
    syncUsage: context.module.exports.syncAccessKeyUsage,
    miniAppCreateOrder: context.module.exports.miniAppCreateOrder,
    packageVersion: context.module.exports.packageVersion,
    setUsage(value, ids) { usageByKeyId = value; existingKeyIds = new Set(ids); },
    setMetricsUnavailable(value) { metricsUnavailable = value; } };
}

function buttons(reply) { return reply[1].reply_markup.inline_keyboard; }
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
  assert.match(welcome.replies[0][0], /Metro VPN မှ ကြိုဆိုပါတယ်/);
  assert.deepEqual(plain(buttons(welcome.replies[0]).map((row) => row.map((b) => b.text))), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["🗂️ My Orders", "🛰️ Setup VPN"], ["🎧 Help"],
  ]);
  assert.equal(JSON.stringify(welcome.replies).includes("Open Metro"), false);
  assert.deepEqual(plain(welcome.replies[1][1].reply_markup.keyboard), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["📊 Usage", "♻️ Renew"], ["⚡ Connect", "🎧 Support"],
  ]);
  assert.equal(welcome.replies[1][1].reply_markup.input_field_placeholder, "Select an option");
  assert.equal(welcome.replies[1][1].reply_markup.is_persistent, true);
  assert.equal(welcome.replies[1][1].reply_markup.resize_keyboard, true);
  assert.equal(welcome.replies[1][1].reply_markup.one_time_keyboard, false);
  assert.equal(JSON.stringify(welcome.replies[1][1]).includes("Metro"), false);
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

test("polling remains active while the native menu is configured and callbacks still run", async () => {
  const bot = await loadBot(null, new Map(), { pollingStaysActive: true });
  assert.equal(bot.launchCalls.length, 1);
  assert.equal(bot.menuButtonCalls.length, 1);
  assert.equal(bot.menuButtonReads.length, 1);
  assert.match((await bot.action("buy_vpn")).replies[0][0], /Choose Your VPN Package/);
  const adminWelcome = bot.ctx(999);
  await bot.events.start(adminWelcome);
  const keyboard = adminWelcome.replies[1][1].reply_markup;
  assert.deepEqual(plain(keyboard.keyboard.slice(0, 3)), [
    ["🛡️ Buy VPN", "🌐 My VPN"], ["📊 Usage", "♻️ Renew"], ["⚡ Connect", "🎧 Support"],
  ]);
  assert.deepEqual(plain(keyboard.keyboard.slice(3)), [
    ["📊 Admin Panel"], ["👥 Users", "🗂️ Orders"], ["🧾 Payments", "💎 Packages"],
  ]);
  assert.equal(keyboard.input_field_placeholder, "Select an option");
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
  assert.match(detailBack.replies[0][0], /Choose Your VPN Package/);
  await bot.action("package_19");
  const confirmation = await bot.action("duration_19_1");
  const confirmationBack = await bot.action(backCode(confirmation.replies[0]));
  assert.match(confirmationBack.replies.at(-1)[0], /Choose Your VPN Package/);
  await bot.action("package_19");
  const secondConfirmation = await bot.action("duration_19_1");
  const payment = await bot.action(buttons(secondConfirmation.replies[0])[0][0].callback_data);
  assert.match(payment.replies[0][0], /Payment/);
  const paymentBack = await bot.action(backCode(payment.replies[0]));
  assert.match(paymentBack.replies[0][0], /အတည်ပြုပါ/);
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
  assert.match(stale.replies[0][0], /no longer active/);
  const forbidden = await bot.action(backCode(fieldBack.replies[0]), 123);
  assert.match(forbidden.replies[0][0], /no longer active/);
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
    assert.match((await bot.action("buy_vpn")).replies[0][0], /Choose Your VPN Package/);
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
  assert.match(customer.replies[0][0], /Choose Your VPN Package/);
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
  assert.match((await press("🛡️ Buy VPN")).replies[0][0], /Choose Your VPN Package/);
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
  assert.equal(bought.order.plan, "Basic - 1 Month");
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
  assert.match(bot.sent.at(-1).args[1], /Send your payment screenshot/);
  const photo = bot.ctx(123);
  photo.message = { photo: [{ file_id: "synthetic-proof", file_size: 1024 }] };
  await bot.events.photo(photo);
  assert.equal(bot.tables.Order[0].paymentProof, "synthetic-proof");
  assert.equal(bot.keyCalls.length, 0);
});

test("start registers a customer and empty VPN states stay customer friendly", async () => {
  const bot = await loadBot();
  const welcome = bot.ctx(456);
  await bot.events.start(welcome);
  assert.equal(bot.tables.Customer.find((row) => row.telegramId === "456")?.firstName, "Test");
  const myVpn = await bot.action("my_vpn", 456);
  assert.match(myVpn.replies[0][0], /VPN package မရှိသေးပါ/);
  assert.doesNotMatch(myVpn.replies[0][0], /လောလောဆယ် မဖော်ပြနိုင်/);
  const usage = bot.ctx(456);
  usage.message = { text: "📊 Usage" };
  await bot.events.text(usage);
  assert.match(usage.replies[0][0], /VPN package မရှိသေးပါ/);
  assert.match((await bot.action("renew_vpn", 456)).replies[0][0], /VPN package မရှိသေးလို့/);
  const connect = bot.ctx(456);
  connect.message = { text: "⚡ Connect" };
  await bot.events.text(connect);
  assert.match(connect.replies[0][0], /VPN package မရှိသေးပါ/);
});

test("Buy VPN uses live Package rows and handles an empty package table", async () => {
  const bot = await loadBot();
  assert.match((await bot.action("buy_vpn")).replies[0][0], /Choose Your VPN Package/);
  bot.tables.Package.splice(0);
  assert.match((await bot.action("buy_vpn")).replies[0][0], /ရွေးနိုင်တဲ့ package မရှိသေးပါ/);
});

test("database failures use safe fallbacks and log codes without secrets", async () => {
  const bot = await loadBot();
  const error = Object.assign(new Error("query failed postgres://user:password@db.invalid/x ss://private-key token=private"),
    { code: "CONTRACT.MARKER_MISMATCH" });
  bot.client.public.Customer.where = () => { throw error; };
  const myVpn = await bot.action("my_vpn");
  assert.match(myVpn.replies[0][0], /လောလောဆယ် မဖော်ပြနိုင်/);
  bot.client.public.Package.where = () => { throw error; };
  const buy = await bot.action("buy_vpn");
  assert.match(buy.replies[0][0], /Package တွေကို မဖော်ပြနိုင်သေးပါ/);
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
  const startText = "🎧 Metro Secure Support\n\nမေးလိုတာကို အောက်မှာ တိုက်ရိုက်ရေးပို့ပါ။\nScreenshot / photo လည်း ပို့နိုင်ပါတယ်။\n\nSupport team က ဒီ chat ထဲမှာပဲ ပြန်လည်ဖြေကြားပေးပါမယ်။";
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
    "✅ မက်ဆေ့ချ်ကို လက်ခံရရှိပါပြီ။\nSupport team က မကြာမီ ပြန်လည်ဖြေကြားပေးပါမယ်။");
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
  assert.match(bot.sent.at(-1).args[1], /Support ဆက်သွယ်မှုကို ပိတ်ပြီးပါပြီ/);
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
  assert.match(blocked.replies[0][0], /too quickly/i);
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
  assert.match(menu.replies[0][0], /Metro VPN မှ ကြိုဆိုပါတယ်/);
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
  assert.deepEqual(plain(buttons(myVpn.replies[0]).map((row) => row.length)), [2, 2, 1]);
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
  await bot.action(await confirmationButton(bot, 19));
  await bot.action("approve_payment_1", 999);
  await bot.action(await confirmationButton(bot, 19, 1, true), 123, 88);
  const originalWhere = bot.client.public.Order.where;
  let failed = false;
  bot.client.public.Order.where = (filter) => {
    const query = originalWhere(filter);
    const originalUpdate = query.update;
    query.update = async (data) => {
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
