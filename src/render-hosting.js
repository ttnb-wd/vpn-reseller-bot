'use strict';
const path = require('node:path');

const VERIFICATION_PATH = '/google283a6adcc2431f3c.html';
const VERIFICATION_FILE = path.join(__dirname, '..', 'assets', 'google283a6adcc2431f3c.html');

// Keep issued configuration URLs working on the former application hostname.
// Browsers use the canonical origin so cookies and CSRF stay origin-bound.
function createRenderHosting({ render = false, baseUrl, legacyHostname } = {}) {
  let origin, alias;
  if (render && legacyHostname) {
    const target = new URL(baseUrl);
    if (target.protocol !== 'https:' || target.username || target.password ||
        target.pathname !== '/' || target.search || target.hash || target.port ||
        !/^[a-z0-9-]+\.onrender\.com$/i.test(target.hostname)) {
      throw new Error('Render compatibility requires the canonical Render HTTPS origin.');
    }
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(legacyHostname) ||
        legacyHostname.toLowerCase() === target.hostname.toLowerCase()) {
      throw new Error('Invalid legacy public hostname.');
    }
    origin = target.origin;
    alias = legacyHostname.toLowerCase();
  }
  return (req, res, next) => {
    if (req.path === VERIFICATION_PATH && ['GET', 'HEAD'].includes(req.method)) {
      return res.sendFile(VERIFICATION_FILE, { cacheControl: false, dotfiles: 'deny' });
    }
    if (!alias || req.hostname.toLowerCase() !== alias) return next();
    // This route reads the same Aiven token/key record on either hostname.
    if (/^\/vpn\/config\/[A-Za-z0-9_-]{43}$/.test(req.path)) return next();
    if (!['GET', 'HEAD'].includes(req.method)) {
      return res.status(421).type('text').send('Open the application on its canonical HTTPS hostname.');
    }
    if (!req.originalUrl.startsWith('/') || /[\\\r\n]/.test(req.originalUrl)) return res.sendStatus(400);
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, origin + req.originalUrl);
  };
}

module.exports = { createRenderHosting, VERIFICATION_PATH, VERIFICATION_FILE };
