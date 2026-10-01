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
    if (connectionUrl.searchParams.has("host") || connectionUrl.searchParams.has("hostaddr")) {
      throw new Error("Production database host overrides are not supported.");
    }
    const sslMode = connectionUrl.searchParams.get("sslmode");
    if (sslMode === "disable") throw new Error("Production database TLS is required.");
    const renderInternalHost = /^dpg-[a-z0-9]+-a(?:\.render\.internal)?$/.test(
      connectionUrl.hostname
    );
    if (renderInternalHost) {
      if (sslMode && sslMode !== "require" && sslMode !== "prefer") {
        throw new Error("Render internal database requires an unverified TLS connection.");
      }
      // Prisma's serverless adapter accepts only a URL. node-postgres parses
      // no-verify into ssl: { rejectUnauthorized: false } for this connection.
      connectionUrl.searchParams.set("sslmode", "no-verify");
      connectionUrl.searchParams.delete("uselibpqcompat");
    } else {
      if (sslMode === "no-verify") throw new Error("Unverified TLS is reserved for Render internal PostgreSQL.");
      if ((sslMode && !["require", "verify-full"].includes(sslMode)) ||
          (sslMode !== "verify-full" && connectionUrl.searchParams.get("uselibpqcompat") === "true")) {
        throw new Error("External production database requires verified TLS.");
      }
      connectionUrl.searchParams.set("sslmode", "verify-full");
      connectionUrl.searchParams.delete("uselibpqcompat");
    }
  }
  return connectionUrl;
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
};
