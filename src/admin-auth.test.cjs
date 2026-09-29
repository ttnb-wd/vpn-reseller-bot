const assert = require("node:assert/strict");
const { test } = require("node:test");
const bcrypt = require("bcryptjs");
const express = require("express");
const { validateAdminConfig, createAdminRouter } = require("./admin-auth");

const email = "admin@example.test";
const password = "synthetic-test-password";
const passwordHash = bcrypt.hashSync(password, 10);
const sessionSecret = "synthetic-session-secret-for-route-tests-only";

function config(production = false, renderUrl) {
  return validateAdminConfig({
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD_HASH: passwordHash,
    ADMIN_SESSION_SECRET: sessionSecret,
    NODE_ENV: production ? "production" : "test",
    RENDER_EXTERNAL_URL: renderUrl,
  });
}

async function startServer(production = false, options = {}) {
  const app = express();
  app.set("trust proxy", production ? 1 : "loopback");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  app.use("/admin", createAdminRouter({
    ...config(production, options.renderUrl),
    expectedOrigin: options.expectedOrigin || base.replace("http:", "https:"),
  }));
  return {
    server, base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("admin configuration rejects missing or invalid values by name", () => {
  for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD_HASH", "ADMIN_SESSION_SECRET"]) {
    const env = { ADMIN_EMAIL: email, ADMIN_PASSWORD_HASH: passwordHash, ADMIN_SESSION_SECRET: sessionSecret };
    delete env[name];
    assert.throws(() => validateAdminConfig(env), new RegExp(name));
  }
  assert.throws(() => validateAdminConfig({
    ADMIN_EMAIL: email, ADMIN_PASSWORD_HASH: "invalid", ADMIN_SESSION_SECRET: sessionSecret,
  }), /ADMIN_PASSWORD_HASH/);
  assert.equal(validateAdminConfig({
    ADMIN_EMAIL: email, ADMIN_PASSWORD_HASH: passwordHash,
    ADMIN_SESSION_SECRET: sessionSecret,
    RENDER_EXTERNAL_HOSTNAME: "metro-secure.onrender.com",
  }).renderOrigin, "https://metro-secure.onrender.com");
});

test("admin routes require a session; login, CSRF checks, and logout work", async (t) => {
  const site = await startServer();
  t.after(site.close);
  const request = (path, options = {}) => fetch(site.base + path, { redirect: "manual", ...options });
  for (const path of ["/admin", "/admin/users", "/admin/orders"]) {
    const response = await request(path);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/admin/login");
  }

  const loginPage = await request("/admin/login");
  const html = await loginPage.text();
  assert.equal(loginPage.status, 200);
  assert.match(html, /Metro Secure Admin/);
  assert.match(html, /type="password"/);
  assert.equal(html.includes(passwordHash), false);
  assert.equal(html.includes(sessionSecret), false);

  const body = new URLSearchParams({ email, password });
  const crossSite = await request("/admin/login", {
    method: "POST", headers: { Origin: "https://other.example.test" }, body,
  });
  assert.equal(crossSite.status, 403);

  const wrong = await request("/admin/login", {
    method: "POST", headers: { Origin: site.base },
    body: new URLSearchParams({ email: "wrong@example.test", password }),
  });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Invalid email or password/);

  const login = await request("/admin/login", {
    method: "POST", headers: { Origin: site.base }, body,
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/admin");
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\/admin/i);
  assert.match(setCookie, /Max-Age=1800/i);
  assert.equal(setCookie.includes(email), false);
  assert.equal(setCookie.includes(passwordHash), false);
  const cookie = setCookie.split(";")[0];

  const home = await request("/admin", { headers: { Cookie: cookie } });
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeHtml, /Logged in as:/);
  assert.match(homeHtml, /admin@example.test/);
  assert.match(homeHtml, /Dashboard[\s\S]*Users[\s\S]*Settings/);
  assert.equal(homeHtml.includes(passwordHash), false);
  assert.equal(homeHtml.includes(sessionSecret), false);

  const tampered = await request("/admin", { headers: { Cookie: cookie.slice(0, -1) + "x" } });
  assert.equal(tampered.status, 303);
  const blockedLogout = await request("/admin/logout", {
    method: "POST", headers: { Cookie: cookie, Origin: "https://other.example.test" },
  });
  assert.equal(blockedLogout.status, 403);
  assert.equal((await request("/admin", { headers: { Cookie: cookie } })).status, 200);

  const logout = await request("/admin/logout", {
    method: "POST", headers: { Cookie: cookie, Origin: site.base },
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/admin/login");
  assert.equal((await request("/admin", { headers: { Cookie: cookie } })).status, 303);
});

test("login limits repeated failures without limiting other admin requests", async (t) => {
  const site = await startServer();
  t.after(site.close);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(site.base + "/admin/login", {
      method: "POST", redirect: "manual", headers: { Origin: site.base },
      body: new URLSearchParams({ email, password: "wrong" }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(site.base + "/admin/login", {
    method: "POST", redirect: "manual", headers: { Origin: site.base },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /try again later/i);
  assert.equal((await fetch(site.base + "/admin/login")).status, 200);
});

test("production session cookie is Secure", async (t) => {
  const site = await startServer(true);
  t.after(site.close);
  assert.equal((await fetch(site.base + "/admin/login")).status, 400);
  const response = await fetch(site.base + "/admin/login", {
    method: "POST", redirect: "manual",
    headers: {
      Origin: site.base.replace("http:", "https:"),
      "X-Forwarded-Proto": "https",
    },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("set-cookie"), /Secure/i);
});

test("Render proxy login accepts the configured external origin and rejects cross-origin posts", async (t) => {
  const renderOrigin = "https://metro-secure.onrender.com";
  const site = await startServer(true, {
    expectedOrigin: "https://vpn.example.test",
    renderUrl: renderOrigin,
  });
  t.after(site.close);
  const proxyHeaders = {
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "metro-secure.onrender.com",
  };
  const request = (path, options = {}) => fetch(site.base + path, {
    redirect: "manual", ...options,
  });
  assert.equal((await request("/admin/login", { headers: proxyHeaders })).status, 200);
  assert.equal((await request("/admin", { headers: proxyHeaders })).status, 303);
  const blockedLogin = await request("/admin/login", {
    method: "POST",
    headers: { ...proxyHeaders, Origin: "https://attacker.example.test" },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(blockedLogin.status, 403);
  const valid = await request("/admin/login", {
    method: "POST",
    headers: { ...proxyHeaders, Origin: renderOrigin },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(valid.status, 303);
  assert.equal(valid.headers.get("location"), "/admin");
  assert.match(valid.headers.get("set-cookie"), /Secure/i);
  const cookie = valid.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/admin", {
    headers: { ...proxyHeaders, Cookie: cookie },
  })).status, 200);

  const crossOrigin = await request("/admin/logout", {
    method: "POST",
    headers: { ...proxyHeaders, Cookie: cookie, Origin: "https://attacker.example.test" },
  });
  assert.equal(crossOrigin.status, 403);
  const logout = await request("/admin/logout", {
    method: "POST",
    headers: { ...proxyHeaders, Cookie: cookie, Origin: renderOrigin },
  });
  assert.equal(logout.status, 303);
  assert.equal((await request("/admin", {
    headers: { ...proxyHeaders, Cookie: cookie },
  })).status, 303);
});

test("Render login accepts configured origins and signed same-origin null Origin submissions", async (t) => {
  const renderOrigin = "https://vpn-reseller-bot-1.onrender.com";
  const site = await startServer(true, {
    expectedOrigin: `${renderOrigin}/`,
  });
  t.after(site.close);
  const proxyHeaders = { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "internal.proxy.test" };
  const request = (options = {}) => fetch(site.base + "/admin/login", {
    redirect: "manual", ...options,
  });
  const page = await request({ headers: proxyHeaders });
  assert.equal(page.status, 200);
  const html = await page.text();
  const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(token);
  const formCookie = page.headers.get("set-cookie").split(";")[0];

  const nullWithoutToken = await request({
    method: "POST",
    headers: { ...proxyHeaders, Origin: "null", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(nullWithoutToken.status, 403);
  const nullCrossSite = await request({
    method: "POST",
    headers: { ...proxyHeaders, Origin: "null", "Sec-Fetch-Site": "cross-site", Cookie: formCookie },
    body: new URLSearchParams({ email, password, _csrf: token }),
  });
  assert.equal(nullCrossSite.status, 403);
  const nullSameOrigin = await request({
    method: "POST",
    headers: {
      ...proxyHeaders, Origin: "null", "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Cookie: formCookie,
    },
    body: new URLSearchParams({ email, password, _csrf: token }),
  });
  assert.equal(nullSameOrigin.status, 303);
  assert.equal(nullSameOrigin.headers.get("location"), "/admin");

  const missingOrigin = await request({
    method: "POST", headers: { ...proxyHeaders },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(missingOrigin.status, 403);
  const foreignOrigin = await request({
    method: "POST",
    headers: { ...proxyHeaders, Origin: "https://foreign.example.test", Cookie: formCookie },
    body: new URLSearchParams({ email, password, _csrf: token }),
  });
  assert.equal(foreignOrigin.status, 403);
  const slashOrigin = await request({
    method: "POST", headers: { ...proxyHeaders, Origin: `${renderOrigin}/` },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(slashOrigin.status, 303);
  assert.equal(slashOrigin.headers.get("location"), "/admin");
  const defaultPortOrigin = await request({
    method: "POST", headers: { ...proxyHeaders, Origin: `${renderOrigin}:443/` },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(defaultPortOrigin.status, 303);

  const tokenLogin = await request({
    method: "POST", headers: { ...proxyHeaders, Cookie: formCookie },
    body: new URLSearchParams({ email, password, _csrf: token }),
  });
  assert.equal(tokenLogin.status, 303);
  assert.equal(tokenLogin.headers.get("location"), "/admin");
  const sessionCookie = tokenLogin.headers.get("set-cookie").split(";")[0];
  const home = await fetch(site.base + "/admin", {
    headers: { ...proxyHeaders, Cookie: sessionCookie },
  });
  assert.equal(home.status, 200);
  const logoutToken = (await home.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  const logoutCookie = home.headers.get("set-cookie").split(";")[0];
  const logout = await fetch(site.base + "/admin/logout", {
    method: "POST", redirect: "manual",
    headers: { ...proxyHeaders, Cookie: `${sessionCookie}; ${logoutCookie}` },
    body: new URLSearchParams({ _csrf: logoutToken }),
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/admin/login");
  assert.equal((await fetch(site.base + "/admin", {
    redirect: "manual", headers: { ...proxyHeaders, Cookie: sessionCookie },
  })).status, 303);
});