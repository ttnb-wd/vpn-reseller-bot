const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createLegacyHandler } = require('./legacy-forwarder.cjs');
const token = 'a'.repeat(43);
async function fixture(work, overrides = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options });
    const outbound = new EventEmitter();
    outbound.destroy = () => {};
    outbound.end = () => queueMicrotask(() => {
      if (overrides.hang) return;
      if (overrides.error) return outbound.emit('error', new Error('synthetic-secret-error'));
      const response = new PassThrough(); response.statusCode = overrides.status || 200;
      response.headers = { 'content-type': 'application/yaml', 'set-cookie': 'private=secret',
        'cache-control': 'public,max-age=9999', 'content-security-policy': "default-src 'none'",
        'location': 'https://untrusted.invalid/', ...overrides.headers };
      response.complete = true;
      callback(response); response.end(overrides.body || 'transport:\n  synthetic: true\n');
    });
    return outbound;
  };
  const server = http.createServer(createLegacyHandler({ request, ...overrides }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchLocal = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init,
    headers: { 'x-forwarded-proto': 'https', ...init.headers } });
  try { await work(fetchLocal, calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('legacy YAML preserves bytes, token and query; does not forward identity or cookies', async () => {
  await fixture(async (get, calls) => {
    const response = await get(`/vpn/config/${token}?client=outline`, { headers: {
      Cookie: 'admin=private', Authorization: 'Bearer private', 'X-Forwarded-For': '203.0.113.2' } });
    assert.equal(response.status, 200); assert.equal(await response.text(), 'transport:\n  synthetic: true\n');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('location'), null);
    assert.equal(calls[0].url.href, `https://metrosecure.duckdns.org/vpn/config/${token}?client=outline`);
    assert.equal(calls[0].options.rejectUnauthorized, true);
    assert.deepEqual(calls[0].options.headers, { Accept: '*/*', 'Accept-Encoding': 'identity' });
  });
});
test('legacy helper forwards unchanged ciphertext and preserves CSP; Mini App redirects to new host', async () => {
  await fixture(async (get, calls) => {
    assert.equal((await get('/connect/v1.' + 'b'.repeat(80) + '?lang=en')).status, 200);
    assert.equal(calls.length, 1);
    const app = await get('/app'); assert.equal(app.status, 302);
    assert.equal(app.headers.get('location'), 'https://metrosecure.duckdns.org/app/');
    assert.equal(calls.length, 1);
  });
});
test('forwarder rejects HTTP credential requests, malformed paths, mutations, APIs and admin', async () => {
  await fixture(async (get, calls) => {
    for (const path of ['/admin', '/app/api/orders', '/vpn/config/short', '/connect/not-a-token', '//evil.invalid/key']) {
      assert.equal((await get(path)).status, 404);
    }
    assert.equal((await get(`/vpn/config/${token}`, { headers: { 'x-forwarded-proto': 'http' } })).status, 400);
    assert.equal((await get(`/vpn/config/${token}`, { method: 'POST' })).status, 405);
    assert.equal((await get('/live')).status, 200); assert.equal(calls.length, 0);
  });
});
test('upstream error statuses and HEAD remain safe; redirects are not followed', async () => {
  for (const status of [404, 410, 429, 503]) await fixture(async get => {
    assert.equal((await get(`/vpn/config/${token}`)).status, status);
  }, { status });
  await fixture(async get => { assert.equal((await get(`/vpn/config/${token}`)).status, 502); }, { status: 302 });
  await fixture(async get => { const r = await get(`/vpn/config/${token}`, { method: 'HEAD' });
    assert.equal(r.status, 200); assert.equal(await r.text(), ''); });
});
test('upstream failures, timeouts and oversize bodies return generic errors without secret text', async () => {
  for (const option of [{ error: true }, { hang: true, timeoutMs: 20 }, { maxBytes: 2 }]) {
    await fixture(async get => {
      const r = await get(`/vpn/config/${token}`); assert.equal(r.status, 502);
      assert.doesNotMatch(await r.text(), /synthetic-secret|transport|aaaa/);
    }, option);
  }
});
test('concurrent forwarding is bounded and releases the slot after timeout', async () => {
  await fixture(async get => {
    const pending = get(`/vpn/config/${token}`);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await get(`/vpn/config/${token}`)).status, 503);
    assert.equal((await pending).status, 502);
    assert.equal((await get(`/vpn/config/${token}`)).status, 502);
  }, { hang: true, maxActive: 1, timeoutMs: 80 });
});
