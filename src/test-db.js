const { createDatabase } = require("./db");

async function main() {
  const { client, runtime } = await createDatabase();

  try {
    const Customer = client.public.Customer;
    const Order = client.public.Order;

    console.log("Finding test customer...");

    const customer = await Customer
      .where({
        telegramId: "test-telegram-001",
      })
      .first();

    if (!customer) {
      throw new Error("Test customer not found.");
    }

    console.log("Customer found:");
    console.log(customer);

    console.log("\nCreating test order...");

    const order = await Order.create({
      orderNumber: "TEST-ORDER-001",
      plan: "7 Days",
      price: 3,
      status: "PENDING_PAYMENT",
      customerId: customer.id,
    });

    console.log("\n✅ Order created:");
    console.log(order);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error("Database test failed:");
  console.error(error);
  process.exitCode = 1;
});