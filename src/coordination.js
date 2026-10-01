const crypto = require('node:crypto');
const { Pool } = require('pg');
const { prepareDatabaseUrl } = require('./db');
const { AsyncLocalStorage } = require('node:async_hooks');

// Session advisory locks belong to a dedicated PostgreSQL connection, never
// to an ORM request or a pooled connection returned while work is running.
function createCoordination({ pool = new Pool({ connectionString:
  prepareDatabaseUrl(process.env.DATABASE_URL).toString(), max: 12,
  connectionTimeoutMillis: 10000, statement_timeout: 30000, keepAlive: true,
  keepAliveInitialDelayMillis: 10000 }),
  heartbeatMs = 10000, leaseMs = 60000, schedule = setInterval,
  cancel = clearInterval, onLost = () => {}, log = console } = {}) {
  const owner = crypto.randomUUID();
  const customerContext = new AsyncLocalStorage();
  let leaseRequired = false;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= heartbeatMs || heartbeatMs <= 0) {
    throw new Error('Invalid singleton heartbeat deadline.');
  }
  let lease, timer, owned = false, checking = false, acquisition, generation = 0, closed = false;
  pool.on('error', () => {});
  async function customer(id, work) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid customer lock.');
    if (closed || (leaseRequired && !owned)) throw new Error('Singleton ownership unavailable.');
    const connection = await pool.connect();
    let lost = false;
    const fail = () => { lost = true; onLost(); };
    connection.on('error', fail);
    connection.on('end', fail);
    try {
      await connection.query('SELECT pg_advisory_lock(1297302355, $1)', [id]);
      const assertOwned = () => {
        if (lost || (leaseRequired && !owned)) throw new Error('Customer lock lost.');
      };
      assertOwned();
      return await customerContext.run(assertOwned, () => work(assertOwned));
    } finally {
      try { await connection.query('SELECT pg_advisory_unlock(1297302355, $1)', [id]); }
      catch { lost = true; }
      connection.removeListener('error', fail);
      connection.removeListener('end', fail);
      connection.release(lost);
    }
  }
  function lose() {
    if (!owned) return;
    owned = false;
    cancel(timer);
    log.info?.('Singleton ownership lost.', { owner });
    onLost();
  }
  async function heartbeat() {
    if (!owned || checking) return;
    checking = true;
    try {
      // A live session owns the lock. idle_session_timeout expires abandoned
      // sessions even if a crashed client's TCP connection remains half open.
      await lease.query('SELECT 1');
    } catch { lose(); }
    finally { checking = false; }
  }
  async function acquireOnce(epoch) {
    const connection = await pool.connect();
    let ended = false;
    const failed = () => { ended = true; if (lease === connection) lose(); };
    const discard = () => {
      connection.removeListener('error', failed);
      connection.removeListener('end', failed);
      connection.release(true);
    };
    connection.on('error', failed);
    connection.on('end', failed);
    if (closed || epoch !== generation) { discard(); return false; }
    try {
      await connection.query(`SET idle_session_timeout = '${Math.floor(leaseMs)}ms'`);
      const result = await connection.query('SELECT pg_try_advisory_lock(1297302355, 0) AS owned');
      if (!result.rows[0].owned || ended || closed || epoch !== generation) {
        discard(); return false;
      }
      lease = connection;
      // Store cleanup with the session, including listeners from this attempt.
      leaseCleanup = discard;
      owned = true;
      leaseRequired = true;
      timer = schedule(() => { void heartbeat(); }, heartbeatMs);
      log.info?.('Singleton ownership acquired.', { owner });
      return true;
    } catch (error) { discard(); throw error; }
  }
  let leaseCleanup;
  function acquire() {
    if (closed) return Promise.reject(new Error('Coordination is closed.'));
    if (owned) return Promise.resolve(true);
    if (!acquisition) acquisition = acquireOnce(generation).finally(() => { acquisition = undefined; });
    return acquisition;
  }
  async function release() {
    generation++;
    cancel(timer);
    owned = false;
    if (!lease) return;
    lease = undefined;
    // Destroy the session: PostgreSQL releases every owned advisory lock.
    leaseCleanup();
    leaseCleanup = undefined;
    log.info?.('Singleton ownership released.', { owner });
  }
  return { owner, customer, acquire, heartbeat, release,
    assertCurrent() {
      if (leaseRequired && !owned) throw new Error('Singleton ownership unavailable.');
      customerContext.getStore()?.();
    },
    get owned() { return owned; }, async close() { closed = true; await release(); await pool.end(); } };
}
module.exports = { createCoordination };
