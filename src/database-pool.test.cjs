'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabasePool, POOL_LIMITS, MAX_POOL_WAITERS, ACQUIRE_TIMEOUT_MS } = require('./database-pool');

test('all production pools have explicit caps, checkout and SQL deadlines', async () => {
  assert.equal(Object.values(POOL_LIMITS).reduce((sum, n) => sum + n, 0), 7);
  for (const [kind, max] of Object.entries(POOL_LIMITS)) {
    const pool = createDatabasePool(kind, 'postgres://synthetic@127.0.0.1:55448/metro_disposable?sslmode=disable');
    assert.equal(pool.options.max, max);
    assert.equal(pool.options.connectionTimeoutMillis, ACQUIRE_TIMEOUT_MS);
    assert.ok(pool.options.statement_timeout > 0);
    assert.equal(pool.options.application_name, 'metro-' + kind);
    await pool.end();
  }
  assert.throws(() => createDatabasePool('unbounded', ''), /Unknown/);
});
test('queue overflow fails safely for promise and callback callers without connecting', async () => {
  const pool = createDatabasePool('sales', 'postgres://synthetic@127.0.0.1:1/unused');
  Object.defineProperty(pool, 'waitingCount', { value: MAX_POOL_WAITERS });
  await assert.rejects(pool.connect(), error => error.code === 'METRO_DB_BUSY' && !/synthetic|unused|postgres:/.test(error.message));
  await new Promise(resolve => pool.connect(error => { assert.equal(error.code, 'METRO_DB_BUSY'); resolve(); }));
  await assert.rejects(pool.query('SELECT 1'), error => error.code === 'METRO_DB_BUSY');
  assert.equal(pool.totalCount, 0);
  await pool.end();
});

test('real PG18 reduced pools preserve nested work, bounded waits, lost sessions and restart',
  { skip: !process.env.NOTIFICATION_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const raw = process.env.NOTIFICATION_TEST_DATABASE_URL;
    const url = new URL(raw);
    assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '5432');
    assert.equal(url.pathname, '/metro_disposable');
    assert.equal(url.search, '?sslmode=disable'); assert.equal(url.username, 'metro_test');
    const { Client } = require('pg');
    const { createCoordination } = require('./coordination');
    const { createDatabase } = require('./db');
    const observer = new Client({ connectionString: raw }); await observer.connect();
    const lockPool = createDatabasePool('coordination', raw);
    const queryPool = createDatabasePool('application', raw);
    const notifyPool = createDatabasePool('notifications', raw);
    const salesPool = createDatabasePool('sales', raw);
    const nextPool = createDatabasePool('coordination', raw);
    let lost = 0;
    const first = createCoordination({ pool: lockPool, onLost() { lost++; }, log: {} });
    const next = createCoordination({ pool: nextPool, log: {} });
    try {
      assert.equal((await observer.query('SHOW max_connections')).rows[0].max_connections, '20');
      assert.equal(await first.acquire(), true); assert.equal(await next.acquire(), false);
      await t.test('three customer slots can do nested ORM-pool work without starving the owner', async () => {
        let release; const gate = new Promise(resolve => { release = resolve; }); let entered = 0;
        const work = [2100000101, 2100000102, 2100000103].map(id => first.customer(id, async assertOwned => {
          entered++;
          await first.customer(id, async () => { assertOwned(); await queryPool.query('SELECT 1'); });
          await gate; assertOwned();
        }));
        try {
          const deadline = Date.now() + 3000;
          while (entered < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
          assert.equal(entered, 3); assert.equal(lockPool.totalCount, 4);
          await notifyPool.query('SELECT 1'); await salesPool.query('SELECT 1');
          const active = (await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name IN ('metro-application','metro-coordination','metro-notifications','metro-sales') AND datname=current_database()")).rows[0].n;
          assert.equal(active, 7);
          await first.heartbeat(); assert.equal(first.owned, true);
        } finally { release(); await Promise.all(work); }
      });
      await t.test('timed-out queued SQL never executes later, and the pool remains usable', async () => {
        const small = createDatabasePool('sales', raw);
        const held = await small.connect(); let released = false;
        small.options.connectionTimeoutMillis = 50;
        try {
          await assert.rejects(small.query("SELECT set_config('application_name','late-should-not-run',false)"), /timeout/);
          assert.equal(small.waitingCount, 0); held.release(); released = true;
          assert.equal((await small.query('SHOW application_name')).rows[0].application_name, 'metro-sales');
        } finally { if (!released) held.release(); await small.end(); }
      });
      await t.test('same-customer nesting reuses its session; cross-customer nesting fails before checkout', async () => {
        await first.customer(2100000104, async () => {
          const count = lockPool.totalCount;
          await first.customer(2100000104, async () => assert.equal(lockPool.totalCount, count));
          await assert.rejects(first.customer(2100000105, async () => assert.fail()), /Nested locks/);
        });
      });
      await t.test('lost real customer-lock session prevents subsequent protected work', async () => {
        await assert.rejects(first.customer(2100000107, async assertOwned => {
          const session = (await observer.query(`SELECT pid FROM pg_locks WHERE locktype='advisory'
            AND classid=1297302355 AND objid=2100000107 AND objsubid=2 AND granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows;
          assert.equal(session.length, 1); const beforeLoss = lost;
          await observer.query('SELECT pg_terminate_backend($1)', [session[0].pid]);
          const deadline = Date.now() + 2000;
          while (lost === beforeLoss && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
          assert.ok(lost > beforeLoss); assertOwned();
        }), /Customer lock lost/);
        assert.equal(first.owned, true); await first.heartbeat();
      });
      await t.test('one notification connection serializes durable attempts without duplicate delivery claims', async () => {
        const { createNotificationStore } = require('./notification-store');
        const store = createNotificationStore({ pool: notifyPool });
        const customer = (await observer.query('INSERT INTO public.customer ("telegramId") VALUES ($1) RETURNING id',
          ['pool-synthetic-' + require('node:crypto').randomUUID()])).rows[0].id;
        try {
          const subscription = (await observer.query(`INSERT INTO public.subscription ("customerId",plan,status,"expiresAt")
            VALUES ($1,'Synthetic','ACTIVE',now()+interval '1 hour') RETURNING id`, [customer])).rows[0].id;
          const claims = await Promise.all([store.claim(subscription, 'expiryWarning'), store.claim(subscription, 'expiryWarning')]);
          assert.equal(claims.filter(Boolean).length, 1); assert.equal(notifyPool.totalCount, 1);
          await observer.query('DELETE FROM public.subscription WHERE id=$1', [subscription]);
        } finally { await observer.query('DELETE FROM public.customer WHERE id=$1', [customer]); }
      });
      await t.test('lost real owner session fences work and allows a single replacement', async () => {
        const owner = (await observer.query(`SELECT pid FROM pg_locks WHERE locktype='advisory'
          AND classid=1297302355 AND objid=0 AND objsubid=2 AND granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows;
        assert.equal(owner.length, 1);
        await observer.query('SELECT pg_terminate_backend($1)', [owner[0].pid]);
        const deadline = Date.now() + 2000;
        while (first.owned && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(first.owned, false); assert.ok(lost > 0);
        await assert.rejects(first.customer(2100000106, async () => assert.fail()), /ownership unavailable/);
        await first.release();
        assert.equal(await next.acquire(), true); assert.equal(await first.acquire(), false);
        await next.release(); assert.equal(await first.acquire(), true);
      });
      await t.test('actual supplied-pool Prisma startup/close does not leak sessions across restarts', async () => {
        const previous = process.env.DATABASE_URL; process.env.DATABASE_URL = raw;
        try {
          for (let restart = 0; restart < 3; restart++) {
            const database = await createDatabase();
            let customerId;
            try {
              await Promise.all(Array.from({ length: 12 }, () => database.client.public.Customer.where({ id: -1 }).first()));
              const unique = require('node:crypto').randomUUID();
              const customer = await database.client.public.Customer.create({ telegramId: 'pool-runtime-' + unique,
                username: 'pool-runtime-' + unique });
              customerId = customer.id;
              const order = await database.client.public.Order.create({ customerId, orderNumber: 'VPN-pool-' + unique,
                plan: 'Synthetic', price: '1', status: 'PENDING_PAYMENT' });
              const { Temporal } = require('@js-temporal/polyfill');
              const processingAt = Temporal.Now.instant();
              const claims = await Promise.all(Array.from({ length: 12 }, () => database.client.public.Order
                .where({ id: order.id, status: 'PENDING_PAYMENT' }).updateAll({ status: 'PROCESSING', processingAt })));
              assert.equal(claims.flat().length, 1);
              const subscription = await database.client.public.Subscription.create({ customerId, plan: 'Synthetic',
                status: 'ACTIVE', dataUsedBytes: 9007199254740993n, expiresAt: processingAt.add({ hours: 1 }) });
              assert.equal(subscription.dataUsedBytes, 9007199254740993n);
              const { getUsersData } = require('./admin-data');
              const page = await getUsersData(database.client, { q: customer.username, status: 'all', page: '1' });
              assert.equal(page.count, 1); assert.equal(page.customers[0].id, customerId);
              const sessions = (await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='metro-application' AND datname=current_database()")).rows[0].n;
              // queryPool above can keep one idle session in addition to createDatabase's one.
              assert.ok(sessions >= 1 && sessions <= 2);
            } finally {
              if (customerId) {
                await observer.query('DELETE FROM public.subscription WHERE "customerId"=$1', [customerId]);
                await observer.query('DELETE FROM public."order" WHERE "customerId"=$1', [customerId]);
                await observer.query('DELETE FROM public.customer WHERE id=$1', [customerId]);
              }
              await Promise.all([database.close(), database.close()]);
            }
          }
          const sessions = (await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='metro-application' AND datname=current_database()")).rows[0].n;
          assert.ok(sessions <= 1);
        } finally { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; }
      });
    } finally {
      await first.close(); await next.close(); await queryPool.end();
      await notifyPool.end(); await salesPool.end(); await observer.end();
    }
  });
