const { createDatabase } = require("./db");

const ORDER_NUMBER =
  "VPN-340e1031-79f4-4bdc-86cd-69063e735782";

async function verifyOrder() {
  const database = await createDatabase();

  console.log("Database connected.");

  const order = await database.client.public.Order
    .where({
      orderNumber: ORDER_NUMBER,
    })
    .first();

  if (!order) {
    console.log("Order not found.");
    await database.runtime.close();
    return;
  }

  console.log("\nOrder found:");
  console.log("----------------------------");
  console.log("ID:", order.id);
  console.log("Order Number:", order.orderNumber);
  console.log("Plan:", order.plan);
  console.log("Price:", order.price);
  console.log("Status:", order.status);
  console.log("Customer ID:", order.customerId);
  console.log("Created At:", order.createdAt);
  console.log("----------------------------");

  await database.runtime.close();
}

verifyOrder().catch((error) => {
  console.error("Verification failed:");
  console.error(error);
  process.exit(1);
});