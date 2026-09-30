const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Temporal } = require("@js-temporal/polyfill");
const { createExpiryWorker, EXPIRY_INTERVAL_MS } = require("./expiry-worker");

const clock = Temporal.Instant.from("2026-09-30T00:00:00Z");
const expired = clock.subtract({ seconds: 1 });
const future = clock.add({ seconds: 1 });

function fixture(rows, deleteKey, orders = [], blockKey = async () => {}, restoreKey = async () => {}) {
  const logs = [];
  const table = {
    where(first) {
      const filters = [];
      const add = (filter) => {
        if (typeof filter !== "function") {
          filters.push((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
          return;
        }
        const fields = new Proxy({}, { get: (_, key) => ({
          lte: (value) => (row) => Temporal.Instant.compare(row[key], value) <= 0,
          isNull: () => (row) => row[key] == null,
          isNotNull: () => (row) => row[key] != null,
        }) });
        filters.push(filter(fields));
      };
      add(first);
      const selected = () => rows.filter((row) => filters.every((check) => check(row)));
      return { where(filter) { add(filter); return this; },
        async all() { return selected().map((row) => ({ ...row })); },
        async first() { return { ...selected()[0] } || null; },
        async updateAll(data) { return selected().map((row) => Object.assign(row, data)); } };
    },
  };
  const worker = createExpiryWorker({ client: { public: { Subscription: table,
    Order: { where(filter) { return { async first() {
      return orders.find((order) => order.customerId === filter.customerId &&
        order.status === filter.status) || null;
    } }; } } } },
    deleteAccessKey: deleteKey, blockAccessKey: blockKey,
    restoreAccessKey: restoreKey,
    isAccessKeyNotFoundError: (error) => error?.response?.status === 404 &&
      error?.response?.data?.code === "NotFound",
    now: () => clock, log: { error(...args) { logs.push(args); } },
    schedule() { return 1; }, cancel() {} });
  return { worker, rows, logs };
}

test("expiry worker revokes only overdue owned keys and is idempotent", async () => {
  const rows = [
    { id: 1, vpnKeyId: "expired-1", expiresAt: expired, revokedAt: null },
    { id: 2, vpnKeyId: "future-2", expiresAt: future, revokedAt: null },
    { id: 3, vpnKeyId: "revoked-3", expiresAt: expired, revokedAt: clock },
  ];
  const deleted = [];
  const { worker } = fixture(rows, async (id) => deleted.push(id));
  assert.equal(EXPIRY_INTERVAL_MS, 120000);
  worker.start();
  await worker.run();
  await worker.run();
  await worker.stop();
  assert.deepEqual(deleted, ["expired-1"]);
  assert.equal(rows[0].revokedAt.toString(), clock.toString());
  assert.equal(rows[1].revokedAt, null);
});

test("confirmed 404 succeeds, transient errors retry, and one failure does not stop batch", async () => {
  const rows = [
    { id: 1, vpnKeyId: "transient", expiresAt: expired, revokedAt: null },
    { id: 2, vpnKeyId: "missing", expiresAt: expired, revokedAt: null },
  ];
  const calls = [];
  let fail = true;
  const { worker, logs } = fixture(rows, async (id) => {
    calls.push(id);
    if (id === "transient" && fail) throw Object.assign(new Error("private URL"),
      { response: { status: 503 } });
    if (id === "missing") throw Object.assign(new Error("gone"),
      { response: { status: 404, data: { code: "NotFound" } } });
  });
  await worker.run();
  assert.equal(rows[0].revokedAt, null);
  assert.ok(rows[1].revokedAt);
  assert.equal(JSON.stringify(logs).includes("private URL"), false);
  fail = false;
  // A new process sees the persisted overdue row and retries it.
  const restarted = fixture(rows, async (id) => calls.push(id)).worker;
  await restarted.run();
  assert.ok(rows[0].revokedAt);
  assert.deepEqual(calls, ["transient", "missing", "transient"]);
});

test("ambiguous ownership never deletes a key", async () => {
  const rows = [
    { id: 1, vpnKeyId: "shared", expiresAt: expired, revokedAt: null },
    { id: 2, vpnKeyId: "shared", expiresAt: future, revokedAt: null },
  ];
  const deleted = [];
  const { worker } = fixture(rows, async (id) => deleted.push(id));
  await worker.run();
  assert.deepEqual(deleted, []);
});

test("an in-flight renewal is not revoked and overlapping runs share one scan", async () => {
  const rows = [
    { id: 1, customerId: 11, vpnKeyId: "renewing", expiresAt: expired, revokedAt: null },
    { id: 2, customerId: 12, vpnKeyId: "other", expiresAt: expired, revokedAt: null },
  ];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const blocked = [];
  const { worker } = fixture(rows, async (id) => { calls.push(id); await gate; },
    [{ customerId: 11, status: "PROCESSING" }], async (id) => blocked.push(id));
  const first = worker.run();
  const second = worker.run();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["other"]);
  assert.deepEqual(blocked, ["renewing"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["other"]);
  assert.equal(rows[0].revokedAt, null);
  assert.ok(rows[1].revokedAt);
});

test("a renewal completed during expiry blocking has its allowance restored", async () => {
  const rows = [{ id: 1, customerId: 11, vpnKeyId: "renewing",
    status: "ACTIVE", dataLimitGb: 325, expiresAt: expired, revokedAt: null }];
  const calls = [];
  const { worker } = fixture(rows, async () => { throw new Error("must not delete"); },
    [{ customerId: 11, status: "PROCESSING" }],
    async (id) => { calls.push(["block", id]); rows[0].expiresAt = future; },
    async (id, limit) => { calls.push(["restore", id, limit]); });
  await worker.run();
  assert.deepEqual(calls, [["block", "renewing"], ["restore", "renewing", 325]]);
  assert.equal(rows[0].revokedAt, null);
});
