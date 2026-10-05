// Read-only diagnostic: credentials, file IDs and Telegram paths never reach output.
require("dotenv").config({ quiet: true });
const { Client } = require("pg");
const { loadTelegramPaymentProof } = require("../src/admin-proof");

async function main() {
  const client = new Client({ connectionString: require("../src/db").prepareDatabaseUrl(process.env.DATABASE_URL).toString(),
    connectionTimeoutMillis: 15000, statement_timeout: 15000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const summary = await client.query(`SELECT status, COUNT(*)::int AS orders,
      COUNT(*) FILTER (WHERE "paymentProof" IS NOT NULL)::int AS "withProof"
      FROM "order" GROUP BY status ORDER BY status`);
    console.log("Payment proof counts:", JSON.stringify(summary.rows));
    const recent = await client.query(`SELECT o."orderNumber", o.status, o."paymentMethod",
      (o."paymentProof" IS NOT NULL) AS "hasProof", o."paidAt", o."createdAt",
      (c.id IS NOT NULL) AS "customerPresent"
      FROM "order" o JOIN "customer" c ON c.id = o."customerId"
      WHERE o."paymentMethod" IS NOT NULL OR o."paymentProof" IS NOT NULL
      ORDER BY o."createdAt" DESC LIMIT 15`);
    console.log("Recent payments:", JSON.stringify(recent.rows));
    const samples = await client.query(`SELECT id, "paymentProof" FROM "order"
      WHERE "paymentProof" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 3`);
    await client.query("ROLLBACK");
    for (const sample of samples.rows) {
      try {
        const proof = await loadTelegramPaymentProof(sample.paymentProof, {
          fetchImpl: async (url, options) => {
            const response = await fetch(url, options);
            if (!url.endsWith("/getFile") &&
                response.headers.get("content-type") === "application/octet-stream") {
              console.log("Proof fetch:", JSON.stringify({ orderId: sample.id,
                code: "TELEGRAM_BINARY_IMAGE_TRANSPORT" }));
            }
            return response;
          },
          onDiagnostic: (event) => console.log("Proof fetch:", JSON.stringify({ orderId: sample.id, ...event })),
        });
        console.log("Proof result:", JSON.stringify({ orderId: sample.id,
          available: Boolean(proof), contentType: proof?.contentType }));
      } catch (error) {
        console.log("Proof result:", JSON.stringify({ orderId: sample.id,
          errorCode: error.proofCode || "PROOF_FETCH_FAILED" }));
      }
    }
  } finally { await client.end(); }
}
main().catch((error) => {
  const code = /^[A-Z0-9_]{2,40}$/.test(error.code || "") ? error.code : "UNAVAILABLE";
  console.error("Read-only payment diagnostic failed:", code);
  process.exitCode = 1;
});
