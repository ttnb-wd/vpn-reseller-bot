const { Temporal } = require("@js-temporal/polyfill");
globalThis.Temporal = Temporal;

require("dotenv").config();

async function main() {
  const { default: postgres } = await import("@prisma/orm-postgres/runtime");

  const contractJson = require("./contract.json");

  const db = postgres({
    contractJson,
    url: process.env.DATABASE_URL,
  });

  const runtime = await db.connect();

  try {
    const packages = [
      {
        name: "Basic",
        dataLimitGb: 100,
        durationDays: 31,
        priceMmk: 5000,
        active: true,
        sortOrder: 1,
      },
      {
        name: "Standard",
        dataLimitGb: 200,
        durationDays: 31,
        priceMmk: 7500,
        active: true,
        sortOrder: 2,
      },
      {
        name: "Premium",
        dataLimitGb: 400,
        durationDays: 31,
        priceMmk: 18000,
        active: true,
        sortOrder: 3,
      },
    ];

    for (const pkg of packages) {
      const existing = await db.orm.public.Package
        .where({ name: pkg.name })
        .first();

      if (existing) {
        await db.orm.public.Package
          .where({ id: existing.id })
          .update(pkg);

        console.log(`Updated: ${pkg.name}`);
      } else {
        await db.orm.public.Package.create(pkg);

        console.log(`Created: ${pkg.name}`);
      }
    }

    console.log("\n✅ Package seed completed!");
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error("❌ Seed failed:", error);
  process.exit(1);
});
