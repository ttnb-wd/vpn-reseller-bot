const { createDatabase } = require("./db");

const ORDER_NUMBER =
  "VPN-340e1031-79f4-4bdc-86cd-69063e735782";

async function verifyPaymentFields() {
  const database = await createDatabase();

  try {
    const order = await database.client.public.Order
      .where({
        orderNumber: ORDER_NUMBER,
      })
      .first();

    if (!order) {
      console.log("Order not found.");
      return;
    }

    console.log("Order found!");
    console.log("Order Number:", order.orderNumber);
    console.log("Plan:", order.plan);
    console.log("Status:", order.status);

    console.log("\nPayment Fields:");
    console.log("Payment Method:", order.paymentMethod);
    console.log("Payment Reference:", order.paymentReference);
    console.log("Payment Proof:", order.paymentProof);
    console.log("Paid At:", order.paidAt);
  } finally {
    await database.runtime.close();
  }
}

verifyPaymentFields().catch((error) => {
  console.error("Verification failed:", error);
  process.exitCode = 1;
});