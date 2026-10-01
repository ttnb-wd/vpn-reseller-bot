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
  let lease, timer, owned = false, checking = false;
  pool.on('error', () => {});
  async function customer(id, work) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid customer lock.');
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
  async function acquire() {
    if (owned) return true;
    lease = await pool.connect();
    lease.on('error', lose);
    lease.on('end', lose);
    try {
      await lease.query(`SET idle_session_timeout = '${Math.floor(leaseMs)}ms'`);
      const result = await lease.query('SELECT pg_try_advisory_lock(1297302355, 0) AS owned');
      owned = result.rows[0].owned;
      if (!owned) { lease.release(true); lease = undefined; return false; }
      leaseRequired = true;
      timer = schedule(() => { void heartbeat(); }, heartbeatMs);
      log.info?.('Singleton ownership acquired.', { owner });
      return true;
    } catch (error) { lease.release(true); lease = undefined; throw error; }
  }
  async function release() {
    cancel(timer);
    owned = false;
    if (!lease) return;
    const connection = lease;
    lease = undefined;
    // Destroy the session: PostgreSQL releases every owned advisory lock.
    connection.removeListener('error', lose);
    connection.removeListener('end', lose);
    connection.release(true);
    log.info?.('Singleton ownership released.', { owner });
  }
  return { owner, customer, acquire, heartbeat, release,
    assertCurrent() { customerContext.getStore()?.(); },
    get owned() { return owned; }, async close() { await release(); await pool.end(); } };
}
module.exports = { createCoordination };
