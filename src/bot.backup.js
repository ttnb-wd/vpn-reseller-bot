require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { Telegraf, Markup } = require("telegraf");
const { Temporal } = require("@js-temporal/polyfill");

const { createDatabase } = require("./db");
const { PAYMENT_METHODS } = require("./payment-config");
const { createAccessKey, deleteAccessKey } = require("./outline");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("VPN Bot is running!"));
const server = app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID);

let db;
const pendingProofs = new Map();
const PROCESSING_TIMEOUT_MINUTES = 15;
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

function isAdmin(ctx) { return String(ctx.from?.id) === ADMIN_TELEGRAM_ID; }
function getPlanDays(plan) { return { "7 Days": 7, "30 Days": 30, "90 Days": 90 }[plan] || 0; }
function formatInstant(instant) { return instant ? instant.toString() : "N/A"; }

async function recoverStuckProcessingOrders() {
  if (!db) return;
  try {
    const now = Temporal.Now.instant();
    const processingOrders = await db.public.Order.where({ status: "PROCESSING" }).all();
    if (!processingOrders.length) return;

    for (const order of processingOrders) {
      if (!order.processingAt) {
        console.log(`Processing order ${order.orderNumber} has no processingAt timestamp. Skipping recovery.`);
        continue;
      }
      const ageMinutes = Number(now.epochSeconds - order.processingAt.epochSeconds) / 60;
      if (ageMinutes < PROCESSING_TIMEOUT_MINUTES) continue;

      const recoveredOrders = await db.public.Order.where({ id: order.id, status: "PROCESSING" }).updateAll({ status: "PENDING_PAYMENT", processingAt: null });
      if (recoveredOrders.length > 0) {
        console.log(`Recovered stuck order ${order.orderNumber}. It was PROCESSING for ${Math.floor(ageMinutes)} minutes.`);
      }
    }
  } catch (error) { console.error("PROCESSING recovery error:", error); }
}

function startProcessingRecovery() {
  setInterval(() => recoverStuckProcessingOrders(), RECOVERY_INTERVAL_MS);
  console.log(`PROCESSING recovery enabled. Timeout: ${PROCESSING_TIMEOUT_MINUTES} minutes.`);
}

async function startBot() {
  console.log("Starting VPN Bot...");
  const database = await createDatabase();
  db = database.client;
  console.log("PostgreSQL connected.");

  await recoverStuckProcessingOrders();
  startProcessingRecovery();

  bot.start(async (ctx) => {
    await ctx.reply("🔐 Welcome to VPN Reseller Bot\n\nChoose an option below.", Markup.inlineKeyboard([
      [Markup.button.callback("🛒 Buy VPN", "buy_vpn")],
      [Markup.button.callback("📱 My VPN", "my_vpn")],
      [Markup.button.callback("📦 My Orders", "my_orders")]
    ]));
  });

  bot.command("myid", async (ctx) => ctx.reply(`Your Telegram ID:\n${ctx.from.id}`));

  bot.action("my_vpn", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.where({ telegramId: String(ctx.from.id) }).first();
      if (!customer) return await ctx.reply("❌ Customer account not found.");

      const subscription = await db.public.Subscription.where({ customerId: customer.id }).first();
      if (!subscription) {
        return await ctx.reply("🔐 You don't have a VPN subscription yet.", Markup.inlineKeyboard([[Markup.button.callback("🛒 Buy VPN", "buy_vpn")]]));
      }

      const now = Temporal.Now.instant();
      let remainingDays = 0;
      if (subscription.expiresAt) {
        remainingDays = Math.max(0, Math.ceil(Number(subscription.expiresAt.epochSeconds - now.epochSeconds) / 86400));
      }

      const isActive = subscription.status === "ACTIVE" && remainingDays > 0;
      const status = isActive ? "🟢 ACTIVE" : "🔴 EXPIRED";

      await ctx.reply(
        `🔐 My VPN\n\nStatus: ${status}\n\n📦 Plan: ${subscription.plan}\n⏳ Remaining: ${remainingDays} Days\n\n📅 Expires:\n${formatInstant(subscription.expiresAt)}\n\n📊 Data Usage:\n${subscription.dataUsedGb || 0} GB / ${subscription.dataLimitGb || 0} GB`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📱 Add to Device", "add_device")],
          [Markup.button.callback("🔗 Connection Link", "connection_link")],
          [Markup.button.callback("🔄 Renew", "renew_vpn")],
          [Markup.button.callback("🔄 Refresh", "my_vpn")]
        ])
      );
    } catch (error) {
      console.error("My VPN error:", error);
      await ctx.reply("❌ Failed to load VPN information.");
    }
  });

  bot.action("connection_link", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.where({ telegramId: String(ctx.from.id) }).first();
      if (!customer) return await ctx.reply("❌ Customer account not found.");

      const subscription = await db.public.Subscription.where({ customerId: customer.id }).first();
      if (!subscription) return await ctx.reply("❌ You don't have a VPN subscription yet.");
      if (!subscription.vpnKey) return await ctx.reply("❌ VPN connection key is not available yet.");

      const now = Temporal.Now.instant();
      if (subscription.status !== "ACTIVE" || !subscription.expiresAt || subscription.expiresAt.epochSeconds <= now.epochSeconds) {
        return await ctx.reply("🔴 Your VPN subscription has expired.");
      }

      await ctx.reply(
        `🔗 VPN Connection Link\n\n${subscription.vpnKey}\n\n📅 Expires:\n${formatInstant(subscription.expiresAt)}\n\n⚠️ Keep this connection link private.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📱 Add to Device", "add_device")],
          [Markup.button.callback("⬅️ Back to My VPN", "my_vpn")]
        ])
      );
    } catch (error) {
      console.error("Connection link error:", error);
      await ctx.reply("❌ Failed to load VPN connection link.");
    }
  });

  bot.action("renew_vpn", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("🔄 Choose your renewal plan:", Markup.inlineKeyboard([
      [Markup.button.callback("7 Days - $3", "renew_plan_7")],
      [Markup.button.callback("30 Days - $8", "renew_plan_30")],
      [Markup.button.callback("90 Days - $20", "renew_plan_90")],
      [Markup.button.callback("⬅️ Back", "my_vpn")]
    ]));
  });

  bot.action("renew_plan_7", async (ctx) => createRenewalOrder(ctx, "7 Days", 3));
  bot.action("renew_plan_30", async (ctx) => createRenewalOrder(ctx, "30 Days", 8));
  bot.action("renew_plan_90", async (ctx) => createRenewalOrder(ctx, "90 Days", 20));

  async function createRenewalOrder(ctx, plan, price) {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.where({ telegramId: String(ctx.from.id) }).first();
      if (!customer) return await ctx.reply("❌ Customer account not found.");

      const subscription = await db.public.Subscription.where({ customerId: customer.id }).first();
      if (!subscription) return await ctx.reply("❌ You don't have a VPN subscription yet.\n\nPlease use Buy VPN first.");

      const order = await db.public.Order.create({
        orderNumber: `VPN-${crypto.randomUUID()}`, plan, price, status: "PENDING_PAYMENT", customerId: customer.id
      });

      await ctx.reply(
        `🔄 Renewal Order Created\n\nOrder: ${order.orderNumber}\nPlan: ${order.plan}\nPrice: $${order.price}\n\nChoose payment method:`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🏦 Bank Transfer", `payment_bank_${order.id}`)],
          [Markup.button.callback("📱 Mobile Wallet", `payment_wallet_${order.id}`)],
          [Markup.button.callback("❌ Cancel Order", `cancel_order_${order.id}`)]
        ])
      );
    } catch (error) {
      console.error("Create renewal order error:", error);
      await ctx.reply("❌ Failed to create renewal order.");
    }
  }

  bot.action("buy_vpn", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("📦 Choose your VPN plan:", Markup.inlineKeyboard([
      [Markup.button.callback("7 Days - $3", "plan_7")],
      [Markup.button.callback("30 Days - $8", "plan_30")],
      [Markup.button.callback("90 Days - $20", "plan_90")]
    ]));
  });

  bot.action("plan_7", async (ctx) => createOrder(ctx, "7 Days", 3));
  bot.action("plan_30", async (ctx) => createOrder(ctx, "30 Days", 8));
  bot.action("plan_90", async (ctx) => createOrder(ctx, "90 Days", 20));

  async function createOrder(ctx, plan, price) {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.upsert({
        conflictOn: { telegramId: true },
        create: { telegramId: String(ctx.from.id), username: ctx.from.username || null, firstName: ctx.from.first_name || null },
        update: { username: ctx.from.username || null, firstName: ctx.from.first_name || null }
      });

      const order = await db.public.Order.create({
        orderNumber: `VPN-${crypto.randomUUID()}`, plan, price, status: "PENDING_PAYMENT", customerId: customer.id
      });

      await ctx.reply(
        `🧾 Order Created\n\nOrder: ${order.orderNumber}\nPlan: ${order.plan}\nPrice: $${order.price}\n\nChoose payment method:`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🏦 Bank Transfer", `payment_bank_${order.id}`)],
          [Markup.button.callback("📱 Mobile Wallet", `payment_wallet_${order.id}`)],
          [Markup.button.callback("❌ Cancel Order", `cancel_order_${order.id}`)]
        ])
      );
    } catch (error) {
      console.error("Create order error:", error);
      await ctx.reply("❌ Failed to create order.");
    }
  }

  bot.action(/^payment_bank_(\d+)$/, async (ctx) => handlePaymentMethod(ctx, "bank_transfer", Number(ctx.match[1])));
  bot.action(/^payment_wallet_(\d+)$/, async (ctx) => handlePaymentMethod(ctx, "mobile_wallet", Number(ctx.match[1])));

  async function handlePaymentMethod(ctx, method, orderId) {
    await ctx.answerCbQuery();
    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) return await ctx.reply("❌ Order not found.");

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      if (!customer || customer.telegramId !== String(ctx.from.id)) return await ctx.reply("❌ You are not authorized to access this order.");
      if (order.status !== "PENDING_PAYMENT") return await ctx.reply(`⚠️ This order cannot accept payment.\n\nStatus: ${order.status}`);

      const payment = PAYMENT_METHODS[method];
      if (!payment) return await ctx.reply("❌ Payment method unavailable.");

      await db.public.Order.where({ id: orderId }).update({ paymentMethod: method });

      await ctx.reply(
        `💳 ${payment.name}\n\nAccount Name: ${payment.accountName}\nAccount Number: ${payment.accountNumber}\n\nAmount: $${order.price}\n\nAfter payment, send your payment screenshot here.`
      );
      pendingProofs.set(String(ctx.from.id), orderId);
      await ctx.reply("📸 Please send your payment screenshot.");
    } catch (error) {
      console.error("Payment method error:", error);
      await ctx.reply("❌ Something went wrong.");
    }
  }

  bot.on("photo", async (ctx) => {
    const userId = String(ctx.from.id);
    const orderId = pendingProofs.get(userId);
    if (!orderId) return;

    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) {
        pendingProofs.delete(userId);
        return await ctx.reply("❌ Order not found.");
      }
      if (order.status !== "PENDING_PAYMENT") {
        pendingProofs.delete(userId);
        return await ctx.reply("⚠️ This order is no longer waiting for payment.");
      }

      const photos = ctx.message.photo;
      const paymentProof = photos[photos.length - 1].file_id;

      await db.public.Order.where({ id: orderId }).update({ paymentProof });
      pendingProofs.delete(userId);

      await ctx.reply("✅ Payment Screenshot Received\n\n⏳ Admin will verify your payment.");

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      const adminCaption = `💰 PAYMENT VERIFICATION\n\nOrder: ${order.orderNumber}\nPlan: ${order.plan}\nPrice: $${order.price}\n\nCustomer: ${customer?.firstName || "N/A"}\nUsername: @${customer?.username || "N/A"}\nTelegram ID: ${customer?.telegramId}`;

      await bot.telegram.sendPhoto(ADMIN_TELEGRAM_ID, paymentProof, {
        caption: adminCaption,
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Approve", `approve_payment_${order.id}`), Markup.button.callback("❌ Reject", `reject_payment_${order.id}`)]
        ])
      });
    } catch (error) {
      console.error("Payment proof error:", error);
      await ctx.reply("❌ Failed to submit payment proof.");
    }
  });

  bot.action(/^approve_payment_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return await ctx.answerCbQuery("Unauthorized");
    await ctx.answerCbQuery("Processing...");

    const orderId = Number(ctx.match[1]);
    try {
      const existingOrder = await db.public.Order.where({ id: orderId }).first();
      if (!existingOrder) return await ctx.reply("❌ Order not found.");

      const processingAt = Temporal.Now.instant();
      const claimedOrders = await db.public.Order.where({ id: orderId, status: "PENDING_PAYMENT" }).updateAll({ status: "PROCESSING", processingAt });

      if (claimedOrders.length === 0) {
        return await ctx.reply(`⚠️ Order already processed or is currently being processed.\n\nStatus: ${existingOrder.status}`);
      }

      const order = claimedOrders[0];
      console.log(`Order ${order.orderNumber} claimed for approval.`);

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      if (!customer) return await ctx.reply("❌ Customer not found.");

      const days = getPlanDays(order.plan);
      if (!days) return await ctx.reply("❌ Invalid VPN plan.");

      const now = Temporal.Now.instant();
      let subscription = await db.public.Subscription.where({ customerId: customer.id }).first();

      if (!subscription) {
        const accessKey = await createAccessKey(order);
        const expiresAt = now.add({ hours: days * 24 });

        subscription = await db.public.Subscription.create({
          customerId: customer.id, plan: order.plan, status: "ACTIVE", vpnKey: accessKey.accessUrl,
          vpnKeyId: accessKey.id, vpnKeyCreatedAt: now, startedAt: now, expiresAt, dataLimitGb: 100, dataUsedGb: 0
        });

        await db.public.Order.where({ id: order.id }).update({
          status: "PAID", processingAt: null, paidAt: now, vpnKey: accessKey.accessUrl,
          vpnKeyId: accessKey.id, vpnKeyCreatedAt: now, expiresAt, revokedAt: null
        });

        await bot.telegram.sendMessage(customer.telegramId,
          `🎉 Payment Approved!\n\nOrder: ${order.orderNumber}\nPlan: ${order.plan}\n\n🔐 VPN Subscription Created\n\n⏰ Expires:\n${formatInstant(expiresAt)}\n\n📊 Data Limit: 100 GB\n📊 Data Used: 0 GB\n\n⚠️ This is currently a test VPN subscription.\nReal Outline VPN access will be connected later.`
        );
        console.log(`New subscription created for customer ${customer.id}.\nOrder ${order.orderNumber} approved.`);
      } else {
        const isFuture = subscription.expiresAt && Temporal.Instant.compare(subscription.expiresAt, now) > 0;
        const newExpiresAt = (isFuture ? subscription.expiresAt : now).add({ hours: days * 24 });

        await db.public.Subscription.where({ id: subscription.id }).update({ plan: order.plan, status: "ACTIVE", expiresAt: newExpiresAt, revokedAt: null });

        await db.public.Order.where({ id: order.id }).update({
          status: "PAID", processingAt: null, paidAt: now, vpnKey: subscription.vpnKey,
          vpnKeyId: subscription.vpnKeyId, vpnKeyCreatedAt: subscription.vpnKeyCreatedAt, expiresAt: newExpiresAt, revokedAt: null
        });

        await bot.telegram.sendMessage(customer.telegramId,
          `🎉 Payment Approved!\n\nOrder: ${order.orderNumber}\nPlan: ${order.plan}\n\n🔄 Your existing VPN subscription has been extended.\n\n⏰ New Expiry:\n${formatInstant(newExpiresAt)}\n\n🔐 Your existing VPN key remains active.\nYou do not need to add a new key.`
        );
        console.log(`Subscription ${subscription.id} extended.\nOrder ${order.orderNumber} approved.`);
      }

      try {
        await ctx.editMessageCaption(`${ctx.callbackQuery.message.caption}\n\n\n✅ PAYMENT APPROVED\n🔐 Subscription activated`);
      } catch (editError) { console.error("Failed to edit admin payment message:", editError); }
    } catch (error) {
      console.error("Approve payment error:", error);
      await ctx.reply("❌ Failed to approve payment.\n\nThe order may still be in PROCESSING status. If it remains there for more than 15 minutes, the system will recover it automatically.");
    }
  });

  bot.action(/^reject_payment_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return await ctx.answerCbQuery("Unauthorized");
    await ctx.answerCbQuery("Rejecting...");

    const orderId = Number(ctx.match[1]);
    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) return await ctx.reply("❌ Order not found.");
      if (order.status !== "PENDING_PAYMENT") return await ctx.reply(`⚠️ Order already processed.\n\nStatus: ${order.status}`);

      await db.public.Order.where({ id: order.id }).update({ status: "PAYMENT_REJECTED", processingAt: null });

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      if (customer) {
        await bot.telegram.sendMessage(customer.telegramId, `❌ Payment Rejected\n\nOrder: ${order.orderNumber}\n\nPlease contact admin or submit a valid payment screenshot.`);
      }

      try {
        await ctx.editMessageCaption(`${ctx.callbackQuery.message.caption}\n\n\n❌ PAYMENT REJECTED`);
      } catch (editError) { console.error("Failed to edit rejected payment message:", editError); }

      console.log(`Order ${order.orderNumber} rejected.`);
    } catch (error) {
      console.error("Reject payment error:", error);
      await ctx.reply("❌ Failed to reject payment.");
    }
  });

  bot.action(/^cancel_order_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = Number(ctx.match[1]);
    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) return await ctx.reply("❌ Order not found.");
      if (order.status !== "PENDING_PAYMENT") return await ctx.reply("⚠️ This order cannot be cancelled.");

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      if (!customer || customer.telegramId !== String(ctx.from.id)) return await ctx.reply("❌ You are not authorized to cancel this order.");

      await db.public.Order.where({ id: orderId }).update({ status: "CANCELLED" });
      pendingProofs.delete(String(ctx.from.id));

      await ctx.reply(`❌ Order cancelled.\n\nOrder: ${order.orderNumber}`);
    } catch (error) {
      console.error("Cancel order error:", error);
      await ctx.reply("❌ Failed to cancel order.");
    }
  });

  bot.action("my_orders", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.where({ telegramId: String(ctx.from.id) }).first();
      if (!customer) return await ctx.reply("📦 You don't have any orders yet.");

      const orders = await db.public.Order.where({ customerId: customer.id }).orderBy((order) => order.createdAt.desc()).all();
      if (!orders.length) return await ctx.reply("📦 You don't have any orders yet.");

      let message = "📦 Your Orders\n\n";
      for (const order of orders) {
        message += `🧾 ${order.orderNumber}\nPlan: ${order.plan}\nPrice: $${order.price}\nStatus: ${order.status}\n`;
        if (order.expiresAt) message += `Expires: ${formatInstant(order.expiresAt)}\n`;
        message += "\n";
      }

      await ctx.reply(message);
    } catch (error) {
      console.error("My orders error:", error);
      await ctx.reply("❌ Failed to load orders.");
    }
  });

  bot.catch((error) => console.error("Telegram bot error:", error));

  console.log("Starting Telegram bot...");
  await bot.launch();
  console.log("VPN Bot is running...");

  const shutdown = (signal) => {
    console.log(`${signal} received. Shutting down...`);
    bot.stop(signal);
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

startBot().catch((error) => {
  console.error("Failed to start VPN Bot:", error);
  process.exit(1);
});