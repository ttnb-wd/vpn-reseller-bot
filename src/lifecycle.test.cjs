const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle } = require('./lifecycle');
test('shutdown rejects new work, drains active handlers, closes resources once in order', async () => {
  const events = []; let release;
  const lifecycle = createLifecycle({ timeoutMs: 1000, exit() { events.push('exit'); } });
  const work = lifecycle.track(() => new Promise(resolve => { release = resolve; }));
  await new Promise(setImmediate);
  const steps = [() => events.push('polling'), () => events.push('timers'), () => events.push('sse'),
    () => lifecycle.drain(), () => events.push('workers'), () => events.push('lease'),
    () => events.push('http'), () => events.push('db')];
  const shutdown = lifecycle.stop(steps);
  assert.equal(lifecycle.stopping, true);
  await assert.rejects(lifecycle.track(() => {}), /shutting down/);
  assert.equal(lifecycle.stop(steps), shutdown);
  await new Promise(setImmediate); assert.deepEqual(events, ['polling', 'timers', 'sse']);
  release(); await work; await shutdown;
  assert.deepEqual(events, ['polling', 'timers', 'sse', 'workers', 'lease', 'http', 'db', 'exit']);
});
test('hung work cannot prevent lease release and database cleanup within the deadline', async () => {
  const events = [];
  const lifecycle = createLifecycle({ timeoutMs: 100, exit() { events.push('exit'); } });
  lifecycle.track(() => new Promise(() => {}));
  const started = Date.now();
  await lifecycle.stop([() => lifecycle.drain(), () => new Promise(() => {}),
    () => events.push('lease'), () => events.push('db')]);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(events, ['lease', 'db', 'exit']);
});
