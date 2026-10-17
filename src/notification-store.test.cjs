const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNotificationStore } = require("./notification-store");
function fixture(options = {}) {
  const statements = [], events = [];
  const subscription = { id: 1, customerId: 2, telegramId: "synthetic-chat", status: "ACTIVE",
    expiresAt: new Date(Date.now() + 3600000), dataLimitGb: 10, dataUsedBytes: "0" };
  subscription.expiryCycle = subscription.expiresAt.toISOString();
  const connection = {
    async query(sql, values) {
      statements.push({ sql, values }); events.push(sql);
      if (options.fail && sql.startsWith(options.fail)) throw new Error("private DB secret");
      if (sql.startsWith("SELECT s.*")) return { rows: [subscription], rowCount: 1 };
      if (sql.startsWith("SELECT 1")) return { rows: [], rowCount: options.processing ? 1 : 0 };
      if (sql.startsWith("INSERT INTO")) return { rows: options.existing ? [] : [{ id: values[0] }], rowCount: options.existing ? 0 : 1 };
      if (sql.includes('RETURNING "sentAt"')) return { rows: [{ sentAt: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }, release() { events.push("release"); },
  };
  const pool = { on() {}, async connect() { events.push("connect"); return connection; },
    query: connection.query, async end() { events.push("end"); } };
  return { store: createNotificationStore({ pool }), statements, events, subscription };
}
test("PostgreSQL claim locks the subscription, inserts a unique durable attempt and commits before returning", async () => {
  const f = fixture(); const claim = await f.store.claim(1, "expiryWarning");
  assert.ok(claim); assert.equal(claim.telegramId, "synthetic-chat");
  assert.match(f.statements[1].sql, /public\."subscription".*\n.*public\."customer"/);
  assert.match(f.statements[1].sql, /FOR UPDATE OF s/);
  const insertion = f.statements.find((s) => s.sql.startsWith("INSERT INTO"));
  assert.match(insertion.sql, /ON CONFLICT \("subscriptionId", cycle, kind\)/);
  assert.match(insertion.sql, /status = 'FAILED'.*"nextAttemptAt" <= now\(\)/);
  assert.deepEqual(f.events.slice(-2), ["COMMIT", "release"]);
  assert.equal(claim.cycle, f.subscription.expiresAt.toISOString());
});
test("duplicate or uncertain attempts and in-progress payment approvals are never claimed", async () => {
  for (const options of [{ existing: true }, { processing: true }]) {
    const f = fixture(options); assert.equal(await f.store.claim(1, "expiryWarning"), null);
    assert.deepEqual(f.events.slice(-2), ["COMMIT", "release"]);
  }
});
test("successful receipt persists the ledger and sent timestamp atomically with a paid-cycle guard", async () => {
  const f = fixture(); const claim = await f.store.claim(1, "expiryWarning");
  f.statements.length = 0; await f.store.sent(claim, 99);
  assert.equal(f.statements[0].sql, "BEGIN");
  assert.match(f.statements[1].sql, /FOR UPDATE/);
  assert.match(f.statements[2].sql, /status = 'SENT'/);
  assert.match(f.statements[3].sql, /"expiryWarningSentAt" = \$2.*\n.*"expiresAt" = \$3::timestamptz/);
  assert.equal(f.statements[3].values[2], claim.cycle);
  assert.equal(f.statements.at(-1).sql, "COMMIT");
});
test("database failure rolls back and releases the connection without leaking errors", async () => {
  const f = fixture({ fail: "INSERT INTO" }); await assert.rejects(f.store.claim(1, "expiryWarning"));
  assert.deepEqual(f.events.slice(-2), ["ROLLBACK", "release"]);
});
test("definite failures schedule retry without setting a sent timestamp; SQL identifiers cannot be injected", async () => {
  const f = fixture(); await f.store.failed({ id: "test" }, 90);
  assert.match(f.statements[0].sql, /status = 'FAILED'/); assert.doesNotMatch(f.statements[0].sql, /SET.*sentAt/);
  assert.equal(f.statements[0].values[1], 90);
  await assert.rejects(f.store.claim(1, '"; DROP TABLE'), /Unknown/);
  await assert.rejects(f.store.sent({ kind: '"; DROP TABLE' }, 1), /Unknown/);
  await f.store.close(); assert.equal(f.events.at(-1), "end");
});
