function createLifecycle({ timeoutMs = 30000, exit = () => {} } = {}) {
  let stopping = false, shutdown;
  const active = new Set();
  function track(work) {
    if (stopping) return Promise.reject(new Error('Service is shutting down.'));
    const promise = Promise.resolve().then(work);
    active.add(promise);
    promise.finally(() => active.delete(promise)).catch(() => {});
    return promise;
  }
  function stop(steps, code = 0) {
    if (shutdown) return shutdown;
    stopping = true;
    shutdown = (async () => {
      let deadline;
      const expired = new Promise((resolve) => { deadline = setTimeout(resolve, timeoutMs); });
      const run = async () => {
        for (const step of steps) {
          let stepTimer;
          // Reserve time for later cleanup even when one handler never settles.
          const budget = typeof step === 'function' ? Math.floor(timeoutMs / (steps.length + 1)) : step.timeoutMs;
          const limit = new Promise(resolve => { stepTimer = setTimeout(resolve, Math.max(1, budget)); });
          const runStep = typeof step === 'function' ? step : step.run;
          try { await Promise.race([Promise.resolve().then(runStep), limit]); }
          catch { /* Keep draining other resources. */ }
          finally { clearTimeout(stepTimer); }
        }
      };
      await Promise.race([run(), expired]);
      clearTimeout(deadline);
      exit(code);
    })();
    return shutdown;
  }
  return { track, stop, get stopping() { return stopping; },
    drain: () => Promise.allSettled([...active]) };
}
module.exports = { createLifecycle };
