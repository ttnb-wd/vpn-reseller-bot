const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const { getDatabaseClient } = require("./db");
const {
  getDashboardData, getUsersData, getUserDetail,
  getOrdersData, getOrderDetail, getOrderProof, getPaymentsData,
  getVpnKeysData, getPackagesData, getPackageDetail, validatePackageInput, updatePackage,
  getUsageData, usageMetrics, getSettingsData,
} = require("./admin-data");
const {
  renderDashboard, renderUsers, renderUserDetail,
  renderOrders, renderOrderDetail, renderPayments,
  renderVpnKeys, renderPackages, renderPackageEdit,
  renderUsage, renderSettings,
} = require("./admin-ui");
const { loadTelegramPaymentProof } = require("./admin-proof");

const COOKIE_NAME = "metro_admin_session";
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const MAX_TRACKED_IPS = 10000;
const MAX_SESSIONS = 1000;
const FORM_TOKEN_MAX_AGE_MS = 15 * 60 * 1000;

function normalizeOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function renderOriginFromEnv(env) {
  try {
    const url = new URL(env.RENDER_EXTERNAL_URL);
    if (url.protocol === "https:" && url.hostname.endsWith(".onrender.com") &&
        !url.port && !url.username && !url.password && url.pathname === "/" &&
        !url.search && !url.hash) return url.origin;
  } catch {
    // Render's external URL is optional outside Render.
  }
  const hostname = env.RENDER_EXTERNAL_HOSTNAME;
  return typeof hostname === "string" && /^[a-z0-9-]+\.onrender\.com$/i.test(hostname)
    ? `https://${hostname.toLowerCase()}` : null;
}

function validateAdminConfig(env = process.env) {
  for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD_HASH", "ADMIN_SESSION_SECRET"]) {
    if (!env[name]) throw new Error(`${name} is required.`);
  }
  if (!env.ADMIN_EMAIL.trim()) throw new Error("ADMIN_EMAIL is required.");
  if (Buffer.byteLength(env.ADMIN_SESSION_SECRET, "utf8") < 32) {
    throw new Error("ADMIN_SESSION_SECRET must contain at least 32 bytes.");
  }
  try {
    const rounds = bcrypt.getRounds(env.ADMIN_PASSWORD_HASH);
    if (!Number.isInteger(rounds) || rounds < 10 ||
        !/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(env.ADMIN_PASSWORD_HASH)) throw new Error();
  } catch {
    throw new Error("ADMIN_PASSWORD_HASH must be a valid bcrypt hash with at least 10 rounds.");
  }
  return {
    email: env.ADMIN_EMAIL.trim(),
    passwordHash: env.ADMIN_PASSWORD_HASH,
    sessionSecret: env.ADMIN_SESSION_SECRET,
    production: env.NODE_ENV === "production",
    renderOrigin: renderOriginFromEnv(env),
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function setPageHeaders(res, nonce) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
}

function renderPage(title, body, nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Metro Secure Admin</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; background: radial-gradient(circle at top, #123551, #091827 55%); color: #e9f4ff; }
    main { width: min(100% - 2rem, 760px); margin: 0 auto; padding: clamp(2rem, 8vh, 6rem) 0; }
    .card { background: #10283c; border: 1px solid #2b5670; border-radius: 18px; padding: clamp(1.5rem, 5vw, 2.25rem); box-shadow: 0 20px 60px #0005; }
    .eyebrow { color: #70d8f8; font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; }
    h1 { margin: .45rem 0 1.5rem; font-size: clamp(1.75rem, 5vw, 2.3rem); }
    p { line-height: 1.5; color: #c2d7e6; }
    label { display: block; margin: 1rem 0 .4rem; font-weight: 600; }
    input { width: 100%; padding: .8rem .9rem; border-radius: 9px; border: 1px solid #51829c; background: #081d2e; color: #fff; font: inherit; }
    input:focus-visible, button:focus-visible { outline: 3px solid #70d8f8; outline-offset: 2px; }
    button { cursor: pointer; border: 0; border-radius: 9px; padding: .8rem 1.1rem; background: #35b9e8; color: #062034; font: inherit; font-weight: 700; }
    button:hover { background: #70d8f8; }
    .primary { width: 100%; margin-top: 1.5rem; }
    .error { color: #ffe0e0; background: #743a45; border-radius: 8px; padding: .75rem; }
    .topline { display: flex; gap: 1rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .identity { margin: 0 0 1.5rem; overflow-wrap: anywhere; }
    .nav { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .7rem; margin-top: 1rem; }
    .nav span { display: block; border: 1px solid #2b5670; border-radius: 9px; padding: .9rem; color: #aec5d6; }
    .nav .current { color: #e9f4ff; border-color: #35b9e8; background: #173c53; }
    .hint { font-size: .85rem; color: #a2b9c9; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function renderLogin(res, message, formToken) {
  const nonce = crypto.randomBytes(16).toString("base64");
  setPageHeaders(res, nonce);
  return res.type("html").send(renderPage("Sign In", `
    <section class="card">
      <div class="eyebrow">Metro Secure</div>
      <h1>Metro Secure Admin</h1>
      ${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ""}
      <form method="post" action="/admin/login">
        <input type="hidden" name="_csrf" value="${formToken}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required maxlength="254">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit">Sign In</button>
      </form>
    </section>`, nonce));
}

function createAdminRouter(config) {
  const router = express.Router();
  const sessions = new Map();
  const loginAttempts = new Map();
  const cookieOptions = {
    httpOnly: true, secure: config.production, sameSite: "lax", path: "/admin",
  };
  const formCookieName = config.production ? "__Host-metro_admin_form" : "metro_admin_form";
  const formCookieBaseOptions = {
    httpOnly: true, secure: config.production, sameSite: "lax",
    path: config.production ? "/" : "/admin",
  };
  const formCookieOptions = { ...formCookieBaseOptions, maxAge: FORM_TOKEN_MAX_AGE_MS };

  function prune(map, now) {
    for (const [key, expiresAt] of map) {
      if (expiresAt <= now) map.delete(key);
    }
  }

  function sign(sessionId) {
    return crypto.createHmac("sha256", config.sessionSecret).update(sessionId).digest("base64url");
  }

  function signFormToken(token) {
    return crypto.createHmac("sha256", config.sessionSecret)
      .update(`admin-form:${token}`).digest("base64url");
  }

  function issueFormToken(res) {
    const token = `${(Date.now() + FORM_TOKEN_MAX_AGE_MS).toString(36)}.${crypto.randomBytes(32).toString("base64url")}`;
    res.cookie(formCookieName, `${token}.${signFormToken(token)}`, formCookieOptions);
    return token;
  }

  function hasValidFormToken(req) {
    const token = req.body?._csrf;
    if (typeof token !== "string" || !/^[0-9a-z]{1,12}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const cookie = (req.headers.cookie || "").split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${formCookieName}=`));
    const value = cookie?.slice(formCookieName.length + 1);
    if (!value || value.length !== token.length + 44 || !value.startsWith(`${token}.`)) return false;
    const expiresAt = parseInt(token.split(".")[0], 36);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
        expiresAt > Date.now() + FORM_TOKEN_MAX_AGE_MS) return false;
    const actual = Buffer.from(value.slice(token.length + 1));
    const expected = Buffer.from(signFormToken(token));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  function readSessionId(req) {
    const match = (req.headers.cookie || "").match(/(?:^|;\s*)metro_admin_session=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    if (!match) return null;
    const [id, signature] = match[1].split(".");
    if (!/^[A-Za-z0-9_-]{43}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
    const expected = Buffer.from(sign(id));
    const actual = Buffer.from(signature);
    if (!crypto.timingSafeEqual(expected, actual)) return null;
    const expiresAt = sessions.get(id);
    if (!expiresAt || expiresAt <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return id;
  }

  function requireAdmin(req, res, next) {
    const sessionId = readSessionId(req);
    if (!sessionId) return res.redirect(303, "/admin/login");
    req.adminSessionId = sessionId;
    next();
  }

  function validFormRequest(req) {
    const originHeader = req.get("Origin");
    // The signed form token covers browsers that omit Origin. Some browsers
    // send the literal "null" even on same-origin form navigation; require
    // their same-origin Fetch Metadata signal as well as the token.
    if (!originHeader) return hasValidFormToken(req);
    if (originHeader === "null") {
      return req.get("Sec-Fetch-Site") === "same-origin" && hasValidFormToken(req);
    }
    const origin = normalizeOrigin(originHeader);
    if (!origin) return false;
    if (config.production) {
      // These origins come from server configuration, not client-supplied Host
      // or X-Forwarded-Host headers, which can differ behind Render's proxy.
      return origin === normalizeOrigin(config.expectedOrigin) ||
        origin === normalizeOrigin(config.renderOrigin);
    }
    const host = req.get("Host");
    return Boolean(host && origin === normalizeOrigin(`${req.protocol}://${host}`));
  }

  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store, max-age=0");
    if (config.production && !req.secure) {
      return res.status(400).type("text").send("Use HTTPS for admin access.");
    }
    next();
  });

  router.get("/login", (req, res) => {
    if (readSessionId(req)) return res.redirect(303, "/admin");
    return renderLogin(res, undefined, issueFormToken(res));
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    if (!validFormRequest(req)) return res.sendStatus(403);
    if (readSessionId(req)) return res.redirect(303, "/admin");

    const now = Date.now();
    for (const [ip, record] of loginAttempts) {
      if (record.resetAt <= now) loginAttempts.delete(ip);
    }
    const ip = req.ip || "unknown";
    const record = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    if (record.count >= MAX_FAILED_LOGINS) {
      res.set("Retry-After", String(Math.ceil((record.resetAt - now) / 1000)));
      return renderLogin(res.status(429), "Too many attempts. Please try again later.", issueFormToken(res));
    }

    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" && req.body.password.length <= 1024
      ? req.body.password : "";
    const submittedEmail = crypto.createHash("sha256").update(email).digest();
    const expectedEmail = crypto.createHash("sha256").update(config.email.toLowerCase()).digest();
    const emailMatches = crypto.timingSafeEqual(submittedEmail, expectedEmail);
    const passwordMatches = await bcrypt.compare(password, config.passwordHash);

    if (!emailMatches || !passwordMatches || !password) {
      record.count++;
      loginAttempts.delete(ip);
      loginAttempts.set(ip, record);
      if (loginAttempts.size > MAX_TRACKED_IPS) loginAttempts.delete(loginAttempts.keys().next().value);
      return renderLogin(res.status(401), "Invalid email or password.", issueFormToken(res));
    }

    loginAttempts.delete(ip);
    prune(sessions, now);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const sessionId = crypto.randomBytes(32).toString("base64url");
    sessions.set(sessionId, now + SESSION_MAX_AGE_MS);
    res.cookie(COOKIE_NAME, `${sessionId}.${sign(sessionId)}`, {
      ...cookieOptions, maxAge: SESSION_MAX_AGE_MS,
    });
    return res.redirect(303, "/admin");
  });

  // Every route registered below this point requires a valid session.
  router.use(requireAdmin);

  const getClient = config.getClient || getDatabaseClient;
  const dataApi = config.dataApi || {
    getDashboardData, getUsersData, getUserDetail,
    getOrdersData, getOrderDetail, getOrderProof, getPaymentsData,
    getVpnKeysData, getPackagesData, getPackageDetail, validatePackageInput, updatePackage,
    getUsageData, usageMetrics, getSettingsData,
  };
  const proofLoader = config.proofLoader || loadTelegramPaymentProof;

  function validOrderId(value) {
    return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
  }

  router.get("/", async (req, res) => {
    try {
      const data = await dataApi.getDashboardData(getClient());
      return renderDashboard(res, config.email, issueFormToken(res), data);
    } catch {
      console.error("Admin dashboard query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/users", async (req, res) => {
    try {
      const data = await dataApi.getUsersData(getClient(), req.query);
      return renderUsers(res, config.email, issueFormToken(res), data);
    } catch {
      console.error("Admin users query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/users/:id", async (req, res) => {
    if (!/^[1-9]\d{0,9}$/.test(req.params.id) || Number(req.params.id) > 2147483647) {
      return res.sendStatus(404);
    }
    try {
      const customer = await dataApi.getUserDetail(getClient(), Number(req.params.id));
      if (!customer) return res.sendStatus(404);
      return renderUserDetail(res, config.email, issueFormToken(res), customer);
    } catch {
      console.error("Admin user detail query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/orders", async (req, res) => {
    try {
      const data = await dataApi.getOrdersData(getClient(), req.query);
      return renderOrders(res, config.email, issueFormToken(res), data);
    } catch {
      console.error("Admin orders query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/orders/:id", async (req, res) => {
    if (!validOrderId(req.params.id)) return res.sendStatus(404);
    try {
      const order = await dataApi.getOrderDetail(getClient(), Number(req.params.id));
      if (!order) return res.sendStatus(404);
      return renderOrderDetail(res, config.email, issueFormToken(res), order);
    } catch {
      console.error("Admin order detail query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/payments", async (req, res) => {
    try {
      const data = await dataApi.getPaymentsData(getClient(), req.query);
      return renderPayments(res, config.email, issueFormToken(res), data);
    } catch {
      console.error("Admin payments query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/payment-proof/:orderId", async (req, res) => {
    if (!validOrderId(req.params.orderId)) return res.sendStatus(404);
    try {
      const order = await dataApi.getOrderProof(getClient(), Number(req.params.orderId));
      if (!order?.paymentProof) return res.sendStatus(404);
      const proof = await proofLoader(order.paymentProof);
      if (!proof) return res.sendStatus(404);
      const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
      const extension = extensions[proof.contentType];
      if (!extension || !Buffer.isBuffer(proof.bytes)) throw new Error("Invalid proof response.");
      res.set({
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `inline; filename="payment-proof.${extension}"`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      return res.type(proof.contentType).send(proof.bytes);
    } catch {
      console.error("Admin payment proof fetch failed.");
      return res.status(502).type("text").send("Payment proof is temporarily unavailable.");
    }
  });

  router.get("/vpn-keys", async (req, res) => {
    try {
      const data = await dataApi.getVpnKeysData(getClient(), req.query);
      return renderVpnKeys(res, config.email, issueFormToken(res), data);
    } catch {
      console.error("Admin VPN keys query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/packages", async (req, res) => {
    try {
      const data = await dataApi.getPackagesData(getClient(), req.query);
      return renderPackages(res, config.email, issueFormToken(res), data, req.query.saved === "1");
    } catch {
      console.error("Admin packages query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/packages/:id/edit", async (req, res) => {
    if (!validOrderId(req.params.id)) return res.sendStatus(404);
    try {
      const pkg = await dataApi.getPackageDetail(getClient(), Number(req.params.id));
      if (!pkg) return res.sendStatus(404);
      return renderPackageEdit(res, config.email, issueFormToken(res), pkg);
    } catch {
      console.error("Admin package edit query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.post("/packages/:id/edit", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    if (!validFormRequest(req) || !hasValidFormToken(req)) return res.sendStatus(403);
    if (!validOrderId(req.params.id)) return res.sendStatus(404);
    try {
      const id = Number(req.params.id);
      const pkg = await dataApi.getPackageDetail(getClient(), id);
      if (!pkg) return res.sendStatus(404);
      const { errors, values } = dataApi.validatePackageInput(req.body);
      if (errors.length) {
        return renderPackageEdit(res.status(400), config.email, issueFormToken(res), pkg, errors, req.body);
      }
      await dataApi.updatePackage(getClient(), id, values);
      return res.redirect(303, "/admin/packages?saved=1");
    } catch {
      console.error("Admin package update failed.");
      return res.status(503).type("text").send("Package changes could not be saved.");
    }
  });

  router.get("/usage", async (req, res) => {
    try {
      const data = await dataApi.getUsageData(getClient(), req.query);
      return renderUsage(res, config.email, issueFormToken(res), data, dataApi.usageMetrics);
    } catch {
      console.error("Admin usage query failed.");
      return res.status(503).type("text").send("Admin data is temporarily unavailable.");
    }
  });

  router.get("/settings", (req, res) => {
    try {
      const operationalStatus = config.getOperationalStatus?.() || {};
      const settings = dataApi.getSettingsData(process.env, config, operationalStatus);
      return renderSettings(res, config.email, issueFormToken(res), settings);
    } catch {
      console.error("Admin settings view failed.");
      return res.status(503).type("text").send("Settings are temporarily unavailable.");
    }
  });

  router.post("/logout", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    if (!validFormRequest(req)) return res.sendStatus(403);
    sessions.delete(req.adminSessionId);
    res.clearCookie(COOKIE_NAME, cookieOptions);
    res.clearCookie(formCookieName, formCookieBaseOptions);
    return res.redirect(303, "/admin/login");
  });

  return router;
}

module.exports = { validateAdminConfig, createAdminRouter };
