const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TABLES = ["Customer", "Order", "Subscription", "SupportTicket", "Package"];
const PHYSICAL = { Customer: "customer", Order: "order", Subscription: "subscription",
  SupportTicket: "supportTicket", Package: "package" };
const CONFIRMATION = "DELETE_ALL_TEST_DATA";
const BACKUP_DIR = path.resolve(__dirname, "..", "backups");
const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

async function readAudit(client, outline) {
  const rows = {};
  for (const table of TABLES) {
    const columns = table === "Order" ? 'id, "vpnKeyId", "paymentProof"'
      : table === "Subscription" ? 'id, "vpnKeyId", status, "expiresAt", "revokedAt"'
        : "id";
    rows[table] = (await client.query(`SELECT ${columns} FROM public."${PHYSICAL[table]}" ORDER BY id`)).rows;
  }
  const dbIds = [...rows.Order, ...rows.Subscription].map((r) => r.vpnKeyId)
    .filter((id) => typeof id === "string" && id.length > 0);
  const countsById = new Map();
  for (const id of dbIds) countsById.set(id, (countsById.get(id) || 0) + 1);
  const realIds = [...countsById.keys()].filter((id) => !id.startsWith("mock-"));
  if (realIds.some((id) => !safeId(id))) throw new Error("Database contains an unsafe VPN key ID; audit stopped.");
  const keys = await outline.listResetAccessKeys();
  const keyIds = new Set(keys.map((key) => key.id));
  const inventory = keys.map((key) => ({ id: key.id, name: key.name,
    dataLimitBytes: key.dataLimitBytes, dbAssociated: countsById.has(key.id) }));
  const now = Date.now();
  const subscriptions = rows.Subscription;
  const summary = {
    customers: rows.Customer.length, orders: rows.Order.length,
    subscriptions: subscriptions.length, supportTickets: rows.SupportTicket.length,
    packages: rows.Package.length,
    paymentProofReferences: rows.Order.filter((o) => o.paymentProof != null).length,
    mockRecords: [...rows.Order, ...subscriptions]
      .filter((r) => typeof r.vpnKeyId === "string" && r.vpnKeyId.startsWith("mock-")).length,
    realVpnKeyIds: realIds,
    duplicateVpnKeyIds: [...countsById.entries()].filter(([id, count]) => count > 1 && safeId(id))
      .map(([id, count]) => ({ id, count })),
    activeSubscriptions: subscriptions.filter((s) => s.status === "ACTIVE" && !s.revokedAt &&
      s.expiresAt && new Date(s.expiresAt).getTime() > now).length,
    expiredSubscriptions: subscriptions.filter((s) => s.status === "ACTIVE" && !s.revokedAt &&
      s.expiresAt && new Date(s.expiresAt).getTime() <= now).length,
    revokedSubscriptions: subscriptions.filter((s) => Boolean(s.revokedAt)).length,
    outlineKeys: keys.length, orphanKeys: inventory.filter((k) => !k.dbAssociated).length,
    dbKeyIdsMissingInOutline: realIds.filter((id) => !keyIds.has(id)),
  };
  // The fingerprint catches changes between the first audit and the deletion window.
  const fingerprint = JSON.stringify(TABLES.filter((t) => t !== "Package")
    .map((t) => rows[t].map((r) => [r.id, r.vpnKeyId ?? null, Boolean(r.paymentProof)])));
  return { summary, inventory, fingerprint };
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
    `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}${String(d.getMilliseconds()).padStart(3, "0")}`;
}
function ensureBackupDir() { fs.mkdirSync(BACKUP_DIR, { recursive: true }); }
function writeInventory(inventory) {
  ensureBackupDir();
  const file = path.join(BACKUP_DIR, `outline-inventory-${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(inventory, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return file;
}
function pgDumpExecutable() {
  if (process.env.PG_DUMP_PATH) return process.env.PG_DUMP_PATH;
  const windows = "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe";
  return process.platform === "win32" && fs.existsSync(windows) ? windows : "pg_dump";
}
function createBackup(databaseUrl) {
  ensureBackupDir();
  const file = path.join(BACKUP_DIR, `metro-secure-pre-production-reset-${timestamp()}.sql`);
  const parsed = new URL(databaseUrl);
  const pgEnv = { ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGSSLMODE: parsed.searchParams.get("sslmode") || "require",
    PGCONNECT_TIMEOUT: "10" };
  const result = spawnSync(pgDumpExecutable(), ["--format=plain", "--no-password", "--file", file], {
    env: pgEnv, windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"], timeout: 45000,
  });
  if (result.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 100) {
    if (fs.existsSync(file)) fs.rmSync(file);
    const diagnostic = String(result.stderr || "");
    const category = /password|authentication/i.test(diagnostic) ? "authentication"
      : /timed out|timeout/i.test(diagnostic) || result.error?.code === "ETIMEDOUT" ? "timeout"
        : /SSL|certificate/i.test(diagnostic) ? "TLS"
          : /connection|network|host/i.test(diagnostic) ? "connection" : "unknown";
    const error = new Error("PostgreSQL backup failed; reset stopped.");
    error.code = `BACKUP_${category.toUpperCase()}`;
    throw error;
  }
  return file;
}

async function wipeDatabase(client) {
  await client.query("BEGIN");
  try {
    const packages = await client.query('SELECT count(*)::int AS count FROM public."package"');
    if (packages.rows[0].count < 1) throw new Error("Package table is empty; reset stopped.");
    await client.query('TRUNCATE TABLE public."supportTicket", public."subscription", public."order", public."customer" RESTART IDENTITY');
    for (const table of TABLES.filter((t) => t !== "Package")) {
      const result = await client.query(`SELECT count(*)::int AS count FROM public."${PHYSICAL[table]}"`);
      if (result.rows[0].count !== 0) throw new Error("Operational rows remain; rolling back.");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function executeReset({ client, outline, databaseUrl, confirm, backup = createBackup,
  audit = readAudit, inventoryWriter = writeInventory, log = console.log }) {
  if (confirm !== CONFIRMATION) throw new Error("Exact confirmation is required; no changes made.");
  const before = await audit(client, outline);
  if (before.summary.packages < 1) throw new Error("No Package rows; no changes made.");
  const backupFile = backup(databaseUrl);
  log(`Backup created: ${backupFile}`);
  const inventoryFile = inventoryWriter(before.inventory);
  log(`Safe Outline inventory: ${inventoryFile}`);
  const deleted = [];
  for (const key of before.inventory) {
    try {
      await outline.deleteResetAccessKey(key.id);
      deleted.push(key.id);
    } catch {
      log(`Outline deletion failed for key ID ${key.id}. Deleted IDs: ${deleted.join(", ") || "none"}. Database unchanged.`);
      throw new Error("Outline deletion failed; database cleanup was not started.");
    }
  }
  const remaining = await outline.listResetAccessKeys();
  if (remaining.length !== 0) throw new Error("Outline still has access keys; database cleanup was not started.");
  const current = await audit(client, outline);
  if (current.fingerprint !== before.fingerprint || current.summary.packages !== before.summary.packages) {
    throw new Error("Database changed during Outline cleanup; database cleanup was not started.");
  }
  await wipeDatabase(client);
  const after = await audit(client, outline);
  if (after.summary.customers || after.summary.orders || after.summary.subscriptions ||
      after.summary.supportTickets || after.summary.paymentProofReferences ||
      after.summary.mockRecords || after.summary.outlineKeys || after.summary.packages < 1) {
    throw new Error("Post-reset verification failed; inspect before launch.");
  }
  return { backupFile, inventoryFile, deleted, summary: after.summary };
}

module.exports = { CONFIRMATION, readAudit, writeInventory, createBackup, wipeDatabase, executeReset };
