const { Temporal } = require("@js-temporal/polyfill");

const USERS_PER_PAGE = 20;
const ORDERS_PER_PAGE = 20;
const VPN_KEYS_PER_PAGE = 20;
const PACKAGES_PER_PAGE = 20;
const USAGE_PER_PAGE = 20;
const USAGE_SCAN_BATCH = 250;
const RECENT_ORDERS = 8;
const ORDER_STATUSES = ["PENDING_PAYMENT", "PROCESSING", "PAID", "PAYMENT_REJECTED", "CANCELLED"];

function activeSubscriptions(client, now) {
  return client.public.Subscription
    .where({ status: "ACTIVE" })
    .where((subscription) => subscription.revokedAt.isNull())
    .where((subscription) => subscription.expiresAt.gt(now));
}

function expiredSubscriptions(client, now) {
  return client.public.Subscription
    .where({ status: "ACTIVE" })
    .where((subscription) => subscription.revokedAt.isNull())
    .where((subscription) => subscription.expiresAt.lte(now));
}

async function getDashboardData(client) {
  const now = Temporal.Now.instant();
  const [customers, active, expired, pending, orders, keys, usage, recentOrders] = await Promise.all([
    client.public.Customer.aggregate((aggregate) => ({ count: aggregate.count() })),
    activeSubscriptions(client, now).aggregate((aggregate) => ({ count: aggregate.count() })),
    expiredSubscriptions(client, now).aggregate((aggregate) => ({ count: aggregate.count() })),
    client.public.Order.where({ status: "PENDING_PAYMENT" })
      .where((order) => order.paymentProof.isNotNull())
      .aggregate((aggregate) => ({ count: aggregate.count() })),
    client.public.Order.aggregate((aggregate) => ({ count: aggregate.count() })),
    activeSubscriptions(client, now)
      .where((subscription) => subscription.vpnKeyId.isNotNull())
      .where((subscription) => subscription.vpnKeyId.neq(""))
      .aggregate((aggregate) => ({ count: aggregate.count() })),
    client.public.Subscription.aggregate((aggregate) => ({ total: aggregate.sum("dataUsedGb") })),
    client.public.Order
      .select("orderNumber", "plan", "price", "status", "createdAt")
      .include("customer", (customer) => customer.select("id", "telegramId", "username", "firstName"))
      .include("package", (pkg) => pkg.select("name"))
      .orderBy([(order) => order.createdAt.desc(), (order) => order.id.desc()])
      .limit(RECENT_ORDERS)
      .all(),
  ]);

  return {
    totalCustomers: customers.count,
    activeSubscriptions: active.count,
    expiredSubscriptions: expired.count,
    pendingPayments: pending.count,
    totalOrders: orders.count,
    activeVpnKeys: keys.count,
    totalDataUsedGb: usage.total ?? 0,
    recentOrders,
  };
}

function searchPattern(q) {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

async function customerQuery(client, q, status, now) {
  const { and, or } = await import("@prisma/orm-postgres/orm-client");
  let query = client.public.Customer;

  if (q) {
    const pattern = searchPattern(q);
    query = query.where((customer) => or(
      customer.telegramId.ilike(pattern),
      customer.username.ilike(pattern),
      customer.firstName.ilike(pattern),
    ));
  }

  if (status === "active") {
    query = query.where((customer) => customer.subscription.some((subscription) => and(
      subscription.status.eq("ACTIVE"),
      subscription.revokedAt.isNull(),
      subscription.expiresAt.gt(now),
    )));
  } else if (status === "expired") {
    query = query.where((customer) => customer.subscription.some((subscription) => and(
      subscription.status.eq("ACTIVE"),
      subscription.revokedAt.isNull(),
      subscription.expiresAt.lte(now),
    )));
  } else if (status === "inactive") {
    query = query.where((customer) => or(
      customer.subscription.none(),
      customer.subscription.some((subscription) => or(
        subscription.status.neq("ACTIVE"),
        subscription.revokedAt.isNotNull(),
        subscription.expiresAt.isNull(),
      )),
    ));
  }

  return query;
}

function parsePage(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,5}$/.test(value)) return 1;
  return Number(value);
}

async function getUsersData(client, params = {}) {
  const now = Temporal.Now.instant();
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const status = ["active", "expired", "inactive"].includes(params.status) ? params.status : "all";
  const query = await customerQuery(client, q, status, now);
  const { count } = await query.aggregate((aggregate) => ({ count: aggregate.count() }));
  const pageSize = params.pageSize === 7 ? 7 : USERS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(parsePage(params.page), totalPages);
  const customers = await query
    .select("id", "telegramId", "username", "firstName", "createdAt")
    .include("subscription", (subscription) => subscription
      .select("plan", "status", "vpnKeyId", "dataUsedGb", "dataLimitGb", "startedAt", "expiresAt", "revokedAt")
      .include("package", (pkg) => pkg.select("name")))
    .include("orders", (orders) => orders.count())
    .orderBy([(customer) => customer.createdAt.desc(), (customer) => customer.id.desc()])
    .offset((page - 1) * pageSize)
    .limit(pageSize)
    .all();

  return { customers, count, page, totalPages, q, status, now };
}

async function getUserDetail(client, id) {
  return client.public.Customer
    .where({ id })
    .select("id", "telegramId", "username", "firstName", "createdAt")
    .include("subscription", (subscription) => subscription
      .select("plan", "status", "vpnKeyId", "dataUsedGb", "dataLimitGb", "startedAt", "expiresAt", "revokedAt")
      .include("package", (pkg) => pkg.select("name")))
    .include("orders", (orders) => orders
      .select("orderNumber", "plan", "price", "paymentMethod", "status", "createdAt")
      .include("package", (pkg) => pkg.select("name"))
      .orderBy([(order) => order.createdAt.desc(), (order) => order.id.desc()])
      .limit(10))
    .first();
}

async function getOrdersData(client, params = {}) {
  const { or } = await import("@prisma/orm-postgres/orm-client");
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const status = ORDER_STATUSES.includes(params.status) ? params.status : "all";
  let query = client.public.Order;
  if (q) {
    const pattern = searchPattern(q);
    query = query.where((order) => or(
      order.orderNumber.ilike(pattern),
      order.customer.some((customer) => or(
        customer.telegramId.ilike(pattern),
        customer.username.ilike(pattern),
      )),
    ));
  }
  if (status !== "all") query = query.where({ status });
  const { count } = await query.aggregate((aggregate) => ({ count: aggregate.count() }));
  const pageSize = params.pageSize === 7 ? 7 : ORDERS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(parsePage(params.page), totalPages);
  const orders = await query
    .select("id", "orderNumber", "plan", "totalDurationDays", "price", "paymentMethod",
      "paymentReference", "status", "createdAt", "paidAt", "startedAt", "expiresAt", "vpnKeyId")
    .include("customer", (customer) => customer.select("telegramId", "username", "firstName"))
    .include("package", (pkg) => pkg.select("name"))
    .orderBy([(order) => order.createdAt.desc(), (order) => order.id.desc()])
    .offset((page - 1) * pageSize)
    .limit(pageSize)
    .all();
  return { orders, count, page, totalPages, q, status };
}

async function getOrderDetail(client, id) {
  return client.public.Order
    .where({ id })
    .select("id", "orderNumber", "plan", "totalDurationDays", "price", "status",
      "paymentMethod", "paymentReference", "paymentProof", "createdAt", "paidAt",
      "startedAt", "expiresAt", "vpnKeyId")
    .include("customer", (customer) => customer.select("telegramId", "username", "firstName"))
    .include("package", (pkg) => pkg.select("name"))
    .first();
}

async function getOrderProof(client, id) {
  return client.public.Order.where({ id }).select("paymentProof").first();
}

async function getPaymentsData(client, params = {}) {
  const { or } = await import("@prisma/orm-postgres/orm-client");
  const filter = ["pending", "processing", "paid", "rejected", "all"].includes(params.status)
    ? params.status : "all";
  let query = client.public.Order.where((order) => or(
    order.paymentMethod.isNotNull(), order.paymentProof.isNotNull(),
  ));
  if (filter === "pending") {
    query = query.where({ status: "PENDING_PAYMENT" });
  } else if (filter === "processing") {
    query = query.where({ status: "PROCESSING" });
  } else if (filter === "paid") {
    query = query.where({ status: "PAID" });
  } else if (filter === "rejected") {
    query = query.where({ status: "PAYMENT_REJECTED" });
  }
  const { count } = await query.aggregate((aggregate) => ({ count: aggregate.count() }));
  const pageSize = params.pageSize === 7 ? 7 : ORDERS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(parsePage(params.page), totalPages);
  const orders = await query
    .select("id", "orderNumber", "plan", "price", "paymentMethod", "paymentReference",
      "paymentProof", "status", "paidAt", "createdAt")
    .include("customer", (customer) => customer.select("telegramId", "username", "firstName"))
    .include("package", (pkg) => pkg.select("name"))
    .orderBy([(order) => order.createdAt.desc(), (order) => order.id.desc()])
    .offset((page - 1) * pageSize)
    .limit(pageSize)
    .all();
  return { orders, count, page, totalPages, filter };
}

async function getVpnKeysData(client, params = {}) {
  const { or } = await import("@prisma/orm-postgres/orm-client");
  const now = Temporal.Now.instant();
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const status = ["all", "active", "expired", "revoked", "missing"].includes(params.status)
    ? params.status : "all";
  let query = client.public.Subscription;
  if (q) {
    const pattern = searchPattern(q);
    query = query.where((subscription) => or(
      subscription.vpnKeyId.ilike(pattern),
      subscription.customer.some((customer) => or(
        customer.telegramId.ilike(pattern),
        customer.username.ilike(pattern),
        customer.firstName.ilike(pattern),
      )),
    ));
  }
  if (status === "revoked") {
    query = query.where((subscription) => subscription.revokedAt.isNotNull());
  } else if (status === "missing") {
    query = query.where((subscription) => subscription.revokedAt.isNull())
      .where((subscription) => or(subscription.vpnKeyId.isNull(), subscription.vpnKeyId.eq("")));
  } else if (status === "active" || status === "expired") {
    query = query.where({ status: "ACTIVE" })
      .where((subscription) => subscription.revokedAt.isNull())
      .where((subscription) => subscription.vpnKeyId.isNotNull())
      .where((subscription) => subscription.vpnKeyId.neq(""))
      .where((subscription) => status === "active"
        ? subscription.expiresAt.gt(now) : subscription.expiresAt.lte(now));
  }
  const { count } = await query.aggregate((aggregate) => ({ count: aggregate.count() }));
  const totalPages = Math.max(1, Math.ceil(count / VPN_KEYS_PER_PAGE));
  const page = Math.min(parsePage(params.page), totalPages);
  const subscriptions = await query
    .select("id", "plan", "status", "vpnKeyId", "vpnKeyCreatedAt", "dataUsedGb",
      "dataLimitGb", "startedAt", "expiresAt", "revokedAt")
    .include("customer", (customer) => customer.select("id", "telegramId", "username", "firstName"))
    .include("package", (pkg) => pkg.select("name"))
    .orderBy([(subscription) => subscription.createdAt.desc(), (subscription) => subscription.id.desc()])
    .offset((page - 1) * VPN_KEYS_PER_PAGE)
    .limit(VPN_KEYS_PER_PAGE)
    .all();
  return { subscriptions, count, page, totalPages, q, status, now };
}

async function getPackagesData(client, params = {}) {
  const query = client.public.Package;
  const { count } = await query.aggregate((aggregate) => ({ count: aggregate.count() }));
  const pageSize = params.pageSize === 7 ? 7 : PACKAGES_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(parsePage(params.page), totalPages);
  const packages = await query
    .select("id", "name", "dataLimitGb", "durationDays", "priceMmk", "active",
      "sortOrder", "createdAt", "updatedAt")
    .orderBy([(pkg) => pkg.sortOrder.asc(), (pkg) => pkg.id.asc()])
    .offset((page - 1) * pageSize)
    .limit(pageSize)
    .all();
  return { packages, count, page, totalPages };
}

async function getPackageDetail(client, id) {
  return client.public.Package.where({ id })
    .select("id", "name", "dataLimitGb", "durationDays", "priceMmk", "active", "sortOrder")
    .first();
}

function validatePackageInput(body = {}) {
  const errors = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) errors.push("Name must be 1–100 characters.");
  const gbText = typeof body.dataLimitGb === "string" ? body.dataLimitGb.trim() : "";
  const dataLimitGb = Number(gbText);
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,3})?$/.test(gbText) ||
      !Number.isFinite(dataLimitGb) || dataLimitGb <= 0 || dataLimitGb > 1000000) {
    errors.push("Data limit must be greater than 0 and at most 1,000,000 GB (up to 3 decimals).");
  }
  const durationText = typeof body.durationDays === "string" ? body.durationDays.trim() : "";
  const durationDays = Number(durationText);
  if (!/^[1-9]\d{0,3}$/.test(durationText) || durationDays > 3650) {
    errors.push("Duration must be an integer from 1 to 3,650 days.");
  }
  const priceMmk = typeof body.priceMmk === "string" ? body.priceMmk.trim() : "";
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(priceMmk)) {
    errors.push("Price must be 0–999,999,999 MMK (up to 2 decimals).");
  }
  const sortText = typeof body.sortOrder === "string" ? body.sortOrder.trim() : "";
  const sortOrder = Number(sortText);
  if (!/^-?(?:0|[1-9]\d{0,5})$/.test(sortText) || Math.abs(sortOrder) > 100000) {
    errors.push("Sort order must be an integer from -100,000 to 100,000.");
  }
  if (body.active !== "true" && body.active !== "false") {
    errors.push("Choose Active or Inactive.");
  }
  return {
    errors,
    values: { name, dataLimitGb, durationDays, priceMmk,
      active: body.active === "true", sortOrder },
  };
}

async function updatePackage(client, id, values) {
  return client.public.Package.where({ id }).update({
    name: values.name, dataLimitGb: values.dataLimitGb, durationDays: values.durationDays,
    priceMmk: values.priceMmk, active: values.active, sortOrder: values.sortOrder,
    updatedAt: Temporal.Now.instant(),
  });
}

function nonnegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usageMetrics(subscription) {
  const used = nonnegativeNumber(subscription.dataUsedGb);
  const limit = nonnegativeNumber(subscription.dataLimitGb);
  const percentage = used !== null && limit !== null && limit > 0
    ? used / limit * 100 : null;
  return {
    used, limit,
    percentage,
    remaining: percentage === null ? null : Math.max(0, limit - used),
  };
}

function isCurrentlyActive(subscription, now) {
  if (subscription.status !== "ACTIVE" || subscription.revokedAt || !subscription.expiresAt) return false;
  const expires = Number(subscription.expiresAt.epochMilliseconds ??
    new Date(subscription.expiresAt).getTime());
  return Number.isFinite(expires) && expires > Number(now.epochMilliseconds);
}

function matchesUsageThreshold(subscription, filter) {
  const percentage = usageMetrics(subscription).percentage;
  if (percentage === null) return false;
  if (filter === "above50") return percentage > 50;
  if (filter === "above80") return percentage > 80;
  return percentage >= 100;
}

async function getUsageSummary(client, now) {
  const summary = {
    totalDataUsedGb: 0, totalDataLimitGb: 0, activeSubscriptions: 0,
    above50: 0, above80: 0, atLimit: 0,
  };
  for (let offset = 0; ; offset += USAGE_SCAN_BATCH) {
    const batch = await client.public.Subscription
      .select("id", "status", "dataUsedGb", "dataLimitGb", "expiresAt", "revokedAt")
      .orderBy((subscription) => subscription.id.asc())
      .offset(offset).limit(USAGE_SCAN_BATCH).all();
    for (const subscription of batch) {
      const metrics = usageMetrics(subscription);
      if (metrics.used !== null) summary.totalDataUsedGb += metrics.used;
      if (metrics.limit !== null) summary.totalDataLimitGb += metrics.limit;
      if (isCurrentlyActive(subscription, now)) summary.activeSubscriptions++;
      if (metrics.percentage !== null) {
        if (metrics.percentage > 50) summary.above50++;
        if (metrics.percentage > 80) summary.above80++;
        if (metrics.percentage >= 100) summary.atLimit++;
      }
    }
    if (batch.length < USAGE_SCAN_BATCH) break;
  }
  return summary;
}

function usageRowsQuery(query) {
  return query
    .select("id", "plan", "status", "vpnKeyId", "dataUsedGb", "dataLimitGb",
      "expiresAt", "revokedAt")
    .include("customer", (customer) => customer.select("telegramId", "username", "firstName"))
    .include("package", (pkg) => pkg.select("name"))
    .orderBy([(subscription) => subscription.createdAt.desc(), (subscription) => subscription.id.desc()]);
}

async function getUsageData(client, params = {}) {
  const { or } = await import("@prisma/orm-postgres/orm-client");
  const now = Temporal.Now.instant();
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const filter = ["all", "active", "expired", "above50", "above80", "atLimit"]
    .includes(params.status) ? params.status : "all";
  const summary = await getUsageSummary(client, now);
  let query = client.public.Subscription;
  if (q) {
    const pattern = searchPattern(q);
    query = query.where((subscription) => or(
      subscription.vpnKeyId.ilike(pattern),
      subscription.customer.some((customer) => or(
        customer.telegramId.ilike(pattern),
        customer.username.ilike(pattern),
        customer.firstName.ilike(pattern),
      )),
    ));
  }
  if (filter === "active" || filter === "expired") {
    query = query.where({ status: "ACTIVE" })
      .where((subscription) => subscription.revokedAt.isNull())
      .where((subscription) => filter === "active"
        ? subscription.expiresAt.gt(now) : subscription.expiresAt.lte(now));
  }
  let count, page, subscriptions;
  if (["above50", "above80", "atLimit"].includes(filter)) {
    const requestedPage = parsePage(params.page);
    const requestedIds = [];
    const lastIds = [];
    count = 0;
    const ordered = query.orderBy([(subscription) => subscription.createdAt.desc(),
      (subscription) => subscription.id.desc()]);
    for (let offset = 0; ; offset += USAGE_SCAN_BATCH) {
      const batch = await ordered.select("id", "dataUsedGb", "dataLimitGb")
        .offset(offset).limit(USAGE_SCAN_BATCH).all();
      for (const subscription of batch) {
        if (!matchesUsageThreshold(subscription, filter)) continue;
        if (count >= (requestedPage - 1) * USAGE_PER_PAGE &&
            count < requestedPage * USAGE_PER_PAGE) requestedIds.push(subscription.id);
        lastIds.push(subscription.id);
        if (lastIds.length > USAGE_PER_PAGE) lastIds.shift();
        count++;
      }
      if (batch.length < USAGE_SCAN_BATCH) break;
    }
    const totalPages = Math.max(1, Math.ceil(count / USAGE_PER_PAGE));
    page = Math.min(requestedPage, totalPages);
    const ids = page === requestedPage ? requestedIds
      : lastIds.slice(-(count % USAGE_PER_PAGE || USAGE_PER_PAGE));
    if (ids.length) {
      const rows = await usageRowsQuery(client.public.Subscription
        .where((subscription) => subscription.id.in(ids))).limit(USAGE_PER_PAGE).all();
      const byId = new Map(rows.map((row) => [row.id, row]));
      subscriptions = ids.map((id) => byId.get(id)).filter(Boolean);
    } else subscriptions = [];
    return { subscriptions, summary, count, page, totalPages, q, filter, now };
  }
  ({ count } = await query.aggregate((aggregate) => ({ count: aggregate.count() })));
  const totalPages = Math.max(1, Math.ceil(count / USAGE_PER_PAGE));
  page = Math.min(parsePage(params.page), totalPages);
  subscriptions = await usageRowsQuery(query)
    .offset((page - 1) * USAGE_PER_PAGE).limit(USAGE_PER_PAGE).all();
  return { subscriptions, summary, count, page, totalPages, q, filter, now };
}

function getSettingsData(env, adminConfig, operationalStatus = {}) {
  let publicHostname = null;
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol === "https:" && !url.username && !url.password) publicHostname = url.hostname;
  } catch {
    // Show only configuration presence; never expose malformed URLs.
  }
  const required = ["BOT_TOKEN", "ADMIN_TELEGRAM_ID", "DATABASE_URL", "OUTLINE_API_URL",
    "OUTLINE_API_CERT_SHA256", "PUBLIC_BASE_URL", "CONNECT_TOKEN_SECRET",
    "ADMIN_EMAIL", "ADMIN_PASSWORD_HASH", "ADMIN_SESSION_SECRET"];
  return {
    environment: adminConfig.production ? "Production" : "Development",
    nodeEnvironment: ["production", "development", "test"].includes(env.NODE_ENV)
      ? env.NODE_ENV : "Unspecified",
    renderDeployment: env.RENDER === "true",
    publicHostname,
    telegramConfigured: Boolean(env.BOT_TOKEN),
    telegramAdminConfigured: Boolean(env.ADMIN_TELEGRAM_ID),
    outlineConfigured: Boolean(env.OUTLINE_API_URL),
    fingerprintConfigured: Boolean(env.OUTLINE_API_CERT_SHA256),
    databaseConfigured: Boolean(env.DATABASE_URL),
    databaseConnected: Boolean(operationalStatus.databaseConnected),
    usageWorkerEnabled: Boolean(operationalStatus.usageWorkerEnabled),
    usageSyncRunning: Boolean(operationalStatus.usageSyncRunning),
    usageIntervalMinutes: operationalStatus.usageIntervalMinutes ?? 15,
    processingRecoveryMinutes: operationalStatus.processingRecoveryMinutes ?? 15,
    adminEmail: adminConfig.email,
    sessionTimeoutMinutes: 30,
    adminAuthConfigured: Boolean(adminConfig.email && adminConfig.passwordHash && adminConfig.sessionSecret),
    requiredEnvPresent: required.every((name) => Boolean(env[name])),
  };
}

module.exports = {
  getDashboardData, getUsersData, getUserDetail,
  getOrdersData, getOrderDetail, getOrderProof, getPaymentsData,
  getVpnKeysData, getPackagesData, getPackageDetail, validatePackageInput, updatePackage,
  getUsageData, usageMetrics, getSettingsData,
};
