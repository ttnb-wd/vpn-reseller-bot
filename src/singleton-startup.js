// A replacement stays live while the incumbent drains. Only a verified owner
// may activate services; a single chained timeout avoids overlapping attempts.
function createSingletonStartup({ coordination, activate, onError,
  schedule = setTimeout, cancel = clearTimeout, random = Math.random, log = console }) {
  let state = 'NEW', started = false, stopping = false, timer, flight;
  function cancelRetry() {
    stopping = true;
    state = 'STOPPING';
    cancel(timer);
    timer = undefined;
  }
  function ready() {
    if (!stopping && coordination.owned) {
      state = 'READY';
      log.log('Singleton services ready.', { owner: coordination.owner, state });
    }
  }
  function attempt() {
    if (stopping || state === 'READY' || state === 'ACTIVATING') return Promise.resolve();
    if (flight) return flight;
    flight = (async () => {
      const acquired = await coordination.acquire();
      if (stopping) {
        if (acquired) await coordination.release();
        return;
      }
      if (!acquired) {
        if (state !== 'STANDBY') log.log('Singleton ownership busy; entering standby.',
          { owner: coordination.owner, state: 'STANDBY' });
        state = 'STANDBY';
        timer = schedule(() => {
          timer = undefined;
          void attempt().catch(onError);
        }, 3000 + Math.floor(random() * 500));
        return;
      }
      if (!coordination.owned) throw new Error('Singleton ownership unavailable.');
      state = 'ACTIVATING';
      log.log('Singleton ownership acquired; activating bot services.',
        { owner: coordination.owner, state });
      await activate();
    })().finally(() => { flight = undefined; });
    return flight;
  }
  return {
    start() {
      if (started) return flight || Promise.resolve();
      started = true;
      return attempt();
    },
    ready, cancel: cancelRetry,
    drain: () => flight || Promise.resolve(),
    get state() { return state; },
  };
}

// API reads also rely on active, process-local services (Support SSE/session
// tokens, bot delivery, rate limits). Admin sessions are process-local too.
// Static assets and read-only private setup/config URLs remain available.
function createSingletonHttpGate(canServe) {
  return (req, res, next) => {
    const activeRoute = /^\/(?:app|mini-app)\/api(?:\/|$)/i.test(req.path) ||
      /^\/admin(?:\/|$)/i.test(req.path);
    if (activeRoute && !canServe()) {
      res.set({ 'Cache-Control': 'no-store', 'Retry-After': '3' });
      return res.status(503).json({ error: 'Service restarting. Try again in a moment.' });
    }
    next();
  };
}

module.exports = { createSingletonStartup, createSingletonHttpGate };
