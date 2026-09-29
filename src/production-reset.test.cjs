const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readAudit, executeReset, wipeDatabase } = require("./production-reset");

function fixture() {
  const events = [];
  const tables = {
    Customer: [{ id: 1 }],
    Order: [{ id: 1, vpnKeyId: "0", paymentProof: "private-file-id" },
      { id: 2, vpnKeyId: "mock-old", paymentProof: null }],
    Subscription: [{ id: 1, vpnKeyId: "0", status: "ACTIVE",
      expiresAt: new Date(Date.now() + 86400000), revokedAt: null }],
    SupportTicket: [{ id: 1 }], Package: [{ id: 8 }],
  };
  let snapshot;
  let failAfterTruncate = false;
  const client = { async query(sql) {
    events.push(sql);
    if (sql === "BEGIN") { snapshot = structuredClone(tables); return {}; }
    if (sql === "ROLLBACK") { Object.assign(tables, snapshot); return {}; }
    if (sql === "COMMIT") return {};
    if (sql.startsWith("TRUNCATE")) {
      for (const table of ["Customer", "Order", "Subscription", "SupportTicket"]) tables[table] = [];
      return {};
    }
    const physical = /public\."(\w+)"/.exec(sql)?.[1];
    const table = { customer: "Customer", order: "Order", subscription: "Subscription",
      supportTicket: "SupportTicket", package: "Package" }[physical];
    if (!table) throw new Error("unexpected SQL");
    if (sql.includes("count(*)")) {
      if (failAfterTruncate && tables.Customer.length === 0 && table === "Order") throw new Error("DB failure");
      return { rows: [{ count: tables[table].length }] };
    }
    return { rows: structuredClone(tables[table]) };
  } };
  const keys = [{ id: "0", name: "Test key", dataLimitBytes: 1024 },
    { id: "1", name: "Orphan", dataLimitBytes: null }];
  const outline = {
    async listResetAccessKeys() { events.push("list Outline"); return structuredClone(keys); },
    async deleteResetAccessKey(id) {
      events.push(`delete Outline ${id}`);
      const index = keys.findIndex((key) => key.id === id);
      if (index >= 0) keys.splice(index, 1);
    },
  };
  const options = { client, outline, databaseUrl: "private-url", confirm: "DELETE_ALL_TEST_DATA",
    backup: () => { events.push("backup"); return "backup.sql"; },
    inventoryWriter: () => { events.push("inventory"); return "inventory.json"; },
    log: () => {} };
  return { client, outline, options, events, tables, keys,
    setFailure: () => { failAfterTruncate = true; } };
}

test("audit and dry-run only read, report safe counts, and omit secrets", async () => {
  const f = fixture();
  const audit = await readAudit(f.client, f.outline);
  assert.equal(audit.summary.customers, 1);
  assert.equal(audit.summary.orders, 2);
  assert.equal(audit.summary.subscriptions, 1);
  assert.equal(audit.summary.supportTickets, 1);
  assert.equal(audit.summary.packages, 1);
  assert.equal(audit.summary.paymentProofReferences, 1);
  assert.equal(audit.summary.mockRecords, 1);
  assert.equal(audit.summary.orphanKeys, 1);
  assert.deepEqual(audit.summary.duplicateVpnKeyIds, [{ id: "0", count: 2 }]);
  assert.equal(f.events.some((event) => /DELETE|TRUNCATE|BEGIN/.test(event)), false);
  assert.doesNotMatch(JSON.stringify(audit), /private-file-id|private-url|ss:\/\//);
});

test("execute without exact confirmation aborts before backup or mutation", async () => {
  const f = fixture();
  await assert.rejects(executeReset({ ...f.options, confirm: "wrong" }), /confirmation/);
  assert.deepEqual(f.events, []);
});

test("Outline failure stops before any database deletion and reports completed IDs", async () => {
  const f = fixture();
  f.outline.deleteResetAccessKey = async (id) => {
    f.events.push(`delete Outline ${id}`);
    if (id === "1") throw new Error("secret Outline URL");
    f.keys.shift();
  };
  const messages = [];
  await assert.rejects(executeReset({ ...f.options, log: (line) => messages.push(line) }), /Outline deletion failed/);
  assert.equal(f.events.some((event) => event.startsWith("TRUNCATE")), false);
  assert.deepEqual(f.tables.Customer, [{ id: 1 }]);
  assert.match(messages.at(-1), /Deleted IDs: 0/);
  assert.doesNotMatch(messages.join(" "), /secret Outline URL|private-url|ss:\/\//);
});

test("all Outline keys disappear before one transactional DB cleanup; Package survives", async () => {
  const f = fixture();
  const result = await executeReset(f.options);
  const lastDelete = f.events.findLastIndex((event) => event.startsWith("delete Outline"));
  const firstTruncate = f.events.findIndex((event) => event.startsWith("TRUNCATE"));
  assert.ok(firstTruncate > lastDelete);
  assert.equal(result.summary.outlineKeys, 0);
  for (const table of ["Customer", "Order", "Subscription", "SupportTicket"]) {
    assert.equal(f.tables[table].length, 0);
  }
  assert.equal(f.tables.Package.length, 1);
  assert.equal(result.summary.mockRecords, 0);
  assert.equal(result.summary.paymentProofReferences, 0);
  assert.match(f.events[firstTruncate], /RESTART IDENTITY/);
});

test("database failure rolls the transaction back after Outline verification", async () => {
  const f = fixture();
  f.setFailure();
  await assert.rejects(executeReset(f.options), /DB failure/);
  assert.ok(f.events.includes("ROLLBACK"));
  assert.equal(f.tables.Customer.length, 1);
  assert.equal(f.tables.Order.length, 2);
  assert.equal(f.tables.Subscription.length, 1);
  assert.equal(f.tables.SupportTicket.length, 1);
  assert.equal(f.tables.Package.length, 1);
});
