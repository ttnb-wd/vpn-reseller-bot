require("@js-temporal/polyfill");

if (process.env.NODE_ENV !== "production") require("dotenv").config({ quiet: true });

const { Temporal } = require("@js-temporal/polyfill");

globalThis.Temporal = Temporal;

const fs = require("fs");
const path = require("path");

let sharedClient;

async function createDatabase() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  let connectionUrl;
  try { connectionUrl = new URL(process.env.DATABASE_URL); } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(connectionUrl.protocol) ||
      !connectionUrl.hostname || !connectionUrl.pathname || connectionUrl.pathname === "/") {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (process.env.NODE_ENV === "production") {
    const sslMode = connectionUrl.searchParams.get("sslmode");
    if (sslMode === "disable") throw new Error("Production database TLS is required.");
    if (!sslMode) connectionUrl.searchParams.set("sslmode", "require");
  }
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
  console.info("Database runtime identity:", {
    host: connectionUrl.hostname,
    port: connectionUrl.port || "5432",
    database: decodeURIComponent(connectionUrl.pathname.slice(1)),
    sslMode: connectionUrl.searchParams.get("sslmode") || "unset",
    contractArtifact: path.relative(process.cwd(), contractPath),
    contractStorageHash: contractJson.storage?.storageHash || "missing",
    ormPostgresVersion: ormPackage.version,
  });

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
};
