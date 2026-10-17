'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { createRenderHosting, VERIFICATION_FILE, VERIFICATION_PATH } = require('./render-hosting');
const baseUrl = 'https://vpn-reseller-bot-1.onrender.com';
const legacyHostname = 'metrosecure.duckdns.org';

async function server(t, options = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createRenderHosting({ render: true, baseUrl, legacyHostname, ...options }));
  app.use((_req, res) => res.status(200).send('next-handler'));
  const listener = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  return (route, opts = {}) => fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
    redirect: 'manual', ...opts, headers: { 'X-Forwarded-Host': opts.headers?.Host || legacyHostname, ...opts.headers },
  });
}

test('Google ownership file retains the exact previously verified contents on both hosts', async t => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(VERIFICATION_FILE)).digest('hex'),
    'fe63dcb9d5409056d2e52fb372acc5d8adef112f897f97d8b635b3401f3b4da9');
  const get = await server(t);
  for (const host of [legacyHostname, new URL(baseUrl).hostname]) {
    const response = await get(VERIFICATION_PATH, { headers: { Host: host } });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(VERIFICATION_FILE));
  }
});
test('issued dynamic configuration paths stay on the original hostname without redirection', async t => {
  const get = await server(t);
  const response = await get('/vpn/config/' + 'a'.repeat(43));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.equal(await response.text(), 'next-handler');
});
test('old Mini App, admin and setup entrypoints preserve paths on the canonical Render origin', async t => {
  const get = await server(t);
  for (const route of ['/app/?startapp=synthetic', '/admin/login', '/connect/v1.synthetic']) {
    const response = await get(route);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), baseUrl + route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
test('canonical requests and non-Render hosting are unaffected', async t => {
  let get = await server(t);
  assert.equal((await get('/admin/login', { headers: { Host: new URL(baseUrl).hostname } })).status, 200);
  get = await server(t, { render: false });
  assert.equal((await get('/admin/login')).status, 200);
});
test('old-origin credential and API submissions are never forwarded or accepted', async t => {
  const get = await server(t);
  const response = await get('/admin/login', { method: 'POST', body: 'synthetic-only' });
  assert.equal(response.status, 421);
  assert.equal(response.headers.get('location'), null);
});
test('lookalike verification paths cannot read arbitrary files', async t => {
  const get = await server(t);
  assert.equal((await get(VERIFICATION_PATH + '.other')).status, 302);
  assert.equal((await get('/assets/../../package.json')).status, 302);
});
test('compatibility redirect cannot send a client to an arbitrary external origin', async t => {
  const get = await server(t);
  const response = await get('//external.invalid/path');
  assert.equal(response.headers.get('location'), baseUrl + '//external.invalid/path');
  assert.equal(new URL(response.headers.get('location')).origin, baseUrl);
});
test('unsafe compatibility configuration fails closed', () => {
  for (const url of ['http://vpn-reseller-bot-1.onrender.com', 'https://external.invalid', baseUrl + '/other']) {
    assert.throws(() => createRenderHosting({ render: true, baseUrl: url, legacyHostname }));
  }
  assert.throws(() => createRenderHosting({ render: true, baseUrl, legacyHostname: 'bad.invalid:443' }));
});
