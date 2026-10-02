function createAdminSalesEvents({ heartbeatMs = 25_000, lifetimeMs = 30 * 60_000, maxClients = 50 } = {}) {
  const clients = new Map();
  function subscribe(sessionId, res, sessionLifetimeMs = lifetimeMs) {
    if (clients.size >= maxClients) return false;
    const close = () => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      clients.delete(res);
      res.removeListener("close", close);
      res.removeListener("error", close);
      if (!res.writableEnded) res.end();
    };
    const write = (chunk) => {
      try { if (res.destroyed || res.writableEnded || !res.write(chunk)) close(); }
      catch { close(); }
    };
    const heartbeat = setInterval(() => write(": heartbeat\n\n"), heartbeatMs);
    const lifetime = setTimeout(close, Math.max(1, Math.min(lifetimeMs, sessionLifetimeMs)));
    heartbeat.unref?.();
    lifetime.unref?.();
    clients.set(res, { sessionId, close, write });
    res.once("close", close);
    res.once("error", close);
    write(": connected\n\n");
    return true;
  }
  function publishSale() {
    for (const client of clients.values()) client.write("event: sales-change\ndata: {}\n\n");
  }
  function closeSession(sessionId) {
    for (const client of [...clients.values()]) if (client.sessionId === sessionId) client.close();
  }
  function closeAll() { for (const client of [...clients.values()]) client.close(); }
  return { subscribe, publishSale, closeSession, closeAll, subscriberCount: () => clients.size };
}

function publishSaleAfterPaidUpdate(changed, values, events) {
  if (changed.length && values.status === "PAID") events.publishSale();
}

module.exports = { createAdminSalesEvents, publishSaleAfterPaidUpdate };
