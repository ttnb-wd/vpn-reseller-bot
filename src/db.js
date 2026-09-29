require("@js-temporal/polyfill");

require("dotenv").config();

const { Temporal } = require("@js-temporal/polyfill");

globalThis.Temporal = Temporal;

const fs = require("fs");
const path = require("path");

let sharedClient;

async function createDatabase() {
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

  const database = postgresServerless({
    contractJson,
  });

  const runtime = await database.connect({
    url: process.env.DATABASE_URL,
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
