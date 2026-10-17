'use strict';
const { Pool } = require('pg');

// One active bot: 7 sessions maximum, including the checked-out owner session.
// Keep separate pools: a customer lock may be held while ORM/notification work runs.
const POOL_LIMITS = Object.freeze({ application: 1, coordination: 4, notifications: 1, sales: 1 });
const MAX_POOL_WAITERS = 32;
const ACQUIRE_TIMEOUT_MS = 10000;
class BoundedPool extends Pool {
  connect(callback) {
    if (this.waitingCount >= MAX_POOL_WAITERS) {
      const error = Object.assign(new Error('Database busy; retry the operation.'), { code: 'METRO_DB_BUSY' });
      if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; }
      return Promise.reject(error);
    }
    // pg removes timed-out waiters itself. Do not Promise.race a checkout: a late
    // checkout could leak a session or execute work after its caller gave up.
    return super.connect(callback);
  }
}
function createDatabasePool(kind, connectionString) {
  if (!Object.hasOwn(POOL_LIMITS, kind)) throw new Error('Unknown database pool.');
  const pool = new BoundedPool({ connectionString, max: POOL_LIMITS[kind],
    connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS, idleTimeoutMillis: 10000,
    statement_timeout: ['notifications', 'sales'].includes(kind) ? 15000 : 30000,
    keepAlive: true, keepAliveInitialDelayMillis: 10000, application_name: 'metro-' + kind });
  pool.on('error', () => console.error('Idle database connection unavailable.'));
  return pool;
}
module.exports = { POOL_LIMITS, MAX_POOL_WAITERS, ACQUIRE_TIMEOUT_MS, BoundedPool, createDatabasePool };
