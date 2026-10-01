// Read-only, safe to run before considering a real-key uniqueness migration.
if (process.env.NODE_ENV !== 'production') require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { prepareDatabaseUrl } = require('../src/db');
async function detectDuplicates(pool) {
  const result = await pool.query(`SELECT count(*)::int AS groups,
    coalesce(sum(owners),0)::int AS subscriptions FROM (
      SELECT count(*) AS owners FROM public."subscription"
      WHERE "vpnKeyId" IS NOT NULL AND "vpnKeyId" NOT LIKE 'mock-%'
      GROUP BY "vpnKeyId" HAVING count(*) > 1
    ) duplicates`);
  return result.rows[0];
}
if (require.main === module) {
  const pool = new Pool({ connectionString: prepareDatabaseUrl(process.env.DATABASE_URL).toString(),
    connectionTimeoutMillis: 10000, statement_timeout: 15000 });
  detectDuplicates(pool).then(result => console.log('Outline ownership duplicates:', result))
    .catch(() => { console.error('Read-only ownership check unavailable.'); process.exitCode = 1; })
    .finally(() => pool.end());
}
module.exports = { detectDuplicates };
