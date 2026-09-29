const { Temporal } = require("@js-temporal/polyfill");

const USERS_PER_PAGE = 20;
const ORDERS_PER_PAGE = 20;
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
  const totalPages = Math.max(1, Math.ceil(count / USERS_PER_PAGE));
  const page = Math.min(parsePage(params.page), totalPages);
  const customers = await query
    .select("id", "telegramId", "username", "firstName", "createdAt")
    .include("subscription", (subscription) => subscription
      .select("plan", "status", "vpnKeyId", "dataUsedGb", "dataLimitGb", "startedAt", "expiresAt", "revokedAt")
      .include("package", (pkg) => pkg.select("name")))
    .include("orders", (orders) => orders.count())
    .orderBy([(customer) => customer.createdAt.desc(), (customer) => customer.id.desc()])
    .offset((page - 1) * USERS_PER_PAGE)
    .limit(USERS_PER_PAGE)
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
  const totalPages = Math.max(1, Math.ceil(count / ORDERS_PER_PAGE));
  const page = Math.min(parsePage(params.page), totalPages);
  const orders = await query
    .select("id", "orderNumber", "plan", "durationMonths", "price", "paymentMethod",
      "paymentReference", "status", "createdAt", "paidAt", "startedAt", "expiresAt")
    .include("customer", (customer) => customer.select("telegramId", "username", "firstName"))
    .include("package", (pkg) => pkg.select("name"))
    .orderBy([(order) => order.createdAt.desc(), (order) => order.id.desc()])
    .offset((page - 1) * ORDERS_PER_PAGE)
    .limit(ORDERS_PER_PAGE)
    .all();
  return { orders, count, page, totalPages, q, status };
}

async function getOrderDetail(client, id) {
  return client.public.Order
    .where({ id })
    .select("id", "orderNumber", "plan", "durationMonths", "price", "status",
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
  const filter = ["pending", "paid", "rejected", "all"].includes(params.status)
    ? params.status : "pending";
  let query = client.public.Order.where((order) => or(
    order.paymentMethod.isNotNull(), order.paymentProof.isNotNull(),
  ));
  if (filter === "pending") {
    query = query.where({ status: "PENDING_PAYMENT" })
      .where((order) => order.paymentProof.isNotNull());
  } else if (filter === "paid") {
    query = query.where({ status: "PAID" });
  } else if (filter === "rejected") {
    query = query.where({ status: "PAYMENT_REJECTED" });
  }
  const { count } = await query.aggregate((aggregate) => ({ count: aggregate.count() }));
  const totalPages = Math.max(1, Math.ceil(count / ORDERS_PER_PAGE));
  const page = Math.min(parsePage(params.page), totalPages);
  const orders = await query
    .select("id", "orderNumber", "plan", "price", "paymentMethod", "paymentReference",
      "paymentProof", "status", "paidAt")
    .include("customer", (customer) => customer.select("telegramId", "username", "firstName"))
    .include("package", (pkg) => pkg.select("name"))
    .orderBy([(order) => order.createdAt.desc(), (order) => order.id.desc()])
    .offset((page - 1) * ORDERS_PER_PAGE)
    .limit(ORDERS_PER_PAGE)
    .all();
  return { orders, count, page, totalPages, filter };
}

module.exports = {
  getDashboardData, getUsersData, getUserDetail,
  getOrdersData, getOrderDetail, getOrderProof, getPaymentsData,
};
