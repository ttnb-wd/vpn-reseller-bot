const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSingletonStartup } = require('./singleton-startup');

function timers() {
  const queued = new Map();
  let next = 0;
  return { queued,
    schedule(fn, ms) { assert.ok(ms >= 3000 && ms < 3500); queued.set(++next, fn); return next; },
    cancel(id) { queued.delete(id); },
    async tick() {
      const [id, fn] = queued.entries().next().value;
      queued.delete(id); fn(); await new Promise(setImmediate);
    },
  };
}
const log = { log() {} };

test('standby schedules one bounded retry, serializes acquisition and activates exactly once', async () => {
  const clock = timers();
  let calls = 0, concurrent = 0, max = 0, finish, starts = 0;
  const coordination = { owned: false,
    async acquire() {
      calls++; max = Math.max(max, ++concurrent);
      const result = await new Promise(resolve => { finish = resolve; });
      concurrent--; this.owned = result; return result;
    }, async release() { this.owned = false; },
  };
  const startup = createSingletonStartup({ coordination, ...clock, log, random: () => 0,
    onError: error => { throw error; }, activate() { starts++; startup.ready(); } });
  const initial = startup.start();
  const repeated = startup.start();
  assert.equal(calls, 1);
  finish(false); await Promise.all([initial, repeated]);
  assert.equal(startup.state, 'STANDBY');
  assert.equal(clock.queued.size, 1); assert.equal(starts, 0);
  await clock.tick();
  assert.equal(calls, 2); assert.equal(clock.queued.size, 0);
  const pending = startup.start(); // Does not start a second acquisition while pending.
  finish(true); await startup.drain(); await pending;
  assert.equal(startup.state, 'READY'); assert.equal(starts, 1); assert.equal(max, 1);
  await startup.start(); assert.equal(calls, 2); assert.equal(starts, 1);
  startup.cancel(); await startup.drain(); assert.equal(clock.queued.size, 0);
});

test('standby shutdown cancels retries and late successful acquisition never activates', async () => {
  const clock = timers();
  let acquired = 0, starts = 0, finish, releases = 0;
  const coordination = { owned: false, async acquire() {
    if (++acquired === 1) return false;
    const result = await new Promise(resolve => { finish = resolve; });
    this.owned = result; return result;
  }, async release() { releases++; this.owned = false; } };
  const startup = createSingletonStartup({ coordination, ...clock, log,
    activate() { starts++; }, onError: assert.fail });
  await startup.start(); await clock.tick();
  startup.cancel(); assert.equal(clock.queued.size, 0);
  finish(true); await startup.drain();
  assert.equal(starts, 0); assert.equal(releases, 1); assert.equal(coordination.owned, false);
  assert.equal(startup.state, 'STOPPING');
});

test('activation failures and retry acquisition failures are reported once without retry loops', async () => {
  for (const stage of ['acquire', 'activate']) {
    const clock = timers(); let calls = 0, errors = 0;
    const coordination = { owned: false, async acquire() {
      if (++calls === 1) return false;
      if (stage === 'acquire') throw new Error('synthetic-private-detail');
      this.owned = true; return true;
    } };
    const startup = createSingletonStartup({ coordination, ...clock, log,
      activate() { throw new Error('synthetic-private-detail'); }, onError() { errors++; startup.cancel(); } });
    await startup.start(); await clock.tick();
    assert.equal(errors, 1); assert.equal(clock.queued.size, 0);
  }
});
