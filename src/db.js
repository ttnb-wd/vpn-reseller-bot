require("@js-temporal/polyfill");

if (process.env.NODE_ENV !== "production") require("dotenv").config({ quiet: true });

const { Temporal } = require("@js-temporal/polyfill");

globalThis.Temporal = Temporal;

const fs = require("fs");
const path = require("path");

let sharedClient;

function prepareDatabaseUrl(databaseUrl, nodeEnv = process.env.NODE_ENV) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  let connectionUrl;
  try { connectionUrl = new URL(databaseUrl); } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(connectionUrl.protocol) ||
      !connectionUrl.hostname || !connectionUrl.pathname || connectionUrl.pathname === "/") {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (nodeEnv === "production") {
    if (["host", "hostaddr", "port", "sslcert", "sslkey", "sslrootcert"].some(name => connectionUrl.searchParams.has(name))) {
      throw new Error("Production database host overrides are not supported.");
    }
    const sslMode = connectionUrl.searchParams.get("sslmode");
    if (sslMode === "disable" || ["0", "false"].includes(connectionUrl.searchParams.get("ssl"))) {
      throw new Error("Production database TLS is required.");
    }
    if ((sslMode && !["require", "verify-full"].includes(sslMode)) ||
        (sslMode !== "verify-full" && connectionUrl.searchParams.get("uselibpqcompat") === "true")) {
      throw new Error("Production database requires verified TLS.");
    }
    connectionUrl.searchParams.set("sslmode", "verify-full");
    connectionUrl.searchParams.delete("ssl");
    connectionUrl.searchParams.delete("uselibpqcompat");
  }
  return connectionUrl;
}

async function inspectDatabaseSecurity(connectionUrl) {
  const { Client } = require("pg");
  const connection = new Client({ connectionString: connectionUrl.toString(),
    connectionTimeoutMillis: 10000, statement_timeout: 5000 });
  try {
    await connection.connect();
    // Only security flags: no role name, hostname, credentials or customer rows.
    const { rows } = await connection.query(`SELECT r.rolsuper AS superuser,
      r.rolbypassrls AS "bypassRls", r.rolcreatedb AS "createDatabase",
      r.rolcreaterole AS "createRole", s.ssl AS tls
      FROM pg_roles r LEFT JOIN pg_stat_ssl s ON s.pid = pg_backend_pid()
      WHERE r.rolname = current_user`);
    return rows[0];
  } finally { await connection.end(); }
}

function assertDatabaseSecurity(flags) {
  if (!flags || flags.superuser || flags.bypassRls || flags.tls !== true)
    throw new Error("Database requires a non-superuser application role without BYPASSRLS and verified TLS.");
}

function describeDatabaseRuntime(connectionUrl, contractPath, contractJson, ormVersion) {
  return {
    host: connectionUrl.hostname,
    port: connectionUrl.port || "5432",
    database: decodeURIComponent(connectionUrl.pathname.slice(1)),
    sslMode: connectionUrl.searchParams.get("sslmode") || "unset",
    contractArtifact: path.relative(process.cwd(), contractPath),
    contractStorageHash: contractJson.storage?.storageHash || "missing",
    ormPostgresVersion: ormVersion,
  };
}

async function createDatabase() {
  const connectionUrl = prepareDatabaseUrl(process.env.DATABASE_URL);
  if (process.env.NODE_ENV === "production") assertDatabaseSecurity(await inspectDatabaseSecurity(connectionUrl));
  const { default: postgresServerless } = await import(
    "@prisma/orm-postgres/serverless"
  );

  const { orm } = await import("@prisma/orm-postgres/orm-client");

  const contractPath = path.join(
    process.cwd(),
    "prisma",
    "contract.json"
  );

  const contractJson = JSON.parse(
    fs.readFileSync(contractPath, "utf8")
  );
  const ormEntry = require.resolve("@prisma/orm-postgres/serverless");
  const ormPackage = JSON.parse(fs.readFileSync(
    path.join(path.dirname(ormEntry), "..", "package.json"), "utf8"
  ));
  console.info("Database runtime identity:", describeDatabaseRuntime(
    connectionUrl, contractPath, contractJson, ormPackage.version
  ));

  const database = postgresServerless({
    contractJson,
  });

  const runtime = await database.connect({
    url: connectionUrl.toString(),
  });

  const client = orm({
    runtime,
    context: database.context,
  });

  sharedClient = client;

  return {
    client,
    runtime,
    context: database.context,
  };
}

function getDatabaseClient() {
  if (!sharedClient) throw new Error("Database is not connected.");
  return sharedClient;
}

module.exports = {
  createDatabase,
  getDatabaseClient,
  prepareDatabaseUrl,
  describeDatabaseRuntime,
  inspectDatabaseSecurity,
  assertDatabaseSecurity,
};
