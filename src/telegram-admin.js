const { Markup } = require("telegraf");
const data = require("./admin-data");
const { logHandlerFailure } = require("./safe-diagnostics");

const FIELDS = { name: "Name", priceMmk: "Price", dataLimitGb: "Data Limit GB",
  durationDays: "Duration Days", sortOrder: "Sort Order" };
const button = (label, action) => Markup.button.callback(label, `ta_${action}`);
const keyboard = (rows) => Markup.inlineKeyboard(rows);
const clean = (value) => String(value ?? "-").replace(/ss:\/\/\S+/gi, "[VPN key hidden]")
  .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
const number = (value) => Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
const fieldValue = (field, value) => field === "name" ? clean(value) : number(value);
function date(value) {
  if (!value) return "-";
  const time = value.epochMilliseconds === undefined ? new Date(value).getTime() : Number(value.epochMilliseconds);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-";
}
function status(sub) {
  if (!sub) return "No subscription";
  if (sub.revokedAt || sub.status !== "ACTIVE") return "Inactive";
  if (!sub.expiresAt) return "Inactive";
  const expiry = sub.expiresAt?.epochMilliseconds === undefined
    ? new Date(sub.expiresAt).getTime() : Number(sub.expiresAt.epochMilliseconds);
  return Number.isFinite(expiry) && expiry <= Date.now() ? "Expired" : "Active";
}
const nav = (back) => [[button("⬅️ Back", back), button("🏠 Admin Menu", "menu")]];
function pager(page, pages, section) {
  const row = [];
  if (page > 1) row.push(button("◀ Previous", `${section}_${page - 1}`));
  if (page < pages) row.push(button("Next ▶", `${section}_${page + 1}`));
  return row.length ? [row] : [];
}
function packageText(pkg) {
  return `💎 ${clean(pkg.name)}\n${number(pkg.dataLimitGb)} GB • ${number(pkg.durationDays)} Days • ${number(pkg.priceMmk)}\n${pkg.active ? "Active" : "Inactive"}\nSort Order: ${number(pkg.sortOrder)}`;
}
function createTelegramAdmin({ bot, db, adminTelegramId, supportService, dataApi = data }) {
  const input = new Map();
  const adminId = String(adminTelegramId);
  const isAdmin = (ctx) => Boolean(ctx.from?.id) && String(ctx.from.id) === adminId &&
    ctx.chat?.type === "private" && String(ctx.chat.id) === adminId;
  const adminMenu = () => keyboard([
    [button("📊 Admin Panel", "dashboard")],
    [button("👥 Users", "users_1"), button("🗂️ Orders", "orders_1")],
    [button("🧾 Payments", "payments_1"), button("💎 Packages", "packages_1")],
  ]);
  const customerAdminRows = () => [
    [button("📊 Admin Panel", "dashboard")],
    [button("👥 Users", "users_1"), button("🗂️ Orders", "orders_1")],
    [button("🧾 Payments", "payments_1"), button("💎 Packages", "packages_1")],
  ];
  async function show(ctx, text, rows) { await ctx.reply(text, keyboard(rows)); }
  async function menu(ctx) { await show(ctx, "📊 Metro Secure Admin", adminMenu().reply_markup.inline_keyboard); }
  async function dashboard(ctx) {
    const d = await dataApi.getDashboardData(db);
    await show(ctx, `📊 Metro Secure Admin\n\n👥 Users: ${number(d.totalCustomers)}\n🌐 Active VPN: ${number(d.activeSubscriptions)}\n⏳ Expired: ${number(d.expiredSubscriptions)}\n🧾 Pending Payments: ${number(d.pendingPayments)}\n🗂️ Total Orders: ${number(d.totalOrders)}\n🔑 Active Keys: ${number(d.activeVpnKeys)}\n📡 Data Used: ${number(d.totalDataUsedGb)} GB`,
      [[button("🔄 Refresh", "dashboard")], ...nav("menu")]);
  }
  async function users(ctx, page) {
    const d = await dataApi.getUsersData(db, { page, pageSize: 7 });
    const lines = d.customers.map((c) => {
      const sub = c.subscription;
      return `${clean(c.username || c.firstName)} • ${clean(c.telegramId)}\n${clean(sub?.plan || "-")} • ${status(sub)} • ${number(sub?.dataUsedGb)}/${number(sub?.dataLimitGb)} GB • ${date(sub?.expiresAt)}`;
    });
    await show(ctx, `👥 Users (${d.count}) • ${d.page}/${d.totalPages}\n\n${lines.join("\n\n") || "No customers."}`,
      [...d.customers.map((c) => [button(clean(c.username || c.firstName), `user_${c.id}_${d.page}`)]),
        ...pager(d.page, d.totalPages, "users"), ...nav("menu")]);
  }
  async function user(ctx, id, page) {
    const c = await dataApi.getUserDetail(db, id);
    if (!c) return show(ctx, "Customer not found.", nav(`users_${page}`));
    const sub = c.subscription;
    const count = await db.public.Order.where({ customerId: id })
      .aggregate((aggregate) => ({ count: aggregate.count() }));
    await show(ctx, `👤 Customer ID: ${c.id}\nTelegram ID: ${clean(c.telegramId)}\nUsername: ${clean(c.username)}\nFirst Name: ${clean(c.firstName)}\nPlan: ${clean(sub?.plan)}\nSubscription: ${status(sub)}\nVPN Key ID: ${clean(sub?.vpnKeyId)}\nData Used / Limit: ${number(sub?.dataUsedGb)} / ${number(sub?.dataLimitGb)} GB\nStarted At: ${date(sub?.startedAt)}\nExpires At: ${date(sub?.expiresAt)}\nOrder Count: ${count.count}`,
      nav(`users_${page}`));
  }
  async function orders(ctx, page) {
    const d = await dataApi.getOrdersData(db, { page, pageSize: 7 });
    await show(ctx, `🗂️ Orders (${d.count}) • ${d.page}/${d.totalPages}\n\n${d.orders.map((o) => `${clean(o.orderNumber)} • ${clean(o.customer?.username || o.customer?.firstName)}\n${clean(o.plan)} • ${number(o.price)} • ${clean(o.status)} • ${date(o.createdAt)}`).join("\n\n") || "No orders."}`,
      [...d.orders.map((o) => [button(clean(o.orderNumber), `order_${o.id}_${d.page}`)]),
        ...pager(d.page, d.totalPages, "orders"), ...nav("menu")]);
  }
  async function order(ctx, id, page) {
    const o = await dataApi.getOrderDetail(db, id);
    if (!o) return show(ctx, "Order not found.", nav(`orders_${page}`));
    await show(ctx, `🗂️ Order: ${clean(o.orderNumber)}\nCustomer: ${clean(o.customer?.username || o.customer?.firstName)}\nTelegram ID: ${clean(o.customer?.telegramId)}\nPackage: ${clean(o.plan)}\nPrice: ${number(o.price)}\nDuration: ${number(o.durationMonths)} months\nPayment Method: ${clean(o.paymentMethod)}\nPayment Reference: ${clean(o.paymentReference)}\nStatus: ${clean(o.status)}\nCreated: ${date(o.createdAt)}\nPaid At: ${date(o.paidAt)}\nStarted At: ${date(o.startedAt)}\nExpires At: ${date(o.expiresAt)}\nVPN Key ID: ${clean(o.vpnKeyId)}`,
      [...(o.paymentProof ? [[button("🖼️ View Slip", `slip_${id}`)]] : []), ...nav(`orders_${page}`)]);
  }
  async function payments(ctx, page) {
    const d = await dataApi.getPaymentsData(db, { page, pageSize: 7, status: "all" });
    await show(ctx, `🧾 Payments (${d.count}) • ${d.page}/${d.totalPages}\n\n${d.orders.map((o) => `${clean(o.orderNumber)} • ${clean(o.customer?.username || o.customer?.firstName)}\n${number(o.price)} • ${clean(o.paymentMethod)} • ${clean(o.status)}\nPaid: ${date(o.paidAt)} • Proof: ${o.paymentProof ? "Yes" : "No"}`).join("\n\n") || "No payments."}`,
      [...d.orders.flatMap((o) => [
        [button(`View Order ${clean(o.orderNumber)}`, `order_${o.id}_1`),
          ...(o.paymentProof ? [button("🖼️ View Slip", `slip_${o.id}`)] : [])],
      ]), ...pager(d.page, d.totalPages, "payments"), ...nav("menu")]);
  }
  async function slip(ctx, id) {
    const o = await dataApi.getOrderProof(db, id);
    if (!o?.paymentProof) return ctx.reply("Payment proof is unavailable.");
    await bot.telegram.sendPhoto(adminId, o.paymentProof, { caption: `🧾 Payment slip • Order ${id}` });
  }
  async function packages(ctx, page) {
    const d = await dataApi.getPackagesData(db, { page, pageSize: 7 });
    await show(ctx, `💎 Packages (${d.count}) • ${d.page}/${d.totalPages}\n\n${d.packages.map(packageText).join("\n\n") || "No packages."}`,
      [...d.packages.map((p) => [button(`✏️ Edit ${clean(p.name)}`, `package_${p.id}_${d.page}`)]),
        ...pager(d.page, d.totalPages, "packages"), ...nav("menu")]);
  }
  async function packageDetail(ctx, id, page) {
    const pkg = await dataApi.getPackageDetail(db, id);
    if (!pkg) return show(ctx, "Package not found.", nav(`packages_${page}`));
    await show(ctx, packageText(pkg),
      [[button("✏️ Edit", `edit_${id}_${page}`)], ...nav(`packages_${page}`)]);
  }
  async function edit(ctx, id, page) {
    const pkg = await dataApi.getPackageDetail(db, id);
    if (!pkg) return show(ctx, "Package not found.", nav(`packages_${page}`));
    await show(ctx, `✏️ Edit ${clean(pkg.name)}\n\n${packageText(pkg)}`,
      [...Object.entries(FIELDS).map(([field, label]) => [button(label, `field_${id}_${page}_${field}`)]),
        [button(pkg.active ? "Set Inactive" : "Set Active", `toggle_${id}_${page}`)],
        [button("❌ Cancel", `cancel_${id}_${page}`)], ...nav(`package_${id}_${page}`)]);
  }
  async function begin(ctx, id, page, field) {
    const pkg = await dataApi.getPackageDetail(db, id);
    if (!pkg) return show(ctx, "Package not found.", nav(`packages_${page}`));
    await supportService.clearAdminReply();
    input.set(adminId, { kind: "ADMIN_PACKAGE_EDIT", id, page, field, step: "awaiting",
      expires: Date.now() + 10 * 60 * 1000 });
    await show(ctx, `လက်ရှိ ${FIELDS[field]}: ${fieldValue(field, pkg[field])}\n\n${FIELDS[field]} အသစ်ကို ရိုက်ပို့ပါ။`,
      [[button("❌ Cancel", `cancel_${id}_${page}`)], ...nav(`edit_${id}_${page}`)]);
  }
  async function handleText(ctx) {
    if (!isAdmin(ctx)) return false;
    const state = input.get(adminId);
    if (!state) return false;
    if (state.expires < Date.now()) { input.delete(adminId); return false; }
    if (state.step !== "awaiting") return false;
    const pkg = await dataApi.getPackageDetail(db, state.id);
    if (!pkg) { input.delete(adminId); await ctx.reply("Package not found."); return true; }
    const raw = String(ctx.message.text || "").trim();
    const body = Object.fromEntries(Object.keys(FIELDS).map((key) => [key, String(pkg[key])]));
    body.active = String(pkg.active);
    body[state.field] = raw;
    const checked = dataApi.validatePackageInput(body);
    if (checked.errors.length) {
      await ctx.reply(`Invalid ${FIELDS[state.field]}: ${checked.errors.join(" ")}`,
        keyboard([[button("⬅️ Back", `edit_${state.id}_${state.page}`),
          button("❌ Cancel", `cancel_${state.id}_${state.page}`)]]));
      return true;
    }
    input.set(adminId, { ...state, step: "confirm", value: raw });
    await show(ctx, `${FIELDS[state.field]}:\n${fieldValue(state.field, pkg[state.field])} → ${fieldValue(state.field, raw)}`,
      [[button("✅ Save", `save_${state.id}_${state.page}`),
        button("❌ Cancel", `cancel_${state.id}_${state.page}`)],
      [button("⬅️ Back", `edit_${state.id}_${state.page}`)]]);
    return true;
  }
  const menuShortcuts = new Map([
    ["📊 Admin Panel", dashboard],
    ["👥 Users", (ctx) => users(ctx, 1)],
    ["🗂️ Orders", (ctx) => orders(ctx, 1)],
    ["🧾 Payments", (ctx) => payments(ctx, 1)],
    ["💎 Packages", (ctx) => packages(ctx, 1)],
  ]);
  async function handleMenuText(ctx) {
    const shortcut = menuShortcuts.get(ctx.message?.text);
    if (!shortcut || !isAdmin(ctx)) return false;
    input.delete(adminId);
    await shortcut(ctx);
    return true;
  }
  async function save(ctx, id, page) {
    const state = input.get(adminId);
    if (!state || state.kind !== "ADMIN_PACKAGE_EDIT" || state.id !== id ||
      state.page !== page || state.step !== "confirm" || state.expires < Date.now()) {
      return ctx.reply("Edit expired. Open the package again.");
    }
    const pkg = await dataApi.getPackageDetail(db, id);
    if (!pkg) { input.delete(adminId); return ctx.reply("Package not found."); }
    const body = Object.fromEntries(Object.keys(FIELDS).map((key) => [key, String(pkg[key])]));
    body.active = String(pkg.active);
    body[state.field] = state.value;
    const checked = dataApi.validatePackageInput(body);
    if (checked.errors.length) return ctx.reply(checked.errors.join(" "));
    await dataApi.updatePackage(db, id, checked.values);
    input.delete(adminId);
    const saved = await dataApi.getPackageDetail(db, id);
    await show(ctx, `✅ Saved\n\n${packageText(saved)}`, nav(`package_${id}_${page}`));
  }
  async function toggle(ctx, id, page) {
    const pkg = await dataApi.getPackageDetail(db, id);
    if (!pkg) return ctx.reply("Package not found.");
    const body = Object.fromEntries(Object.keys(FIELDS).map((key) => [key, String(pkg[key])]));
    body.active = String(!pkg.active);
    const checked = dataApi.validatePackageInput(body);
    if (checked.errors.length) return ctx.reply(checked.errors.join(" "));
    await dataApi.updatePackage(db, id, checked.values);
    await packageDetail(ctx, id, page);
  }
  async function action(ctx) {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized");
    await ctx.answerCbQuery();
    const a = ctx.match[1];
    try {
      if (/^(?:menu|dashboard|users_|orders_|payments_|packages_|user_|order_|slip_|package_|edit_|toggle_)/.test(a))
        input.delete(adminId);
      if (a === "menu") return menu(ctx);
      if (a === "dashboard") return dashboard(ctx);
      let m;
      if ((m = /^(users|orders|payments|packages)_(\d+)$/.exec(a)))
        return ({ users, orders, payments, packages })[m[1]](ctx, Number(m[2]));
      if ((m = /^user_(\d+)_(\d+)$/.exec(a))) return user(ctx, Number(m[1]), Number(m[2]));
      if ((m = /^order_(\d+)_(\d+)$/.exec(a))) return order(ctx, Number(m[1]), Number(m[2]));
      if ((m = /^slip_(\d+)$/.exec(a))) return slip(ctx, Number(m[1]));
      if ((m = /^(package|edit|toggle|save|cancel)_(\d+)_(\d+)$/.exec(a))) {
        const [, verb, rawId, rawPage] = m; const id = Number(rawId), page = Number(rawPage);
        if (verb === "cancel") { input.delete(adminId); return packageDetail(ctx, id, page); }
        return ({ package: packageDetail, edit, toggle, save })[verb](ctx, id, page);
      }
      if ((m = /^field_(\d+)_(\d+)_(name|priceMmk|dataLimitGb|durationDays|sortOrder)$/.exec(a)))
        return begin(ctx, Number(m[1]), Number(m[2]), m[3]);
    } catch (error) {
      logHandlerFailure("admin.action", error);
      await ctx.reply("Admin data is temporarily unavailable. Please try again.");
    }
  }
  bot.action(/^ta_(.+)$/, action);
  return { customerAdminRows, handleText, handleMenuText, clearInput: () => input.delete(adminId),
    isEditing: () => input.has(adminId) };
}

module.exports = { createTelegramAdmin };
