const assert = require("node:assert/strict");
const { test } = require("node:test");
const bcrypt = require("bcryptjs");
const express = require("express");
const { validateAdminConfig, createAdminRouter } = require("./admin-auth");

const email = "admin@example.test";
const password = "synthetic-test-password";
const passwordHash = bcrypt.hashSync(password, 10);
const sessionSecret = "synthetic-session-secret-for-route-tests-only";

function config(production = false) {
  return validateAdminConfig({
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD_HASH: passwordHash,
    ADMIN_SESSION_SECRET: sessionSecret,
    NODE_ENV: production ? "production" : "test",
  });
}

async function startServer(production = false) {
  const app = express();
  app.set("trust proxy", "loopback");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  app.use("/admin", createAdminRouter({
    ...config(production), expectedOrigin: base.replace("http:", "https:"),
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
  assert.match(setCookie, /SameSite=Strict/i);
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
