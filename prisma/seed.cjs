const { Temporal } = require("@js-temporal/polyfill");
globalThis.Temporal = Temporal;

require("dotenv").config();

async function main() {
  const { default: postgres } = await import("@prisma/orm-postgres/runtime");

  const contractJson = require("./contract.json");

  const db = postgres({
    contractJson,
    url: require("../src/db").prepareDatabaseUrl(process.env.DATABASE_URL).toString(),
  });

  const runtime = await db.connect();

  try {
    const existingPackages = await db.orm.public.Package.where({}).all();
    if (existingPackages.length) {
      console.log("Package seed skipped: packages already exist.");
      return;
    }
    const packages = [
      {
        name: "Basic",
        dataLimitGb: 100,
        durationDays: 30,
        priceMmk: 5000,
        active: true,
        sortOrder: 1,
      },
      {
        name: "Standard",
        dataLimitGb: 200,
        durationDays: 30,
        priceMmk: 7500,
        active: true,
        sortOrder: 2,
      },
      {
        name: "Premium",
        dataLimitGb: 400,
        durationDays: 30,
        priceMmk: 18000,
        active: true,
        sortOrder: 3,
      },
    ];

    for (const pkg of packages) {
      await db.orm.public.Package.create(pkg);
      console.log(`Created: ${pkg.name}`);
    }

    console.log("\n✅ Package seed completed!");
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error("Seed failed:", require("../src/safe-diagnostics").describeHandlerFailure("seed", error));
  process.exit(1);
});
