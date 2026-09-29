const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");

const COOKIE_NAME = "metro_admin_session";
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const MAX_TRACKED_IPS = 10000;
const MAX_SESSIONS = 1000;

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

function renderLogin(res, message) {
  const nonce = crypto.randomBytes(16).toString("base64");
  setPageHeaders(res, nonce);
  return res.type("html").send(renderPage("Sign In", `
    <section class="card">
      <div class="eyebrow">Metro Secure</div>
      <h1>Metro Secure Admin</h1>
      ${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ""}
      <form method="post" action="/admin/login">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required maxlength="254">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit">Sign In</button>
      </form>
    </section>`, nonce));
}

function renderAdminHome(res, email) {
  const nonce = crypto.randomBytes(16).toString("base64");
  setPageHeaders(res, nonce);
  return res.type("html").send(renderPage("Home", `
    <section class="card">
      <div class="topline"><div><div class="eyebrow">Metro Secure</div><h1>Metro Secure Admin</h1></div>
        <form method="post" action="/admin/logout"><button type="submit">Logout</button></form></div>
      <p class="identity">Logged in as: <strong>${escapeHtml(email)}</strong></p>
      <div class="nav" aria-label="Admin sections">
        <span class="current" aria-current="page">Dashboard</span><span>Users</span>
        <span>Orders</span><span>Payments</span><span>VPN Keys</span><span>Packages</span>
        <span>Usage</span><span>Settings</span>
      </div>
      <p class="hint">Dashboard and Users are coming in the next phase.</p>
    </section>`, nonce));
}

function createAdminRouter(config) {
  const router = express.Router();
  const sessions = new Map();
  const loginAttempts = new Map();
  const cookieOptions = {
    httpOnly: true, secure: config.production, sameSite: "strict", path: "/admin",
  };

  function prune(map, now) {
    for (const [key, expiresAt] of map) {
      if (expiresAt <= now) map.delete(key);
    }
  }

  function sign(sessionId) {
    return crypto.createHmac("sha256", config.sessionSecret).update(sessionId).digest("base64url");
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

  function sameOrigin(req) {
    const origin = req.get("Origin");
    const host = req.get("Host");
    if (!origin || !host) return false;
    const requestOrigin = `${req.protocol}://${host}`;
    if (origin !== requestOrigin) return false;
    return !config.production || origin === config.expectedOrigin;
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
    return renderLogin(res);
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    if (!sameOrigin(req)) return res.sendStatus(403);
    if (readSessionId(req)) return res.redirect(303, "/admin");

    const now = Date.now();
    for (const [ip, record] of loginAttempts) {
      if (record.resetAt <= now) loginAttempts.delete(ip);
    }
    const ip = req.ip || "unknown";
    const record = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    if (record.count >= MAX_FAILED_LOGINS) {
      res.set("Retry-After", String(Math.ceil((record.resetAt - now) / 1000)));
      return renderLogin(res.status(429), "Too many attempts. Please try again later.");
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
      return renderLogin(res.status(401), "Invalid email or password.");
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

  router.get("/", (req, res) => renderAdminHome(res, config.email));

  router.post("/logout", (req, res) => {
    if (!sameOrigin(req)) return res.sendStatus(403);
    sessions.delete(req.adminSessionId);
    res.clearCookie(COOKIE_NAME, cookieOptions);
    return res.redirect(303, "/admin/login");
  });

  return router;
}

module.exports = { validateAdminConfig, createAdminRouter };
