const crypto = require("node:crypto");

const SESSION_MS = 60_000;
const HEARTBEAT_MS = 25_000;

function createSupportEvents(secret = crypto.randomBytes(32), { now = Date.now, heartbeatMs = HEARTBEAT_MS,
  perCustomerMax = 3, globalMax = 500, lifetimeMs = 15 * 60_000 } = {}) {
  const sessions = new Map();
  const subscribers = new Map();
  const cleanups = new Map();
  let closed = false;
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);

  function messageId(id) {
    return crypto.createHmac("sha256", key).update(`support-message:${id}`).digest("base64url");
  }
  function issue(customerId) {
    for (const [value, session] of sessions) if (session.expires <= now()) sessions.delete(value);
    if (closed || sessions.size >= globalMax * 4) return null;
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { customerId, expires: now() + SESSION_MS });
    return token;
  }
  function consume(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = sessions.get(token);
    sessions.delete(token);
    return session && session.expires > now() ? session.customerId : null;
  }
  function subscribe(customerId, res) {
    if (closed || cleanups.size >= globalMax || (subscribers.get(customerId)?.size || 0) >= perCustomerMax) {
      res.end();
      return () => {};
    }
    let set = subscribers.get(customerId);
    if (!set) { set = new Set(); subscribers.set(customerId, set); }
    let heartbeat, lifetime;
    const close = () => { cleanup(); try { res.end(); } catch { res.destroy(); } };
    const cleanup = () => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      set.delete(res);
      cleanups.delete(res);
      res.removeListener("close", cleanup);
      res.removeListener("error", close);
      if (!set.size) subscribers.delete(customerId);
    };
    heartbeat = setInterval(() => { write(res, ": heartbeat\n\n"); }, heartbeatMs);
    lifetime = setTimeout(close, lifetimeMs);
    lifetime.unref?.();
    set.add(res);
    cleanups.set(res, close);
    res.once("close", cleanup);
    res.once("error", close);
    return cleanup;
  }
  function write(res, payload) {
    try {
      // Reconnect rather than accumulating an unbounded queue for slow clients.
      if (res.destroyed || res.writableEnded || res.write(payload) === false) cleanups.get(res)?.();
    } catch { cleanups.get(res)?.(); }
  }
  function publish(customerId, message) {
    const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const res of subscribers.get(customerId) || []) {
      write(res, payload);
    }
  }
  return { messageId, issue, consume, subscribe, publish,
    closeAll() { closed = true; sessions.clear(); for (const close of [...cleanups.values()]) close(); },
    // Read-only diagnostics for connection lifecycle tests.
    subscriberCount: (customerId) => subscribers.get(customerId)?.size || 0 };
}

module.exports = { createSupportEvents };
