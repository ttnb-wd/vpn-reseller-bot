const crypto = require("node:crypto");

const SESSION_MS = 60_000;
const HEARTBEAT_MS = 25_000;

function createSupportEvents(secret = crypto.randomBytes(32), { now = Date.now, heartbeatMs = HEARTBEAT_MS } = {}) {
  const sessions = new Map();
  const subscribers = new Map();
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);

  function messageId(id) {
    return crypto.createHmac("sha256", key).update(`support-message:${id}`).digest("base64url");
  }
  function issue(customerId) {
    for (const [value, session] of sessions) if (session.expires <= now()) sessions.delete(value);
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
    let set = subscribers.get(customerId);
    if (!set) { set = new Set(); subscribers.set(customerId, set); }
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { cleanup(); }
    }, heartbeatMs);
    const cleanup = () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (!set.size) subscribers.delete(customerId);
    };
    set.add(res);
    res.once("close", cleanup);
    res.once("error", cleanup);
    return cleanup;
  }
  function publish(customerId, message) {
    const payload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const res of subscribers.get(customerId) || []) {
      try { res.write(payload); } catch { res.destroy(); }
    }
  }
  return { messageId, issue, consume, subscribe, publish,
    // Read-only diagnostics for connection lifecycle tests.
    subscriberCount: (customerId) => subscribers.get(customerId)?.size || 0 };
}

module.exports = { createSupportEvents };
