const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { Temporal } = require("@js-temporal/polyfill");
globalThis.Temporal = Temporal;
const { getUsersData } = require("./admin-data");
const { createSupportService } = require("./support");

const testUrl = process.env.NOTIFICATION_TEST_DATABASE_URL;
test("real PostgreSQL security: ORM injection resistance and customer ownership", { skip: !testUrl }, async t => {
  const url = new URL(testUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.ok(/^\d+$/.test(url.port) && url.port !== "5432");
  assert.equal(url.pathname, "/metro_disposable");
  assert.ok(!["host", "hostaddr", "port"].some(key => url.searchParams.has(key)));
  const pool = new Pool({ connectionString: testUrl });
  const { default: postgresServerless } = await import("@prisma/orm-postgres/serverless");
  const { orm } = await import("@prisma/orm-postgres/orm-client");
  const database = postgresServerless({ contractJson: require("../prisma/contract.json") });
  const runtime = await database.connect({ url: testUrl });
  const db = orm({ runtime, context: database.context });
  const customers = [];
  try {
    await t.test("all four injection payloads remain literal ORM search data", async () => {
      for (const payload of ["' OR '1'='1", '" OR "1"="1', "'; SELECT pg_sleep(1); --", "1 OR 1=1"]) {
        const username = `${payload} ${crypto.randomUUID()}`;
        const customer = await db.public.Customer.create({ telegramId: "security-" + crypto.randomUUID(), username });
        customers.push(customer);
        const result = await getUsersData(db, { q: username, status: "' OR '1'='1", page: "1 OR 1=1" });
        assert.equal(result.count, 1); assert.equal(result.customers[0].id, customer.id);
        assert.equal(result.status, "all"); assert.equal(result.page, 1);
      }
    });
    await t.test("production ownership queries and support service isolate two real customers", async () => {
      const owner = customers[0], outsider = customers[1];
      const order = await db.public.Order.create({ customerId: owner.id, orderNumber: "VPN-security-" + crypto.randomUUID(), plan: "Synthetic", price: "1", status: "PENDING_PAYMENT" });
      await db.public.Subscription.create({ customerId: owner.id, plan: "Synthetic", status: "ACTIVE", expiresAt: Temporal.Now.instant().add({ hours: 1 }) });
      const ticket = await db.public.SupportTicket.create({ customerId: owner.id, status: "OPEN" });
      await db.public.SupportMessage.create({ customerId: owner.id, ticketId: ticket.id, sender: "customer", text: "Owner-only message" });
      // Execute the actual bot ownership functions against the real ORM; do not
      // duplicate their implementation in a mock or replacement query.
      const source = readFileSync(path.join(__dirname, "bot.js"), "utf8");
      const subscriptionQuery = source.slice(source.indexOf("async function findCustomerSubscription("), source.indexOf("function renewBuyKeyboard("));
      const orderQuery = source.slice(source.indexOf("async function miniAppOwnedOrder("), source.indexOf("function proofReviewKeyboard("));
      const access = new Function("db", `${subscriptionQuery}\n${orderQuery}\nreturn { findCustomerSubscription, miniAppOwnedOrder };`)(db);
      assert.equal((await access.miniAppOwnedOrder(owner.telegramId, order.orderNumber)).id, order.id);
      assert.equal(await access.miniAppOwnedOrder(outsider.telegramId, order.orderNumber), null);
      assert.equal((await access.findCustomerSubscription(outsider.telegramId)).subscription, null);
      const service = createSupportService({ db, bot: { telegram: {} }, adminTelegramId: "synthetic", isAdmin: () => false });
      assert.deepEqual(await service.listMessages(outsider.telegramId), { messages: [] });
      assert.equal((await service.listMessages(owner.telegramId)).messages[0].text, "Owner-only message");
    });
  } finally {
    const ids = customers.map(customer => customer.id);
    for (const table of ["supportMessage", "supportTicket", "subscription", "order"]) {
      // These identifiers are a fixed source allowlist, never request data.
      await pool.query(`DELETE FROM public."${table}" WHERE "customerId" = ANY($1)`, [ids]);
    }
    await pool.query('DELETE FROM public."customer" WHERE id = ANY($1)', [ids]);
    await runtime.close(); await pool.end();
  }
});
