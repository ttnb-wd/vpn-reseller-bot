const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { Temporal } = require("@js-temporal/polyfill");
const { createNotificationStore } = require("./notification-store");
const { createSubscriptionNotifications, GB } = require("./subscription-notifications");
const { createDynamicKeys, tunnelConfig } = require("./dynamic-config");
const { createExpiryWorker } = require("./expiry-worker");

// This suite mutates only an explicitly supplied disposable loopback database.
// No DATABASE_URL fallback is permitted; a production URL is rejected.
const testUrl = process.env.NOTIFICATION_TEST_DATABASE_URL;
test("disposable PostgreSQL notification and dynamic-key integration", { skip: !testUrl }, async (t) => {
  const parsed = new URL(testUrl);
  assert.ok(!parsed.searchParams.has("host") && !parsed.searchParams.has("hostaddr") && !parsed.searchParams.has("port"), "Test URL must not override loopback routing");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname), "Test DB must be local");
  assert.ok(/^\d+$/.test(parsed.port) && parsed.port !== "5432", "Use an explicit dedicated disposable test port");
  const pool = new Pool({ connectionString: testUrl, max: 4 });
  const store = createNotificationStore({ pool });
  const store2 = createNotificationStore({ pool });
  let runtime, customerId, subscriptionId;
  try {
    const customer = await pool.query('INSERT INTO public."customer" ("telegramId") VALUES ($1) RETURNING id', ["synthetic-" + crypto.randomUUID()]);
    customerId = customer.rows[0].id;
    const key = `ss://${Buffer.from("chacha20-ietf-poly1305:synthetic-secret").toString("base64url")}@192.0.2.1:1234`;
    const result = await pool.query(`INSERT INTO public."subscription" ("customerId",plan,status,"vpnKeyId","vpnKey","expiresAt","dataLimitGb","dataUsedBytes","migrationNoticeSentAt")
      VALUES ($1,'Synthetic','ACTIVE','synthetic-outline',$2,now() + interval '1 hour 0.000321 seconds',10,0,now()) RETURNING *`, [customerId, key]);
    subscriptionId = result.rows[0].id;
    await t.test("real concurrent transactions claim one attempt and preserve microsecond expiry receipts", async () => {
      const claims = await Promise.all([store.claim(subscriptionId, "expiryWarning"), store2.claim(subscriptionId, "expiryWarning")]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claim = claims.find(Boolean); assert.match(claim.cycle, /\.\d{6}Z$/);
      await store.sent(claim, 42);
      const current = await pool.query('SELECT "expiryWarningSentAt" FROM public."subscription" WHERE id=$1', [subscriptionId]);
      assert.ok(current.rows[0].expiryWarningSentAt);
      assert.equal(await store2.claim(subscriptionId, "expiryWarning"), null);
    });
    await t.test("real rejection does not write sentAt; due retry succeeds across a worker restart", async () => {
      await pool.query('UPDATE public."subscription" SET "expiryWarningSentAt"=NULL,"expiresAt"="expiresAt" + interval \'1 hour\' WHERE id=$1', [subscriptionId]);
      let fail = true, sends = 0;
      const worker = createSubscriptionNotifications({ store, log: { error() {} }, async sendMessage() {
        sends++; if (fail) throw { response: { ok: false, error_code: 403 } }; return { message_id: 43 };
      } });
      await worker.deliver(subscriptionId, "expiryWarning");
      const current = await pool.query('SELECT "expiryWarningSentAt" FROM public."subscription" WHERE id=$1', [subscriptionId]);
      assert.equal(current.rows[0].expiryWarningSentAt, null);
      await pool.query('UPDATE public."subscriptionNotification" SET "nextAttemptAt"=now() - interval \'1 second\' WHERE "subscriptionId"=$1 AND status=\'FAILED\'', [subscriptionId]);
      fail = false; await worker.deliver(subscriptionId, "expiryWarning");
      const restarted = createSubscriptionNotifications({ store: store2, async sendMessage() { sends++; return { message_id: 44 }; } });
      await restarted.deliver(subscriptionId, "expiryWarning"); assert.equal(sends, 2);
    });
    await t.test("raw bigint threshold persists one low-data notice with real SQL", async () => {
      await pool.query('UPDATE public."subscription" SET "expiresAt"=now()+interval \'48 hours\',"dataUsedBytes"=$2,"dataUsedGb"=9 WHERE id=$1', [subscriptionId, (9n * GB).toString()]);
      let sends = 0;
      const worker = createSubscriptionNotifications({ store, async sendMessage() { sends++; return { message_id: 45 }; } });
      await worker.deliver(subscriptionId, "lowDataWarning"); await worker.deliver(subscriptionId, "lowDataWarning");
      assert.equal(sends, 1);
      const current = await pool.query('SELECT "lowDataWarningSentAt" FROM public."subscription" WHERE id=$1', [subscriptionId]);
      assert.ok(current.rows[0].lowDataWarningSentAt);
    });
    const { default: postgresServerless } = await import("@prisma/orm-postgres/serverless");
    const { orm } = await import("@prisma/orm-postgres/orm-client");
    const database = postgresServerless({ contractJson: require("../prisma/contract.json") });
    runtime = await database.connect({ url: testUrl });
    const client = orm({ runtime, context: database.context });
    await t.test("real Prisma token CAS preserves the static key and the URL across concurrency and renewal", async () => {
      const subscription = await client.public.Subscription.where({ id: subscriptionId }).first();
      const keys = createDynamicKeys({ client, baseUrl: "https://synthetic.example", secret: "synthetic-test-".repeat(4) });
      const prepared = await Promise.all([keys.ensure({ ...subscription }), keys.ensure({ ...subscription })]);
      assert.equal(keys.accessUrl(prepared[0]), keys.accessUrl(prepared[1]));
      const current = await client.public.Subscription.where({ id: subscriptionId }).first();
      assert.equal(current.vpnKey, key); assert.equal(current.dataUsedBytes, 9n * GB);
      const before = keys.accessUrl(current);
      await client.public.Subscription.where({ id: subscriptionId }).update({ expiresAt: current.expiresAt.add({ hours: 24 }) });
      const renewed = await client.public.Subscription.where({ id: subscriptionId }).first();
      assert.equal(keys.accessUrl(await keys.ensure(renewed)), before);
      assert.match(tunnelConfig(renewed), /^transport:/);
    });
    await t.test("real expiry enforcement retains the dynamic credential and blocks Outline once per scan", async () => {
      await client.public.Subscription.where({ id: subscriptionId }).update({ expiresAt: Temporal.Now.instant().subtract({ seconds: 1 }) });
      const blocked = [];
      const worker = createExpiryWorker({ client,
        async deleteAccessKey() { throw new Error("Dynamic key must be retained"); },
        async blockAccessKey(id) { blocked.push(id); }, async restoreAccessKey() {},
        isAccessKeyNotFoundError: () => false,
      });
      await worker.run(); assert.deepEqual(blocked, ["synthetic-outline"]);
      const expired = await client.public.Subscription.where({ id: subscriptionId }).first();
      assert.ok(expired.revokedAt); assert.equal(expired.vpnKey, key);
      assert.match(tunnelConfig(expired), /VPN သက်တမ်းကုန်သွားပါပြီ/);
      assert.doesNotMatch(tunnelConfig(expired), /transport:/);
    });
  } finally {
    if (runtime) await runtime.close();
    if (subscriptionId) await pool.query('DELETE FROM public."subscription" WHERE id=$1', [subscriptionId]);
    if (customerId) await pool.query('DELETE FROM public."customer" WHERE id=$1', [customerId]);
    await store.close();
  }
});
