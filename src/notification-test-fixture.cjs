// In-memory test double only. Production uses PostgreSQL row locks and unique constraints.
const { FIELDS, eligibleKinds } = require("./subscription-notifications");
const { messagingState } = require("./dynamic-config");
function createMemoryStore(rows, attempts = [], processing = []) {
  return {
    attempts,
    async list(after) { return rows.filter((row) => row.id > after).sort((a, b) => a.id - b.id).slice(0, 100); },
    async claim(id, kind) {
      const row = rows.find((s) => s.id === id);
      if (!row || row[FIELDS[kind]] || !row.expiresAt || processing.some((o) => o.customerId === row.customerId && o.status === "PROCESSING")) return null;
      if (kind === "migrationNotice" ? messagingState(row) !== "ACTIVE" : !eligibleKinds(row).includes(kind)) return null;
      const cycle = kind === "migrationNotice" ? "delivery:v1" : new Date(row.expiresAt.toString()).toISOString();
      const existing = attempts.find((a) => a.subscription.id === id && a.kind === kind && a.cycle === cycle);
      if (existing && existing.status !== "FAILED") return null;
      const claim = { id: String(attempts.length + 1), subscription: { ...row }, kind, cycle,
        telegramId: "synthetic-chat", status: "DISPATCHING" };
      if (existing) attempts.splice(attempts.indexOf(existing), 1);
      attempts.push(claim);
      return claim;
    },
    async sent(claim, messageId) {
      claim.status = "SENT";
      claim.messageId = messageId;
      const row = rows.find((s) => s.id === claim.subscription.id);
      if (kindMatchesCycle(row, claim)) row[FIELDS[claim.kind]] = new Date();
    },
    async failed(claim) { claim.status = "FAILED"; },
    async close() {},
  };
}
function kindMatchesCycle(row, claim) {
  return row && (claim.kind === "migrationNotice" || new Date(row.expiresAt.toString()).toISOString() === claim.cycle);
}
module.exports = { createMemoryStore };
