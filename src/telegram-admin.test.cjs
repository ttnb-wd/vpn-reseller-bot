const test = require("node:test");
const assert = require("node:assert/strict");
const { createTelegramAdmin } = require("./telegram-admin");
const { buildCustomerMenu } = require("./customer-menu");
const { validatePackageInput } = require("./admin-data");

function fixture() {
  let action;
  const sent = [];
  const photos = [];
  const calls = { dashboard: 0, users: [], orders: [], payments: [], packages: 0,
    updates: 0, supportClear: 0 };
  const pkg = { id: 8, name: "Basic", priceMmk: "5000", dataLimitGb: 100,
    durationDays: 31, active: true, sortOrder: 1 };
  const historical = { price: "5000", dataLimitGb: 100, expiresAt: "unchanged" };
  const user = { id: 3, telegramId: "222", username: "<buyer>", firstName: "Buyer",
    subscription: { plan: "Basic", status: "ACTIVE", vpnKeyId: "key-3",
      dataUsedGb: 4, dataLimitGb: 100, expiresAt: new Date(Date.now() + 86400000) } };
  const order = { id: 4, orderNumber: "ORD-4", plan: "Basic", price: "5000",
    status: "PAID", createdAt: new Date(), paymentMethod: "KPay", paymentProof: "file-123",
    customer: user, vpnKeyId: "key-3" };
  const api = {
    getDashboardData: async () => ({ totalCustomers: ++calls.dashboard, activeSubscriptions: 2,
      expiredSubscriptions: 3, pendingPayments: 4, totalOrders: 5, activeVpnKeys: 6,
      totalDataUsedGb: 846.5 }),
    getUsersData: async (_db, args) => { calls.users.push(args); return {
      customers: [user], count: 14, page: Number(args.page), totalPages: 2 }; },
    getUserDetail: async () => user,
    getOrdersData: async (_db, args) => { calls.orders.push(args); return {
      orders: [order], count: 14, page: Number(args.page), totalPages: 2 }; },
    getOrderDetail: async () => order,
    getOrderProof: async () => ({ paymentProof: order.paymentProof }),
    getPaymentsData: async (_db, args) => { calls.payments.push(args); return {
      orders: [order], count: 1, page: 1, totalPages: 1 }; },
    getPackagesData: async () => { calls.packages++; return {
      packages: [{ ...pkg }], count: 1, page: 1, totalPages: 1 }; },
    getPackageDetail: async () => ({ ...pkg }),
    validatePackageInput,
    updatePackage: async (_db, id, values) => { assert.equal(id, 8); calls.updates++;
      Object.assign(pkg, values); },
  };
  const bot = { action: (_pattern, handler) => { action = handler; },
    telegram: { sendPhoto: async (...args) => { photos.push(args); } } };
  const db = { public: { Order: { where: () => ({ aggregate: async () => ({ count: 12 }) }) } } };
  const supportService = { clearAdminReply: async () => { calls.supportClear++; } };
  const service = createTelegramAdmin({ bot, db, adminTelegramId: "111", supportService, dataApi: api });
  function ctx(id = 111, message = "") {
    return { from: { id }, chat: { id, type: "private" }, message: { text: message },
      answerCbQuery: async (value) => { sent.push({ answer: value }); },
      reply: async (text, markup) => { sent.push({ text, markup }); } };
  }
  async function tap(code, id = 111, chat) {
    const context = ctx(id); if (chat) context.chat = chat;
    context.match = [null, code]; await action(context); return sent.at(-1);
  }
  return { service, tap, ctx, sent, photos, calls, pkg, historical, order };
}

test("admin buttons are available only for exact Telegram ID; forged callback is rejected", async () => {
  const f = fixture();
  const admin = buildCustomerMenu(true, f.service.customerAdminRows()).reply_markup.inline_keyboard;
  const customer = buildCustomerMenu(false, f.service.customerAdminRows()).reply_markup.inline_keyboard;
  assert.equal(admin.length, 6);
  assert.equal(customer.length, 3);
  assert.equal(admin[3][0].text, "📊 Admin Panel");
  assert.equal(customer.flat().some((button) => button.callback_data?.startsWith("ta_")), false);
  await f.tap("dashboard", 222);
  assert.equal(f.sent.at(-1).answer, "Unauthorized");
  assert.equal(f.calls.dashboard, 0);
  // The same admin account cannot reveal private console data in a group.
  await f.tap("dashboard", 111, { id: -100, type: "supergroup" });
  assert.equal(f.sent.at(-1).answer, "Unauthorized");
  assert.equal(f.calls.dashboard, 0);
  assert.equal(await f.service.handleText(f.ctx(222, "6000")), false);
});

test("admin reply labels use existing data actions only in the admin private chat", async () => {
  const f = fixture();
  const shortcuts = [
    ["📊 Admin Panel", /Metro Secure Admin/],
    ["👥 Users", /Users \(14\)/],
    ["🗂️ Orders", /Orders \(14\)/],
    ["🧾 Payments", /Payments \(1\)/],
    ["💎 Packages", /Packages \(1\)/],
  ];
  for (const [label, response] of shortcuts) {
    assert.equal(await f.service.handleMenuText(f.ctx(222, label)), false);
    assert.equal(await f.service.handleMenuText({ ...f.ctx(111, label),
      chat: { id: -100, type: "supergroup" } }), false);
    assert.equal(await f.service.handleMenuText(f.ctx(111, label)), true);
    assert.match(f.sent.at(-1).text, response);
  }
  assert.equal(await f.service.handleMenuText(f.ctx(111, "ordinary text")), false);
  assert.equal(f.calls.dashboard, 1);
  assert.equal(f.calls.users.length, 1);
  assert.equal(f.calls.orders.length, 1);
  assert.equal(f.calls.payments.length, 1);
  assert.equal(f.calls.packages, 1);
});

test("dashboard refresh and lists read current data with seven-row pagination", async () => {
  const f = fixture();
  assert.match((await f.tap("dashboard")).text, /Users: 1/);
  assert.match((await f.tap("dashboard")).text, /Users: 2/);
  assert.equal(f.calls.dashboard, 2);
  assert.match((await f.tap("users_2")).text, /<buyer>/);
  assert.deepEqual(f.calls.users[0], { page: 2, pageSize: 7 });
  assert.match((await f.tap("orders_2")).text, /ORD-4/);
  assert.deepEqual(f.calls.orders[0], { page: 2, pageSize: 7 });
  const detail = await f.tap("user_3_2");
  assert.match(detail.text, /Order Count: 12/);
  assert.doesNotMatch(detail.text, /ss:\/\//);
});

test("payments show proof availability and only admin can send stored photo to admin chat", async () => {
  const f = fixture();
  const list = await f.tap("payments_1");
  assert.match(list.text, /Proof: Yes/);
  assert.equal(list.markup.reply_markup.inline_keyboard.some((row) => row.some((b) => b.text === "🖼️ View Slip")), true);
  await f.tap("slip_4", 222);
  assert.equal(f.photos.length, 0);
  await f.tap("slip_4");
  assert.equal(f.photos.length, 1);
  assert.equal(f.photos[0][0], "111");
  assert.equal(f.photos[0][1], "file-123");
  assert.doesNotMatch(JSON.stringify(f.sent), /file-123|ss:\/\//);
});

test("package edit validates, confirms, saves through shared helper and reads fresh row", async () => {
  const f = fixture();
  assert.match((await f.tap("packages_1")).text, /5,000/);
  await f.tap("field_8_1_priceMmk");
  assert.equal(f.calls.supportClear, 1);
  const invalid = f.ctx(111, "wrong");
  assert.equal(await f.service.handleText(invalid), true);
  assert.match(f.sent.at(-1).text, /Invalid Price/);
  await f.service.handleText(f.ctx(111, "6000"));
  assert.match(f.sent.at(-1).text, /5,000|5000/);
  await f.tap("save_8_1");
  assert.equal(f.calls.updates, 1);
  assert.equal(f.pkg.priceMmk, "6000");
  assert.equal(f.historical.price, "5000");
  assert.match((await f.tap("packages_1")).text, /6,000/);
  assert.equal((await f.tap("package_8_1")).text.includes("6,000"), true);
  assert.equal((await f.tap("package_8_1")).text.includes("Inactive"), false);
  await f.tap("toggle_8_1");
  assert.equal(f.pkg.active, false);
  assert.match((await f.tap("packages_1")).text, /Inactive/);
});

test("cancel and support handoff prevent package input from changing data", async () => {
  const f = fixture();
  await f.tap("field_8_1_name");
  await f.service.handleText(f.ctx(111, "New Name"));
  await f.tap("cancel_8_1");
  await f.tap("save_8_1");
  assert.equal(f.calls.updates, 0);
  await f.tap("field_8_1_name");
  f.service.clearInput(); // Support reply selection takes ownership of the next text.
  assert.equal(await f.service.handleText(f.ctx(111, "Support reply")), false);
  assert.equal(f.calls.updates, 0);
});
