const { test } = require("node:test");
const assert = require("node:assert/strict");
const { GB, MESSAGES, FIELDS, eligibleKinds, remainingBytes, createSubscriptionNotifications,
  renewalNotificationReset } = require("./subscription-notifications");
const { createMemoryStore } = require("./notification-test-fixture.cjs");
function active(extra = {}) {
  return { id: 1, customerId: 2, status: "ACTIVE", expiresAt: new Date(Date.now() + 48 * 3600000),
    dataLimitGb: 10, dataUsedGb: 1, dataUsedBytes: GB, revokedAt: null,
    migrationNoticeSentAt: new Date(), ...extra };
}
function fixture(rows, send = async () => ({ message_id: 7 }), attempts = []) {
  const store = createMemoryStore(rows, attempts);
  const messages = [], logs = [];
  const worker = createSubscriptionNotifications({ store,
    async sendMessage(...args) { messages.push(args); return send(...args); },
    async prepareMigration() { return { accessUrl: "ssconf://synthetic.example/config", extra: {} }; },
    log: { error(...args) { logs.push(args); } },
  });
  return { store, worker, messages, logs };
}
test("expiry beyond 24 hours produces no warning", async () => {
  const f = fixture([active()]); await f.worker.run(); assert.equal(f.messages.length, 0);
});
test("expiry exactly 24 hours and inside the window warns once across reruns and restarts", async () => {
  for (const hours of [24, 1]) {
    const row = active({ expiresAt: new Date(Date.now() + hours * 3600000) });
    const f = fixture([row]); await Promise.all([f.worker.run(), f.worker.run()]); await f.worker.run();
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0][1], MESSAGES.expiryWarning);
    assert.ok(row.expiryWarningSentAt);
    const restart = fixture([row], undefined, f.store.attempts); await restart.worker.run();
    assert.equal(restart.messages.length, 0);
  }
});
test("expiry at zero and past expiry sends an expired notice, never a warning", async () => {
  for (const expiresAt of [new Date(), new Date(Date.now() - 1000)]) {
    const row = active({ expiresAt }); const f = fixture([row]);
    await f.worker.run(); await f.worker.run();
    assert.deepEqual(f.messages.map((m) => m[1]), [MESSAGES.expiredNotice]); assert.ok(row.expiredNoticeSentAt);
  }
});
test("expired notice remains visible after persisted expiry enforcement revokes the key", async () => {
  const f = fixture([active({ expiresAt: new Date(Date.now() - 1000), revokedAt: new Date() })]);
  await f.worker.run(); assert.equal(f.messages[0][1], MESSAGES.expiredNotice);
});
test("remaining data greater than 1 GB including 1.4 GB and one byte over does not warn", async () => {
  for (const remaining of [GB + 1n, GB * 14n / 10n, GB * 2n]) {
    const row = active({ dataUsedBytes: GB * 10n - remaining });
    assert.equal(remainingBytes(row), remaining);
    const f = fixture([row]); await f.worker.run(); assert.equal(f.messages.length, 0);
  }
});
test("exactly 1 GB, 0.99 GB, and one byte remaining warn once without display rounding", async () => {
  for (const remaining of [GB, GB * 99n / 100n, 1n]) {
    const row = active({ dataUsedBytes: GB * 10n - remaining });
    const f = fixture([row]); await f.worker.run(); await f.worker.run();
    assert.deepEqual(f.messages.map((m) => m[1]), [MESSAGES.lowDataWarning]);
    assert.ok(row.lowDataWarningSentAt);
  }
});
test("missing or invalid raw bytes never infer a low-data warning from rounded GB", () => {
  assert.equal(remainingBytes(active({ dataUsedBytes: null, dataUsedGb: 9.01 })), null);
  assert.equal(remainingBytes(active({ dataUsedBytes: "bad" })), null);
  assert.equal(remainingBytes(active({ dataLimitGb: Number.MAX_SAFE_INTEGER })), null);
});
test("zero data sends one quota notice and never a low-data warning", async () => {
  const row = active({ status: "DATA_LIMIT_REACHED", dataUsedGb: 10, dataUsedBytes: GB * 10n });
  const f = fixture([row]); await f.worker.run(); await f.worker.run();
  assert.deepEqual(f.messages.map((m) => m[1]), [MESSAGES.quotaNotice]); assert.ok(row.quotaNoticeSentAt);
});
test("quota latch remains notified once even after Outline rolling bytes decrease", async () => {
  const row = active({ status: "DATA_LIMIT_REACHED" }); const f = fixture([row]);
  await f.worker.run(); row.dataUsedBytes = 0n; await f.worker.run(); assert.equal(f.messages.length, 1);
});

test("quota exhaustion does not suppress an independently due 24-hour expiry warning", async () => {
  const row = active({ status: "DATA_LIMIT_REACHED", expiresAt: new Date(Date.now() + 3600000) });
  const f = fixture([row]); await f.worker.run(); await f.worker.run();
  assert.deepEqual(f.messages.map((m) => m[1]), [MESSAGES.expiryWarning, MESSAGES.quotaNotice]);
  assert.ok(row.expiryWarningSentAt); assert.ok(row.quotaNoticeSentAt);
});
test("confirmed Telegram rejection writes no sentAt, and a successful retry writes it", async () => {
  const row = active({ expiresAt: new Date(Date.now() + 3600000) }); let fail = true;
  const f = fixture([row], async () => {
    if (fail) throw { response: { ok: false, error_code: 429, parameters: { retry_after: 90 } } };
    return { message_id: 8 };
  });
  await f.worker.run(); assert.equal(row.expiryWarningSentAt, undefined);
  assert.equal(f.store.attempts[0].status, "FAILED");
  fail = false; await f.worker.run(); assert.ok(row.expiryWarningSentAt);
  assert.equal(f.store.attempts[0].status, "SENT");
});
test("ambiguous network failure is held durably across a restart and never auto-retried", async () => {
  const row = active({ expiresAt: new Date(Date.now() + 3600000) });
  const f = fixture([row], async () => { throw new Error("ssconf://secret VPN credential bot-token"); });
  await f.worker.run(); assert.equal(row.expiryWarningSentAt, undefined);
  const restarted = fixture([row], undefined, f.store.attempts); await restarted.worker.run();
  assert.equal(restarted.messages.length, 0); assert.equal(f.store.attempts[0].status, "DISPATCHING");
  assert.doesNotMatch(JSON.stringify(f.logs), /ssconf|credential|bot-token/);
});
test("success followed by database failure is never sent twice", async () => {
  const row = active({ expiresAt: new Date(Date.now() + 3600000) }); const f = fixture([row]);
  f.store.sent = async () => { throw new Error("private database credential"); };
  await f.worker.run(); await f.worker.run();
  assert.equal(f.messages.length, 1); assert.equal(row.expiryWarningSentAt, undefined);
  assert.equal(f.store.attempts[0].status, "DISPATCHING");
});
test("independent worker instances use one durable claim and isolate customer failure", async () => {
  const rows = [active({ expiresAt: new Date(Date.now() + 3600000) }),
    active({ id: 2, expiresAt: new Date(Date.now() + 3600000) })];
  const attempts = []; const f = fixture(rows, async () => { throw new Error(); }, attempts);
  const g = fixture(rows, undefined, attempts);
  await Promise.all([f.worker.run(), g.worker.run()]);
  assert.equal(f.messages.length + g.messages.length, 2);
  assert.equal(attempts.length, 2);
});
test("renewal resets only entitlement notices, while approval replay and migration flag are preserved", async () => {
  const row = active({ expiresAt: new Date(Date.now() + 3600000) }); const f = fixture([row]);
  await f.worker.run(); const oldFlag = row.expiryWarningSentAt;
  Object.assign(row, renewalNotificationReset(true)); assert.equal(row.expiryWarningSentAt, oldFlag);
  const migration = row.migrationNoticeSentAt;
  Object.assign(row, renewalNotificationReset(false)); row.expiresAt = new Date(Date.now() + 7200000);
  assert.equal(row.migrationNoticeSentAt, migration);
  for (const key of ["expiryWarningSentAt", "lowDataWarningSentAt", "expiredNoticeSentAt", "quotaNoticeSentAt"]) assert.equal(row[key], null);
  await f.worker.run(); assert.equal(f.messages.length, 2);
});
test("delayed Telegram confirmation never sets a renewed entitlement's timestamp", async () => {
  const row = active({ expiresAt: new Date(Date.now() + 3600000) });
  const f = fixture([row], async () => { row.expiresAt = new Date(Date.now() + 48 * 3600000); return { message_id: 9 }; });
  await f.worker.run(); assert.equal(row.expiryWarningSentAt, undefined);
  assert.equal(f.store.attempts[0].status, "SENT");
});
test("migration delivery is one-time across renewals and preparation failures safely retry", async () => {
  const row = active({ migrationNoticeSentAt: null }); const f = fixture([row]);
  await f.worker.run(); await f.worker.run();
  assert.equal(f.messages.length, 1); assert.ok(row.migrationNoticeSentAt);
  Object.assign(row, renewalNotificationReset(false)); row.expiresAt = new Date(Date.now() + 72 * 3600000);
  await f.worker.run(); assert.equal(f.messages.length, 1);
});
test("preparing a key before Telegram fails leaves a retryable attempt", async () => {
  const row = active({ migrationNoticeSentAt: null }); const store = createMemoryStore([row]); let fail = true;
  let sends = 0;
  const worker = createSubscriptionNotifications({ store, log: { error() {} },
    async sendMessage() { sends++; return { message_id: 1 }; },
    async prepareMigration() { if (fail) throw new Error(); return { accessUrl: "ssconf://test", extra: {} }; } });
  await worker.run(); assert.equal(sends, 0); assert.equal(store.attempts[0].status, "FAILED");
  fail = false; await worker.run(); assert.equal(sends, 1); assert.ok(row.migrationNoticeSentAt);
});
test("all new notification bodies and reasons are Myanmar; disabled subscriptions are skipped", () => {
  for (const text of Object.values(MESSAGES)) assert.match(text, /[\u1000-\u109f]/);
  assert.deepEqual(eligibleKinds(active({ status: "REVOKED" })), []);
  assert.equal(Object.keys(FIELDS).length, 5);
});
