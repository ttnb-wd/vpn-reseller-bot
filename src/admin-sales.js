const { Temporal } = require("@js-temporal/polyfill");
const { Pool } = require("pg");
const { prepareDatabaseUrl } = require("./db");

const TIMEZONE = "Asia/Yangon";
let pool;

function currentMonth(now = Temporal.Now.instant()) {
  return now.toZonedDateTimeISO(TIMEZONE).toPlainDate().toString().slice(0, 7);
}

function monthBounds(month) {
  if (typeof month !== "string" || !/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) return null;
  const start = Temporal.PlainDate.from(`${month}-01`).toZonedDateTime(TIMEZONE);
  return { start: start.toInstant().toString(), end: start.add({ months: 1 }).toInstant().toString() };
}

function permittedMonth(month, now = Temporal.Now.instant()) {
  const bounds = monthBounds(month);
  if (!bounds) return null;
  const latest = currentMonth(now);
  const earliest = Temporal.PlainDate.from(`${latest}-01`).subtract({ months: 23 }).toString().slice(0, 7);
  return month >= earliest && month <= latest ? bounds : null;
}

function getPool() {
  if (!pool) pool = new Pool({ connectionString: prepareDatabaseUrl(process.env.DATABASE_URL).toString(), max: 2 });
  return pool;
}

async function closeSalesPool() {
  const active = pool;
  pool = undefined;
  if (active) await active.end();
}

// Grouping sets return package rows and the overall total in one bounded PostgreSQL query.
// Order.plan is the purchase-time package/duration label; Order.price is the sale price.
const SALES_SQL = `SELECT "plan" AS package, "durationMonths" AS duration_months,
  COUNT(*)::text AS quantity, COALESCE(SUM("price"), 0)::text AS revenue,
  GROUPING("plan", "durationMonths") AS grand_total
  FROM public."order"
  WHERE "status" = 'PAID' AND "paidAt" >= $1::timestamptz AND "paidAt" < $2::timestamptz
  GROUP BY GROUPING SETS (("plan", "durationMonths"), ())
  ORDER BY grand_total, package, duration_months`;

async function getSalesSummary(month = currentMonth(), query = (sql, values) => getPool().query(sql, values)) {
  const bounds = permittedMonth(month);
  if (!bounds) throw new RangeError("Invalid sales month.");
  const { rows } = await query(SALES_SQL, [bounds.start, bounds.end]);
  const total = rows.find((row) => Number(row.grand_total) === 3);
  return {
    period: { month, timezone: TIMEZONE },
    totalRevenue: String(total?.revenue ?? "0"), currency: "MMK",
    paidOrders: Number(total?.quantity ?? 0),
    packages: rows.filter((row) => Number(row.grand_total) === 0).map((row) => ({
      package: row.package, quantity: Number(row.quantity), revenue: String(row.revenue),
    })),
  };
}

module.exports = { TIMEZONE, SALES_SQL, currentMonth, monthBounds, permittedMonth,
  getSalesSummary, closeSalesPool };
