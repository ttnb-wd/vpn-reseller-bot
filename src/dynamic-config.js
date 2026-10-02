const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const express = require("express");
const { effectiveSubscriptionState } = require("./subscription-state");
const { createWindowLimiter } = require("./abuse-limits");
const { outlineProfileName } = require("./outline-profile-name");

const ERRORS = {
  EXPIRED: { message: "VPN သက်တမ်းကုန်သွားပါပြီ", details: "ဆက်လက်အသုံးပြုချင်ရင် Metro Secure မှ package ကို သက်တမ်းတိုးပေးပါ။" },
  DATA_LIMIT_REACHED: { message: "Package data ကုန်သွားပါပြီ", details: "ဆက်လက်အသုံးပြုချင်ရင် package အသစ်ဝယ်နိုင်ပါတယ်။" },
  REVOKED: { message: "VPN ကို လောလောဆယ် သုံးလို့မရပါဘူး။", details: "အကူအညီလိုရင် Metro Secure မှာ ဆက်သွယ်ပေးပါ။" },
};

function timeMs(value) {
  return value?.epochMilliseconds == null ? new Date(value).getTime() : Number(value.epochMilliseconds);
}

function messagingState(subscription, now = Date.now()) {
  // The expiry worker's persisted revocation must not hide the expiry reason.
  if (subscription && ["ACTIVE", "DATA_LIMIT_REACHED", "EXPIRED"].includes(subscription.status) &&
      subscription.expiresAt && timeMs(subscription.expiresAt) <= timeMs(now)) return "EXPIRED";
  return effectiveSubscriptionState(subscription, now);
}

function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

function createDynamicKeys({ client, baseUrl, secret }) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Dynamic config requires a public HTTPS base URL.");
  }
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Dynamic token encryption secret is required.");
  const key = crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.from("metro-secure"), Buffer.from("dynamic-token:v1"), 32);
  const aad = Buffer.from("metro-dynamic:v1");
  function encrypt(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }
  function accessUrl(subscription, customer = subscription.outlineProfileCustomer) {
    try {
      const bytes = Buffer.from(subscription.dynamicTokenEncrypted, "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(12, 28));
      const token = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || tokenHash(token) !== subscription.dynamicTokenHash) throw new Error();
      // Outline names profiles from the access-key fragment at import time.
      // This metadata is never part of the fetched configuration URL.
      const name = encodeURIComponent(outlineProfileName(customer));
      return `${origin.href.replace(/\/+$/, "").replace(/^https:/, "ssconf:")}/vpn/config/${token}#${name}`;
    } catch { throw new Error("Dynamic credential could not be read."); }
  }
  async function ensure(subscription) {
    if (subscription.dynamicTokenHash) { accessUrl(subscription); return subscription; }
    if (!subscription.vpnKeyId || subscription.vpnKeyId.startsWith("mock-") ||
        !subscription.vpnKey?.startsWith("ss://")) throw new Error("Existing Outline credential required.");
    const token = crypto.randomBytes(32).toString("base64url");
    const values = { dynamicTokenHash: tokenHash(token), dynamicTokenEncrypted: encrypt(token) };
    const changed = await client.public.Subscription.where({ id: subscription.id, dynamicTokenHash: null }).updateAll(values);
    const current = changed[0] || await client.public.Subscription.where({ id: subscription.id }).first();
    if (!current?.dynamicTokenHash) throw new Error("Dynamic credential persistence failed.");
    accessUrl(current);
    return current;
  }
  return { ensure, accessUrl };
}

function parseStaticKey(value) {
  // SIP002 userinfo (base64url or percent-encoded), plus legacy whole-URI base64.
  if (typeof value !== "string" || !value.startsWith("ss://")) throw new Error("Invalid stored Outline config.");
  let body = value.slice(5).split("#")[0];
  if (!body.includes("@")) body = Buffer.from(body.split("?")[0], "base64url").toString("utf8");
  const at = body.lastIndexOf("@");
  if (at < 1) throw new Error("Invalid stored Outline config.");
  let auth = body.slice(0, at);
  if (!auth.includes(":")) auth = Buffer.from(auth, "base64url").toString("utf8");
  else auth = decodeURIComponent(auth);
  const colon = auth.indexOf(":");
  const url = new URL(`ss://${body.slice(at + 1)}`);
  const cipher = auth.slice(0, colon);
  const secret = auth.slice(colon + 1);
  if (colon <= 0 || !secret || !["chacha20-ietf-poly1305", "aes-128-gcm", "aes-192-gcm", "aes-256-gcm"].includes(cipher) ||
      !url.hostname || !url.port || url.username || url.password || url.searchParams.has("plugin")) {
    throw new Error("Invalid stored Outline config.");
  }
  return { endpoint: `${url.hostname}:${url.port}`, cipher, secret, prefix: url.searchParams.get("prefix") };
}

function tunnelConfig(subscription, now = Date.now()) {
  const state = messagingState(subscription, now);
  const quote = JSON.stringify; // JSON string scalars are valid YAML; no interpolation/injection.
  if (state !== "ACTIVE") {
    const error = ERRORS[state] || ERRORS.REVOKED;
    return `error:\n  message: ${quote(error.message)}\n  details: ${quote(error.details)}\n`;
  }
  const config = parseStaticKey(subscription.vpnKey);
  const channel = (name) => `  ${name}:\n    $type: shadowsocks\n    endpoint: ${quote(config.endpoint)}\n    cipher: ${quote(config.cipher)}\n    secret: ${quote(config.secret)}\n` +
    (name === "tcp" && config.prefix != null ? `    prefix: ${quote(config.prefix)}\n` : "");
  return `transport:\n  $type: tcpudp\n${channel("tcp")}${channel("udp")}`;
}

function createDynamicConfigRouter({ getClient, production = process.env.NODE_ENV === "production",
  getLifecycleState = () => "UNKNOWN", lookupTimeoutMs = 2500, log = console }) {
  const router = express.Router();
  const allow = createWindowLimiter({ windowMs: 60000, max: 60 });
  const globalAllow = createWindowLimiter({ windowMs: 60000, max: 3000, maxEntries: 1 });
  let previousRequestAt;
  router.get("/:token", async (req, res) => {
    const receivedAt = new Date().toISOString();
    const receivedTime = performance.now();
    const idleMs = previousRequestAt == null ? null : Math.round(receivedTime - previousRequestAt);
    previousRequestAt = receivedTime;
    const safeState = () => {
      const value = getLifecycleState();
      return ["ACTIVE", "STANDBY", "STOPPING"].includes(value) ? value : "UNKNOWN";
    };
    const timing = { receivedAt, stateAtReceive: safeState(),
      processUptimeMs: typeof process.uptime === "function" ? Math.round(process.uptime() * 1000) : null,
      idleSincePreviousConfigRequestMs: idleMs, dbLookupStartedAt: null,
      dbLookupEndedAt: null, dbLookupMs: null, dbWaitMs: null, outcome: "rejected" };
    let logged = false;
    const record = (closed = false) => {
      if (logged) return;
      logged = true;
      log.info?.("Dynamic config request timing.", { ...timing,
        stateAtFinish: safeState(), status: closed ? null : res.statusCode,
        totalMs: Math.round(performance.now() - receivedTime),
        outcome: closed ? "client_closed" : timing.outcome });
    };
    res.once("finish", () => record());
    res.once("close", () => record(true));
    res.set({ "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow, noarchive" });
    if (!globalAllow("all") || !allow(req.ip || req.socket.remoteAddress)) {
      res.set("Retry-After", "60");
      return res.status(429).end();
    }
    if (production && !req.secure) return res.status(400).end();
    if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) return res.status(404).end();
    const lookupStarted = performance.now();
    timing.dbLookupStartedAt = new Date().toISOString();
    let timer;
    const timeoutError = new Error("lookup timeout");
    try {
      const subscription = await Promise.race([
        Promise.resolve().then(() => getClient().public.Subscription
          .where({ dynamicTokenHash: tokenHash(req.params.token) }).first()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), lookupTimeoutMs); }),
      ]);
      timing.dbLookupEndedAt = new Date().toISOString();
      timing.dbLookupMs = timing.dbWaitMs = Math.round(performance.now() - lookupStarted);
      timing.outcome = subscription ? "success" : "not_found";
      if (!subscription) return res.status(404).end();
      return res.type("application/yaml").send(tunnelConfig(subscription));
    } catch (error) {
      timing.dbWaitMs = Math.round(performance.now() - lookupStarted);
      if (error !== timeoutError) {
        timing.dbLookupEndedAt = new Date().toISOString();
        timing.dbLookupMs = timing.dbWaitMs;
      }
      timing.outcome = error === timeoutError ? "timeout" : "error";
      log.error("Dynamic config unavailable.", { outcome: timing.outcome,
        dbWaitMs: timing.dbWaitMs, state: safeState() });
      if (error === timeoutError) res.set("Retry-After", "3");
      return res.status(503).end();
    } finally {
      clearTimeout(timer);
    }
  });
  return router;
}

module.exports = { createDynamicKeys, createDynamicConfigRouter, tunnelConfig, parseStaticKey, tokenHash, messagingState, timeMs };
