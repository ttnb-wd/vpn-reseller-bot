const inheritedDatabaseUrl = process.env.DATABASE_URL;
require("dotenv").config({ quiet: true });

const { Client } = require("pg");
const { Telegraf } = require("telegraf");
const outline = require("../src/outline");
const { validateAdminConfig } = require("../src/admin-auth");
const { databaseConnection, safeConnectionFailure } = require("../src/reset-db-connection");
const { CONFIRMATION, readAudit, writeInventory, createBackup, executeReset } =
  require("../src/production-reset");
let stage = "configuration";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--audit", "--backup", "--dry-run", "--execute", "--health"].includes(arg)) ||
      args.length > 1) throw new Error("Use one mode: --audit, --backup, --dry-run, --health, or --execute.");
  const mode = args[0] || "--dry-run";
  if (mode === "--execute" && process.env.CONFIRM_PRODUCTION_RESET !== CONFIRMATION) {
    throw new Error("Exact CONFIRM_PRODUCTION_RESET value required; no changes made.");
  }
  if (mode === "--execute" && !inheritedDatabaseUrl) {
    throw new Error("Execution requires DATABASE_URL in the process environment; local .env is insufficient.");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
  outline.validateOutlineConfig();
  const databaseUrl = inheritedDatabaseUrl || process.env.DATABASE_URL;
  const { config, diagnostics } = databaseConnection(databaseUrl,
    inheritedDatabaseUrl ? "process environment" : "local .env");
  console.log(JSON.stringify({ databaseConnection: diagnostics }));
  const client = new Client(config);
  try {
    stage = "PostgreSQL connection";
    await client.connect();
    stage = "production audit";
    if (mode === "--health") {
      const checks = await Promise.allSettled([
        client.query("SELECT 1"),
        outline.testOutlineConnection(),
        process.env.BOT_TOKEN ? new Telegraf(process.env.BOT_TOKEN).telegram.getMe()
          : Promise.reject(new Error("BOT_TOKEN missing")),
        (async () => {
          const url = new URL(process.env.PUBLIC_BASE_URL);
          if (url.protocol !== "https:") throw new Error("Public URL must use HTTPS");
          return fetch(url, { signal: AbortSignal.timeout(10000), redirect: "manual" });
        })(),
        Promise.resolve().then(() => validateAdminConfig()),
      ]);
      const ok = (index) => checks[index].status === "fulfilled";
      console.log(JSON.stringify({ database: ok(0) ? "connected" : "unavailable",
        outline: ok(1) ? "connected" : "unavailable",
        telegram: ok(2) ? "getMe succeeded" : "unavailable",
        publicBaseUrl: ok(3) ? `HTTP ${checks[3].value.status}` : "unavailable",
        adminAuthentication: ok(4) ? "configuration valid" : "configuration invalid",
        usageWorker: "not observable from this CLI",
        telegramPolling: "not observable from getMe" }, null, 2));
      return;
    }
    if (mode === "--execute") {
      const result = await executeReset({ client, outline, databaseUrl,
        confirm: process.env.CONFIRM_PRODUCTION_RESET });
      console.log(JSON.stringify({ result: "verified", ...result }, null, 2));
      return;
    }
    const audit = await readAudit(client, outline);
    console.log(JSON.stringify({ audit: audit.summary, outlineInventory: audit.inventory }, null, 2));
    if (mode === "--backup") {
      stage = "PostgreSQL backup";
      const file = createBackup(databaseUrl);
      console.log(`Backup created: ${file}`);
    }
    if (mode === "--dry-run") {
      const file = writeInventory(audit.inventory);
      console.log(`Safe Outline inventory: ${file}`);
      console.log("DRY RUN: zero Outline keys and zero database rows were deleted.");
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? ` (${error.code})` : "";
  const reason = stage === "PostgreSQL connection" ? `: ${safeConnectionFailure(error)}` : "";
  console.error(`Production reset failed during ${stage}${code}${reason}. No further cleanup was attempted.`);
  process.exitCode = 1;
});
