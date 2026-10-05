const { prepareDatabaseUrl } = require('./db');
function validateProductionEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production' && env.RENDER !== 'true') return;
  if (env.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production.');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Global TLS verification must be enabled.');
  for (const name of ['BOT_TOKEN', 'ADMIN_TELEGRAM_ID', 'DATABASE_URL', 'OUTLINE_API_URL',
    'OUTLINE_API_CERT_SHA256', 'ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET',
    'PUBLIC_BASE_URL', 'CONNECT_TOKEN_SECRET']) {
    if (!env[name]?.trim()) throw new Error(`${name} is required.`);
  }
  if (!/^[1-9]\d*$/.test(env.ADMIN_TELEGRAM_ID)) throw new Error('ADMIN_TELEGRAM_ID is invalid.');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.BOT_TOKEN)) throw new Error('BOT_TOKEN is invalid.');
  prepareDatabaseUrl(env.DATABASE_URL, 'production');
}
function createReadiness({ configured, botHealthy, ownsLease, stopping, checkDatabase, timeoutMs = 2000 }) {
  let inFlight;
  return async () => {
    if (!configured() || !botHealthy() || !ownsLease() || stopping()) return false;
    let timer;
    try {
      // A timed-out health response must not leave room for another queued DB
      // query. All probes share the outstanding check until it really settles.
      inFlight ||= Promise.resolve().then(checkDatabase).finally(() => { inFlight = undefined; });
      return await Promise.race([
        inFlight.then(() =>
          Boolean(configured() && botHealthy() && ownsLease() && !stopping())),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  };
}
module.exports = { validateProductionEnvironment, createReadiness };
