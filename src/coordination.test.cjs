const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCoordination } = require('./coordination');
function fixture() {
  let singleton;
  const tails = new Map(), connections = [];
  const pool = new EventEmitter();
  pool.end = async () => {};
  pool.connect = async () => {
    const connection = new EventEmitter();
    connections.push(connection);
    let unlock;
    connection.query = async (sql, values) => {
      if (sql.includes('pg_try_advisory_lock')) {
        if (singleton) return { rows: [{ owned: false }] };
        singleton = connection;
        return { rows: [{ owned: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) { unlock?.(); return {}; }
      if (sql.includes('pg_advisory_lock')) {
        const id = values[0], previous = tails.get(id) || Promise.resolve();
        tails.set(id, new Promise(resolve => { unlock = resolve; }));
        await previous;
      }
      return { rows: [] };
    };
    connection.release = () => { if (singleton === connection) singleton = undefined; unlock?.(); };
    return connection;
  };
  return { pool, connections };
}
test('singleton acquisition, second process exclusion, heartbeat, release and expired-session takeover', async () => {
  const { pool, connections } = fixture();
  let scheduled, cancelled = 0, lost = 0;
  const options = { pool, schedule(fn) { scheduled = fn; return 1; }, cancel() { cancelled++; } };
  const first = createCoordination({ ...options, onLost() { lost++; } });
  const second = createCoordination(options);
  assert.notEqual(first.owner, second.owner);
  assert.equal(await first.acquire(), true);
  assert.equal(await second.acquire(), false);
  await scheduled(); await first.heartbeat(); assert.equal(first.owned, true);
  // PostgreSQL closes idle sessions at their configured deadline.
  connections[0].release(true); connections[0].emit('end');
  assert.equal(first.owned, false); assert.equal(lost, 1);
  assert.equal(await second.acquire(), true);
  await second.release(); assert.equal(second.owned, false);
  assert.equal(await first.acquire(), true);
  await first.close(); await second.close(); assert.ok(cancelled);
});
test('independent coordinators serialize the same customer and release on failure', async () => {
  const { pool } = fixture();
  const first = createCoordination({ pool }), second = createCoordination({ pool });
  let release, entered = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const a = first.customer(42, async () => { entered++; await gate; throw new Error('synthetic'); });
  const failed = assert.rejects(a, /synthetic/);
  const b = second.customer(42, async () => { entered++; });
  await new Promise(setImmediate); assert.equal(entered, 1);
  release(); await failed; await b; assert.equal(entered, 2);
});
test('lost customer connection fences further writes and signals shutdown', async () => {
  const { pool, connections } = fixture(); let lost = 0;
  const coordinator = createCoordination({ pool, onLost() { lost++; } });
  await coordinator.customer(1, async assertOwned => {
    connections[0].emit('error', new Error('synthetic'));
    assert.throws(assertOwned, /lost/);
  });
  assert.equal(lost, 1);
});

test('concurrent acquisition shares one session and shutdown fences a late successful lock', async () => {
  const { pool, connections } = fixture();
  const connect = pool.connect;
  let finish, connects = 0;
  pool.connect = async () => {
    connects++;
    const connection = await connect();
    const query = connection.query;
    connection.query = async (sql, values) => {
      if (sql.includes('pg_try_advisory_lock')) await new Promise(resolve => { finish = resolve; });
      return query(sql, values);
    };
    return connection;
  };
  let scheduled = 0;
  const coordinator = createCoordination({ pool, schedule() { scheduled++; return 1; }, cancel() {}, log: {} });
  const first = coordinator.acquire(), second = coordinator.acquire();
  assert.equal(first, second);
  await new Promise(setImmediate); assert.equal(connects, 1);
  await coordinator.release(); finish();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(coordinator.owned, false); assert.equal(scheduled, 0);
  assert.equal(connections[0].listenerCount('error'), 0);
  assert.equal(connections[0].listenerCount('end'), 0);
  await coordinator.close(); await assert.rejects(coordinator.acquire(), /closed/);
});

test('active lease loss fences new customer locks and unfenced remote mutations', async () => {
  const { pool, connections } = fixture();
  const coordinator = createCoordination({ pool, log: {} });
  await coordinator.acquire();
  connections[0].emit('error', new Error('synthetic'));
  assert.equal(coordinator.owned, false);
  assert.throws(() => coordinator.assertCurrent(), /ownership unavailable/);
  await assert.rejects(coordinator.customer(1, () => assert.fail()), /ownership unavailable/);
  await coordinator.close();
});
