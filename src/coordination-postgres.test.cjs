const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createCoordination } = require('./coordination');
const { detectDuplicates } = require('../scripts/check-outline-ownership.cjs');
const testUrl = process.env.NOTIFICATION_TEST_DATABASE_URL;
test('disposable PostgreSQL customer locks and singleton session leases', { skip: !testUrl }, async t => {
  const url = new URL(testUrl);
  assert.ok(!url.searchParams.has("host") && !url.searchParams.has("hostaddr") && !url.searchParams.has("port"), "Test URL must not override loopback routing");
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.ok(/^\d+$/.test(url.port) && url.port !== '5432');
  const pool1 = new Pool({ connectionString: testUrl, max: 4 });
  const pool2 = new Pool({ connectionString: testUrl, max: 4 });
  let lost = 0;
  const first = createCoordination({ pool: pool1, leaseMs: 1000, heartbeatMs: 100,
    onLost() { lost++; } });
  const second = createCoordination({ pool: pool2, leaseMs: 1000, heartbeatMs: 100 });
  try {
    await t.test('one owner excludes a second process and heartbeat survives the expiry window', async () => {
      assert.equal(await first.acquire(), true);
      assert.equal(await second.acquire(), false);
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(first.owned, true);
      await first.heartbeat();
      assert.equal(await second.acquire(), false);
    });
    await t.test('standby retries real PostgreSQL ownership and activates once after incumbent drains and releases', async () => {
      const { createSingletonStartup } = require('./singleton-startup');
      let pollingStarts = 0, workerStarts = 0, activeWork = 1, maxActiveWork = 1, activate;
      const activated = new Promise(resolve => { activate = resolve; });
      let deadline;
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Disposable takeover timed out.')), 7000);
      });
      const startup = createSingletonStartup({ coordination: second, log: { log() {} },
        onError(error) { activate(Promise.reject(error)); },
        async activate() {
          assert.equal(second.owned, true); assert.equal(first.owned, false);
          maxActiveWork = Math.max(maxActiveWork, ++activeWork);
          pollingStarts++; workerStarts++;
          const locks = await pool1.query('SELECT count(*)::int AS count FROM pg_locks WHERE locktype=\'advisory\' AND classid=1297302355 AND objid=0 AND granted');
          assert.equal(locks.rows[0].count, 1);
          startup.ready(); activate();
        },
      });
      try {
        await startup.start();
        assert.equal(startup.state, 'STANDBY');
        assert.equal(pollingStarts, 0); assert.equal(workerStarts, 0);
        // Incumbent finishes its owned work before releasing its DB session.
        activeWork--; await first.release();
        await Promise.race([activated, timeout]);
        assert.equal(startup.state, 'READY'); assert.equal(maxActiveWork, 1);
        await startup.start();
        assert.equal(pollingStarts, 1); assert.equal(workerStarts, 1);
      } finally {
        clearTimeout(deadline); startup.cancel(); await startup.drain();
        activeWork = 0; await second.release();
        assert.equal(await first.acquire(), true);
      }
    });
    await t.test('a session without heartbeat expires, signals loss and allows takeover', async () => {
      await first.release();
      const idle = createCoordination({ pool: pool1, leaseMs: 1000, heartbeatMs: 100,
        schedule() { return 1; }, cancel() {}, onLost() { lost++; } });
      assert.equal(await idle.acquire(), true);
      await new Promise(resolve => setTimeout(resolve, 1400));
      assert.equal(idle.owned, false);
      assert.ok(lost > 0);
      assert.equal(await second.acquire(), true);
      await idle.release();
      await second.release();
      assert.equal(await first.acquire(), true);
    });
    await t.test('independent DB sessions serialize customer work and release after exceptions', async () => {
      let release, entered = 0;
      const gate = new Promise(resolve => { release = resolve; });
      const a = first.customer(2147483600, async () => { entered++; await gate; throw new Error('synthetic'); });
      const rejected = assert.rejects(a, /synthetic/);
      const lockClient = createCoordination({ pool: pool2 });
      const b = lockClient.customer(2147483600, async () => { entered++; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(entered, 1);
      release(); await rejected; await b; assert.equal(entered, 2);
    });
    await t.test('duplicate detector only reads and detects real shared Outline IDs', async () => {
      const customers = await pool1.query(`INSERT INTO public.customer ("telegramId") VALUES
        ('synthetic-owner-a'),('synthetic-owner-b') RETURNING id`);
      try {
        for (const row of customers.rows) await pool1.query(`INSERT INTO public.subscription
          ("customerId",plan,status,"vpnKeyId") VALUES ($1,'Synthetic','ACTIVE','synthetic-duplicate')`, [row.id]);
        const result = await detectDuplicates(pool1);
        assert.equal(result.groups, 1); assert.equal(result.subscriptions, 2);
      } finally {
        await pool1.query('DELETE FROM public.subscription WHERE "customerId" = ANY($1)', [customers.rows.map(row => row.id)]);
        await pool1.query('DELETE FROM public.customer WHERE id = ANY($1)', [customers.rows.map(row => row.id)]);
      }
    });
    await t.test('real Prisma approval claims fence reject, cancel, proofs and stale completion', async () => {
      const { default: postgresServerless } = await import('@prisma/orm-postgres/serverless');
      const { orm } = await import('@prisma/orm-postgres/orm-client');
      const { Temporal } = require('@js-temporal/polyfill');
      const database = postgresServerless({ contractJson: require('../prisma/contract.json') });
      const runtime = await database.connect({ url: testUrl });
      const client = orm({ runtime, context: database.context });
      const owner = await client.public.Customer.create({ telegramId: 'synthetic-claim-owner' });
      let order;
      try {
        order = await client.public.Order.create({ orderNumber: 'VPN-synthetic-atomic-claim',
          customerId: owner.id, plan: 'Synthetic', price: '1', status: 'PENDING_PAYMENT' });
        const processingAt = Temporal.Now.instant();
        const claim = () => client.public.Order.where({ id: order.id, status: 'PENDING_PAYMENT' })
          .updateAll({ status: 'PROCESSING', processingAt });
        const claims = await Promise.all([claim(), claim()]);
        assert.equal(claims.flat().length, 1);
        for (const status of ['PAYMENT_REJECTED', 'CANCELLED']) {
          assert.equal((await client.public.Order.where({ id: order.id, status: 'PENDING_PAYMENT' })
            .updateAll({ status })).length, 0);
        }
        assert.equal((await client.public.Order.where({ id: order.id, customerId: owner.id,
          status: 'PENDING_PAYMENT', paymentProof: null, paymentReference: null })
          .updateAll({ paymentProof: 'synthetic' })).length, 0);
        const newer = processingAt.add({ seconds: 1 });
        await client.public.Order.where({ id: order.id }).update({ processingAt: newer });
        assert.equal((await client.public.Order.where({ id: order.id, status: 'PROCESSING', processingAt })
          .updateAll({ status: 'PAID' })).length, 0);
        assert.equal((await client.public.Order.where({ id: order.id, status: 'PROCESSING', processingAt: newer })
          .updateAll({ status: 'PAID' })).length, 1);
      } finally {
        if (order) await pool1.query('DELETE FROM public."order" WHERE id=$1', [order.id]);
        await pool1.query('DELETE FROM public.customer WHERE id=$1', [owner.id]);
        await runtime.close();
      }
    });
  } finally { await first.close(); await second.close(); }
});
