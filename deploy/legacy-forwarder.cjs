'use strict';
// Optional Render compatibility service. Never import bot.js, dotenv or a DB client.
const http = require('node:http');
const https = require('node:https');
const TARGET = 'https://metrosecure.duckdns.org';
const RESPONSE_HEADERS = ['content-type', 'content-security-policy',
  'x-content-type-options', 'x-frame-options', 'permissions-policy',
  'strict-transport-security', 'referrer-policy'];

function createLegacyHandler({ request = https.request, timeoutMs = 15000,
  maxBytes = 512 * 1024, maxActive = 32 } = {}) {
  let active = 0;
  return (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body = '') => { res.writeHead(status); res.end(body); };
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD'); return reply(405);
    }
    if (req.url === '/live' || req.url === '/') return reply(200, 'Legacy link service.');
    // Render must terminate TLS and overwrite this header at its private ingress.
    if (!req.socket.encrypted && req.headers['x-forwarded-proto'] !== 'https') return reply(400);
    if (req.url.length > 1024) return reply(414);
    if (['/app', '/app/', '/mini-app', '/mini-app/'].includes(req.url)) {
      res.setHeader('Location', `${TARGET}/app/`); return reply(302);
    }
    // Exact raw paths only. No arbitrary destinations, redirects, APIs or admin proxy.
    if (!/^\/(?:vpn\/config\/[A-Za-z0-9_-]{43}|connect\/v1\.[A-Za-z0-9_-]{40,240})(?:\?[^#\r\n]*)?$/.test(req.url)) return reply(404);
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) return reply(400);
    if (active >= maxActive) { res.setHeader('Retry-After', '3'); return reply(503); }
    active++;
    let done = false, outbound, incoming, deadline;
    const finish = () => {
      if (done) return false;
      done = true; active--; clearTimeout(deadline); return true;
    };
    const fail = () => {
      if (!finish()) return;
      outbound?.destroy(); incoming?.destroy();
      if (!res.destroyed) reply(502, 'Legacy link temporarily unavailable.');
    };
    deadline = setTimeout(fail, timeoutMs);
    res.once('close', () => {
      if (finish()) { outbound?.destroy(); incoming?.destroy(); }
    });
    try {
      outbound = request(new URL(req.url, TARGET), {
        method: req.method, agent: false, rejectUnauthorized: true,
        // Never forward cookies, Authorization, client Host or forwarded identity.
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
      }, upstream => {
        incoming = upstream;
        if (done) { upstream.destroy(); return; }
        if (![200, 400, 404, 410, 429, 500, 502, 503, 504].includes(upstream.statusCode)) return fail();
        const chunks = []; let bytes = 0;
        upstream.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) return fail();
          chunks.push(chunk);
        });
        upstream.once('error', fail);
        upstream.once('aborted', fail);
        upstream.once('end', () => {
          if (!upstream.complete || !finish()) return fail();
          for (const name of RESPONSE_HEADERS) {
            if (typeof upstream.headers[name] === 'string') res.setHeader(name, upstream.headers[name]);
          }
          if (/^\d{1,6}$/.test(upstream.headers['retry-after'] || '')) res.setHeader('Retry-After', upstream.headers['retry-after']);
          // Enforce no-store even if an upstream accidentally permits caching.
          res.writeHead(upstream.statusCode);
          res.end(req.method === 'HEAD' ? undefined : Buffer.concat(chunks));
        });
      });
      outbound.once('error', fail);
      outbound.end();
    } catch { fail(); }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const server = http.createServer(createLegacyHandler());
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.listen(port);
  // No access logs, token paths, query strings, credentials or upstream errors.
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 20000).unref();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
module.exports = { createLegacyHandler };
