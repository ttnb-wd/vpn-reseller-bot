const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionEnvironment, createReadiness } = require('./startup-health');
const env = { NODE_ENV: 'production', BOT_TOKEN: '123456:' + 's'.repeat(32), ADMIN_TELEGRAM_ID: '42',
  DATABASE_URL: 'postgres://synthetic:fake@db.example/test?sslmode=verify-full',
  OUTLINE_API_URL: 'https://outline.example/test', OUTLINE_API_CERT_SHA256: 'a'.repeat(64),
  ADMIN_EMAIL: 'synthetic@example.test', ADMIN_PASSWORD_HASH: 'synthetic',
  ADMIN_SESSION_SECRET: 's'.repeat(32), PUBLIC_BASE_URL: 'https://vpn.example.test',
  CONNECT_TOKEN_SECRET: 's'.repeat(32) };
test('production startup requires all named environment values without exposing values', () => {
  assert.doesNotThrow(() => validateProductionEnvironment(env));
  for (const name of Object.keys(env).filter(key => key !== 'NODE_ENV')) {
    const missing = { ...env }; delete missing[name];
    assert.throws(() => validateProductionEnvironment(missing), new RegExp(name));
  }
  assert.throws(() => validateProductionEnvironment({ ...env, RENDER: 'true', NODE_ENV: 'development' }), /NODE_ENV/);
  assert.throws(() => validateProductionEnvironment({ ...env,
    DATABASE_URL: env.DATABASE_URL.replace('verify-full', 'require') + '&uselibpqcompat=true' }), /verified TLS/);
});
test('readiness requires config, DB, singleton and bot and fails closed with bounded DB timeout', async () => {
  const state = { configured: true, botHealthy: true, ownsLease: true, stopping: false };
  const callbacks = Object.fromEntries(Object.keys(state).map(key => [key, () => state[key]]));
  let checkDatabase = async () => {};
  const ready = createReadiness({ ...callbacks, timeoutMs: 20, checkDatabase: () => checkDatabase() });
  assert.equal(await ready(), true);
  for (const key of ['configured', 'botHealthy', 'ownsLease']) {
    state[key] = false; assert.equal(await ready(), false); state[key] = true;
  }
  state.stopping = true; assert.equal(await ready(), false); state.stopping = false;
  checkDatabase = async () => { throw new Error('synthetic-private-detail'); };
  assert.equal(await ready(), false);
  checkDatabase = () => new Promise(() => {}); assert.equal(await ready(), false);
});
