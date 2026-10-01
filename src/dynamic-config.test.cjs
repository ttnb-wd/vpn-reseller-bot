const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const YAML = require("yaml");
const { createDynamicKeys, createDynamicConfigRouter, tunnelConfig, parseStaticKey, tokenHash } = require("./dynamic-config");
const { sanitizeDiagnosticMessage } = require("./safe-diagnostics");
const key = "ss://" + Buffer.from("chacha20-ietf-poly1305:synthetic-secret").toString("base64url") + "@192.0.2.1:1234/?outline=1#Test";
function active(extra = {}) { return { id: 12345, customerId: 67890, vpnKeyId: "real-existing",
  vpnKey: key, status: "ACTIVE", expiresAt: new Date(Date.now() + 48 * 3600000),
  dataUsedGb: 1, dataLimitGb: 10, revokedAt: null, dynamicTokenHash: null, ...extra }; }
function clientFor(row) {
  let writes = 0, reads = 0;
  return { get writes() { return writes; }, get reads() { return reads; },
    public: { Subscription: { where(filter) {
      const matches = () => row && Object.entries(filter).every(([k, v]) => row[k] === v);
      return { async first() { reads++; return matches() ? { ...row } : null; },
        async updateAll(values) { writes++; if (!matches()) return []; Object.assign(row, values); return [{ ...row }]; },
      };
    } } },
  };
}
function service(client) { return createDynamicKeys({ client, baseUrl: "https://vpn.example.test", secret: "synthetic encryption secret ".repeat(3) }); }
async function serverFor(client, work, production = false) {
  const app = express(); app.set("trust proxy", "loopback");
  const logs = [];
  app.use("/vpn/config", createDynamicConfigRouter({ getClient: () => client, production,
    log: { error(...args) { logs.push(args); } } }));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`, logs); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
test("active YAML returns current official TCP/UDP transport with existing credentials only", () => {
  const config = YAML.parse(tunnelConfig(active()));
  assert.equal(config.transport.$type, "tcpudp");
  for (const channel of ["tcp", "udp"]) assert.deepEqual(config.transport[channel], {
    $type: "shadowsocks", endpoint: "192.0.2.1:1234", cipher: "chacha20-ietf-poly1305", secret: "synthetic-secret" });
  assert.equal(config.error, undefined);
  assert.doesNotMatch(tunnelConfig(active()), /12345|67890|telegram|management|fingerprint|vpnKeyId/);
});
test("expired and quota YAML contain only the exact Myanmar error object", () => {
  const expired = YAML.parse(tunnelConfig(active({ expiresAt: new Date(Date.now() - 1000), revokedAt: new Date() })));
  assert.deepEqual(expired, { error: { message: "VPN သက်တမ်းကုန်သွားပါပြီ",
    details: "ဆက်လက်အသုံးပြုချင်ရင် Metro Secure မှ package ကို သက်တမ်းတိုးပေးပါ။" } });
  const quota = YAML.parse(tunnelConfig(active({ status: "DATA_LIMIT_REACHED" })));
  assert.deepEqual(quota, { error: { message: "Package data ကုန်သွားပါပြီ",
    details: "ဆက်လက်အသုံးပြုချင်ရင် package အသစ်ဝယ်နိုင်ပါတယ်။" } });
  for (const config of [expired, quota]) { assert.equal(config.transport, undefined); assert.doesNotMatch(JSON.stringify(config), /synthetic-secret/); }
});
test("port 80, IPv6, percent credentials, prefixes and legacy keys preserve the connection", () => {
  for (const input of ["ss://chacha20-ietf-poly1305:synthetic%3Asecret@192.0.2.1:80/?prefix=POST%20",
    "ss://" + Buffer.from("aes-256-gcm:synthetic:secret@192.0.2.1:80").toString("base64url")]) {
    const parsed = parseStaticKey(input); assert.equal(parsed.endpoint, "192.0.2.1:80"); assert.equal(parsed.secret, "synthetic:secret");
  }
  assert.equal(parseStaticKey(key.replace("192.0.2.1", "[2001:db8::1]")).endpoint, "[2001:db8::1]:1234");
  const prefix = YAML.parse(tunnelConfig(active({ vpnKey: key.replace("outline=1", "prefix=POST%20") })));
  assert.equal(prefix.transport.tcp.prefix, "POST "); assert.equal(prefix.transport.udp.prefix, undefined);
});
test("YAML string quoting prevents secret or prefix injection", () => {
  const secret = "secret\nerror:\n  message: injected";
  const injected = `ss://${Buffer.from("aes-256-gcm:" + secret).toString("base64url")}@192.0.2.1:1234`;
  const config = YAML.parse(tunnelConfig(active({ vpnKey: injected })));
  assert.equal(config.error, undefined); assert.equal(config.transport.tcp.secret, secret);
});
test("opaque tokens are encrypted, hashed, created once, and stable across renewal and restart", async () => {
  const row = active(); const client = clientFor(row); const keys = service(client);
  const prepared = await keys.ensure(row); const url = keys.accessUrl(prepared);
  const parsed = new URL(url.replace(/^ssconf:/, "https:")); const token = parsed.pathname.split("/").pop();
  assert.match(parsed.pathname, /^\/vpn\/config\/[A-Za-z0-9_-]{43}$/);
  assert.equal(row.dynamicTokenHash, tokenHash(token));
  assert.equal(row.dynamicTokenEncrypted.includes(token), false);
  assert.equal(url.includes(row.customerId.toString()), false);
  assert.equal(url.includes("subscriptionId"), false);
  assert.equal(row.vpnKey, key); assert.equal(row.vpnKeyId, "real-existing");
  const writes = client.writes;
  for (let i = 0; i < 4; i++) assert.equal(keys.accessUrl(await keys.ensure(row)), url);
  row.expiresAt = new Date(Date.now() + 72 * 3600000);
  assert.equal(service(client).accessUrl(await service(client).ensure(row)), url);
  assert.equal(client.writes, writes);
});
test("concurrent token initialization reuses the winner rather than issuing two credentials", async () => {
  const row = active(); const client = clientFor(row); const keys = service(client);
  const [a, b] = await Promise.all([keys.ensure({ ...row }), keys.ensure({ ...row })]);
  assert.equal(keys.accessUrl(a), keys.accessUrl(b));
});

test("profile metadata changes only the encoded fragment, never the key, token or fetched configuration", async () => {
  const row = active(); const client = clientFor(row); const keys = service(client);
  await keys.ensure(row);
  const existingUrl = keys.accessUrl(row).split("#")[0] + "#Metro%20Secure";
  const original = { ...row }; const writes = client.writes;
  const oldConfig = tunnelConfig(row);
  for (const [customer, expected] of [
    [{ username: "ShinHtetMaung" }, "Metro Secure | ShinHtetMaung"],
    [{ username: "@ShinHtetMaung" }, "Metro Secure | ShinHtetMaung"],
    [{ firstName: "Shin Htet" }, "Metro Secure | Shin Htet"],
    [{}, "Metro Secure | Customer"],
    [{ username: "x&dns=evil#\"\nname: injected" }, 'Metro Secure | x&dns=evil#"name: injected'],
  ]) {
    const url = keys.accessUrl(await keys.ensure(row), customer);
    assert.equal(url.split("#")[0], existingUrl.split("#")[0]);
    // Mirrors Outline's official fragment parser: encoded separators cannot
    // introduce another option or alter the endpoint/token.
    const hash = new URL(url).hash.slice(1);
    assert.equal(hash.split("&").length, 1); assert.equal(hash.includes("="), false);
    assert.equal(decodeURIComponent(hash), expected);
    assert.equal(row.vpnKeyId, original.vpnKeyId); assert.equal(row.vpnKey, original.vpnKey);
    assert.equal(row.dynamicTokenHash, original.dynamicTokenHash);
    assert.equal(row.dynamicTokenEncrypted, original.dynamicTokenEncrypted);
    assert.equal(tunnelConfig(row), oldConfig);
  }
  row.expiresAt = new Date(Date.now() + 72 * 3600000);
  const renewed = await service(client).ensure(row);
  assert.equal(service(client).accessUrl(renewed, { username: "@ShinHtetMaung" }).split("#")[0], existingUrl.split("#")[0]);
  assert.equal(row.vpnKeyId, original.vpnKeyId); assert.equal(row.vpnKey, original.vpnKey);
  assert.equal(row.dynamicTokenHash, original.dynamicTokenHash);
  assert.equal(row.dynamicTokenEncrypted, original.dynamicTokenEncrypted);
  assert.equal(client.writes, writes);
});
test("different customers get independent tokens; encryption tampering fails safely", async () => {
  const a = active(), b = active({ id: 2 });
  const ka = service(clientFor(a)), kb = service(clientFor(b));
  await ka.ensure(a); await kb.ensure(b);
  assert.notEqual(a.dynamicTokenHash, b.dynamicTokenHash);
  assert.throws(() => ka.accessUrl({ ...a, dynamicTokenHash: "wrong" }), /could not be read/);
  assert.throws(() => ka.accessUrl({ ...a, dynamicTokenEncrypted: "wrong" }), /could not be read/);
});
test("HTTPS is required for dynamic delivery and mock or missing keys are never provisioned", async () => {
  assert.throws(() => createDynamicKeys({ client: {}, baseUrl: "http://example.test", secret: "x".repeat(32) }), /HTTPS/);
  assert.throws(() => createDynamicKeys({ client: {}, baseUrl: "https://example.test", secret: "short" }), /secret/);
  await assert.rejects(service(clientFor(null)).ensure(active({ vpnKeyId: "mock-old" })), /Existing Outline/);
});
test("active GET is read-only and state changes immediately become Myanmar errors", async () => {
  const row = active(); const client = clientFor(row); const keys = service(client); await keys.ensure(row);
  const token = new URL(keys.accessUrl(row).replace(/^ssconf:/, "https:")).pathname.split("/").pop();
  const writes = client.writes;
  await serverFor(client, async (base) => {
    const get = () => fetch(`${base}/vpn/config/${token}`);
    const response = await get(); assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/yaml/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.ok(YAML.parse(await response.text()).transport);
    row.status = "DATA_LIMIT_REACHED";
    const quota = YAML.parse(await (await get()).text()); assert.equal(quota.error.message, "Package data ကုန်သွားပါပြီ"); assert.equal(quota.transport, undefined);
    row.expiresAt = new Date(Date.now() - 1000);
    const expired = YAML.parse(await (await get()).text()); assert.equal(expired.error.message, "VPN သက်တမ်းကုန်သွားပါပြီ"); assert.equal(expired.transport, undefined);
  });
  assert.equal(client.writes, writes); assert.equal(row.vpnKey, key);
});
test("invalid opaque tokens return empty safe 404 and never query malformed tokens", async () => {
  const client = clientFor(null);
  await serverFor(client, async (base) => {
    for (const token of ["12345", "customer-12345", "a".repeat(42), "a".repeat(43)]) {
      const response = await fetch(`${base}/vpn/config/${token}`); assert.equal(response.status, 404); assert.equal(await response.text(), "");
    }
  });
  assert.equal(client.reads, 1);
});
test("production rejects plaintext and accepts trusted TLS proxy requests", async () => {
  await serverFor(clientFor(null), async (base) => {
    assert.equal((await fetch(`${base}/vpn/config/${"a".repeat(43)}`)).status, 400);
    assert.equal((await fetch(`${base}/vpn/config/${"a".repeat(43)}`, { headers: { "X-Forwarded-Proto": "https" } })).status, 404);
  }, true);
});
test("invalid token floods are bounded before database access", async () => {
  const client = clientFor(null);
  await serverFor(client, async (base) => {
    let response; for (let i = 0; i < 61; i++) response = await fetch(`${base}/vpn/config/nope`);
    assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "60");
  }); assert.equal(client.reads, 0);
});
test("dynamic endpoint errors never log token, static credential, Telegram ID or provider secrets", async () => {
  const secret = "a".repeat(43);
  const client = { public: { Subscription: { where() { throw new Error(`${secret} ${key} 67890 https://management/secret`); } } } };
  await serverFor(client, async (base, logs) => {
    const response = await fetch(`${base}/vpn/config/${secret}`); assert.equal(response.status, 503);
    assert.deepEqual(logs, [["Dynamic config unavailable."]]);
  });
  const sanitized = sanitizeDiagnosticMessage(`ssconf://example.test/vpn/config/${secret} /vpn/config/${secret}`);
  assert.equal(sanitized.includes(secret), false);
});
test("database migration agrees with emitted contract for new columns and safe token index", () => {
  const fs = require("node:fs"); const path = require("node:path");
  const contract = require("../prisma/contract.json");
  const table = contract.storage.namespaces.public.entries.table.subscription;
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/20261001_subscription_notifications_dynamic_keys.sql"), "utf8");
  for (const name of ["expiryWarningSentAt", "lowDataWarningSentAt", "expiredNoticeSentAt", "quotaNoticeSentAt", "migrationNoticeSentAt"]) {
    assert.equal(table.columns[name].nativeType, "timestamptz"); assert.ok(sql.includes(`"${name}" timestamptz(3)`));
  }
  assert.equal(table.columns.dataUsedBytes.nativeType, "int8");
  assert.ok(table.uniques.some((u) => u.columns.includes("dynamicTokenHash")));
  assert.match(sql, /UNIQUE \("subscriptionId", cycle, kind\)/);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|DROP|TRUNCATE)\b/m);
});
