require("dotenv").config();

const crypto = require("crypto");
const { Telegraf, Markup } = require("telegraf");
const { Temporal } = require("@js-temporal/polyfill");

const { createDatabase } = require("./db");
const { PAYMENT_METHODS } = require("./payment-config");
const {
  createAccessKey,
  deleteAccessKey,
} = require("./outline");

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID);

let db;
const pendingProofs = new Map();

function isAdmin(ctx) {
  return String(ctx.from?.id) === ADMIN_TELEGRAM_ID;
}

function getPlanDays(plan) {
  const plans = { "7 Days": 7, "30 Days": 30, "90 Days": 90 };
  return plans[plan] || 0;
}

function formatInstant(instant) {
  return instant ? instant.toString() : "N/A";
}

async function startBot() {
  console.log("Starting VPN Bot...");
  const database = await createDatabase();
  db = database.client;
  console.log("PostgreSQL connected.");

  // ============================================
  // /start
  // ============================================
  bot.start(async (ctx) => {
    await ctx.reply(
      "🔐 Welcome to VPN Reseller Bot\n\nChoose an option below.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🛒 Buy VPN", "buy_vpn")],
        [Markup.button.callback("📱 My VPN", "my_vpn")],
        [Markup.button.callback("📦 My Orders", "my_orders")],
      ])
    );
  });

  // ============================================
  // /myid
  // ============================================
  bot.command("myid", async (ctx) => {
    await ctx.reply(`Your Telegram ID:\n${ctx.from.id}`);
  });

  // ============================================
  // MY VPN
  // ============================================
  bot.action("my_vpn", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.where({ telegramId: String(ctx.from.id) }).first();
      if (!customer) {
        await ctx.reply("❌ Customer account not found.");
        return;
      }

      const subscription = await db.public.Subscription.where({ customerId: customer.id }).first();
      if (!subscription) {
        await ctx.reply(
          "🔐 You don't have a VPN subscription yet.",
          Markup.inlineKeyboard([[Markup.button.callback("🛒 Buy VPN", "buy_vpn")]])
        );
        return;
      }

      const now = Temporal.Now.instant();
      let remainingDays = 0;
      if (subscription.expiresAt) {
        const remainingSeconds = Number(subscription.expiresAt.epochSeconds - now.epochSeconds);
        remainingDays = Math.max(0, Math.ceil(remainingSeconds / 86400));
      }

      const isActive = subscription.status === "ACTIVE" && remainingDays > 0;
      const status = isActive ? "🟢 ACTIVE" : "🔴 EXPIRED";
      const dataUsed = subscription.dataUsedGb || 0;
      const dataLimit = subscription.dataLimitGb || 0;

      await ctx.reply(
        `🔐 My VPN\n\n` +
          `Status: ${status}\n\n` +
          `📦 Plan: ${subscription.plan}\n` +
          `⏳ Remaining: ${remainingDays} Days\n\n` +
          `📅 Expires:\n${formatInstant(subscription.expiresAt)}\n\n` +
          `📊 Data Usage:\n${dataUsed} GB / ${dataLimit} GB`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📱 Add to Device", "add_device")],
          [Markup.button.callback("🔗 Connection Link", "connection_link")],
          [Markup.button.callback("🔄 Renew", "renew_vpn")],
          [Markup.button.callback("🔄 Refresh", "my_vpn")],
        ])
      );
    } catch (error) {
      console.error("My VPN error:", error);
      await ctx.reply("❌ Failed to load VPN information.");
    }
  });

  /// ============================================
// CONNECTION LINK
// ============================================

bot.action("connection_link", async (ctx) => {
  await ctx.answerCbQuery();

  try {
    const customer =
      await db.public.Customer
        .where({
          telegramId: String(ctx.from.id),
        })
        .first();

    if (!customer) {
      await ctx.reply(
        "❌ Customer account not found."
      );

      return;
    }

    const subscription =
      await db.public.Subscription
        .where({
          customerId: customer.id,
        })
        .first();

    if (!subscription) {
      await ctx.reply(
        "❌ You don't have a VPN subscription yet."
      );

      return;
    }

    if (!subscription.vpnKey) {
      await ctx.reply(
        "❌ VPN connection key is not available yet."
      );

      return;
    }

    const now =
      Temporal.Now.instant();

    if (
      subscription.status !== "ACTIVE" ||
      !subscription.expiresAt ||
      subscription.expiresAt.epochSeconds <=
        now.epochSeconds
    ) {
      await ctx.reply(
        "🔴 Your VPN subscription has expired."
      );

      return;
    }

    await ctx.reply(
      `🔗 VPN Connection Link\n\n` +
        `${subscription.vpnKey}\n\n` +
        `📅 Expires:\n` +
        `${formatInstant(subscription.expiresAt)}\n\n` +
        `⚠️ Keep this connection link private.`,

      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📱 Add to Device",
            "add_device"
          ),
        ],

        [
          Markup.button.callback(
            "⬅️ Back to My VPN",
            "my_vpn"
          ),
        ],
      ])
    );

  } catch (error) {
    console.error(
      "Connection link error:",
      error
    );

    await ctx.reply(
      "❌ Failed to load VPN connection link."
    );
  }
});

  // ============================================
  // RENEW VPN
  // ============================================
  bot.action("renew_vpn", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "🔄 Choose your renewal plan:",
      Markup.inlineKeyboard([
        [Markup.button.callback("7 Days - $3", "renew_plan_7")],
        [Markup.button.callback("30 Days - $8", "renew_plan_30")],
        [Markup.button.callback("90 Days - $20", "renew_plan_90")],
        [Markup.button.callback("⬅️ Back", "my_vpn")],
      ])
    );
  });

  bot.action("renew_plan_7", async (ctx) => createRenewalOrder(ctx, "7 Days", 3));
  bot.action("renew_plan_30", async (ctx) => createRenewalOrder(ctx, "30 Days", 8));
  bot.action("renew_plan_90", async (ctx) => createRenewalOrder(ctx, "90 Days", 20));

  async function createRenewalOrder(ctx, plan, price) {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.where({ telegramId: String(ctx.from.id) }).first();
      if (!customer) {
        await ctx.reply("❌ Customer account not found.");
        return;
      }

      const subscription = await db.public.Subscription.where({ customerId: customer.id }).first();
      if (!subscription) {
        await ctx.reply("❌ You don't have a VPN subscription yet.\n\nPlease use Buy VPN first.");
        return;
      }

      const orderNumber = `VPN-${crypto.randomUUID()}`;
      const order = await db.public.Order.create({
        orderNumber,
        plan,
        price,
        status: "PENDING_PAYMENT",
        customerId: customer.id,
      });

      await ctx.reply(
        `🔄 Renewal Order Created\n\n` +
          `Order: ${order.orderNumber}\n` +
          `Plan: ${order.plan}\n` +
          `Price: $${order.price}\n\n` +
          `Choose payment method:`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🏦 Bank Transfer", `payment_bank_${order.id}`)],
          [Markup.button.callback("📱 Mobile Wallet", `payment_wallet_${order.id}`)],
          [Markup.button.callback("❌ Cancel Order", `cancel_order_${order.id}`)],
        ])
      );
    } catch (error) {
      console.error("Create renewal order error:", error);
      await ctx.reply("❌ Failed to create renewal order.");
    }
  }

  // ============================================
  // BUY VPN
  // ============================================
  bot.action("buy_vpn", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "📦 Choose your VPN plan:",
      Markup.inlineKeyboard([
        [Markup.button.callback("7 Days - $3", "plan_7")],
        [Markup.button.callback("30 Days - $8", "plan_30")],
        [Markup.button.callback("90 Days - $20", "plan_90")],
      ])
    );
  });

  bot.action("plan_7", async (ctx) => createOrder(ctx, "7 Days", 3));
  bot.action("plan_30", async (ctx) => createOrder(ctx, "30 Days", 8));
  bot.action("plan_90", async (ctx) => createOrder(ctx, "90 Days", 20));

  async function createOrder(ctx, plan, price) {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.upsert({
        conflictOn: { telegramId: true },
        create: {
          telegramId: String(ctx.from.id),
          username: ctx.from.username || null,
          firstName: ctx.from.first_name || null,
        },
        update: {
          username: ctx.from.username || null,
          firstName: ctx.from.first_name || null,
        },
      });

      const orderNumber = `VPN-${crypto.randomUUID()}`;
      const order = await db.public.Order.create({
        orderNumber,
        plan,
        price,
        status: "PENDING_PAYMENT",
        customerId: customer.id,
      });

      await ctx.reply(
        `🧾 Order Created\n\n` +
          `Order: ${order.orderNumber}\n` +
          `Plan: ${order.plan}\n` +
          `Price: $${order.price}\n\n` +
          `Choose payment method:`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🏦 Bank Transfer", `payment_bank_${order.id}`)],
          [Markup.button.callback("📱 Mobile Wallet", `payment_wallet_${order.id}`)],
          [Markup.button.callback("❌ Cancel Order", `cancel_order_${order.id}`)],
        ])
      );
    } catch (error) {
      console.error("Create order error:", error);
      await ctx.reply("❌ Failed to create order.");
    }
  }

  // ============================================
  // PAYMENT HANDLERS
  // ============================================
  bot.action(/^payment_bank_(\d+)$/, async (ctx) => {
    await handlePaymentMethod(ctx, "bank_transfer", Number(ctx.match[1]));
  });

  bot.action(/^payment_wallet_(\d+)$/, async (ctx) => {
    await handlePaymentMethod(ctx, "mobile_wallet", Number(ctx.match[1]));
  });

  async function handlePaymentMethod(ctx, method, orderId) {
    await ctx.answerCbQuery();
    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) {
        await ctx.reply("❌ Order not found.");
        return;
      }

      const payment = PAYMENT_METHODS[method];
      if (!payment) {
        await ctx.reply("❌ Payment method unavailable.");
        return;
      }

      await db.public.Order.where({ id: orderId }).update({ paymentMethod: method });

      await ctx.reply(
        `💳 ${payment.name}\n\n` +
          `Account Name: ${payment.accountName}\n` +
          `Account Number: ${payment.accountNumber}\n\n` +
          `Amount: $${order.price}\n\n` +
          `After payment, send your payment screenshot here.`
      );

      pendingProofs.set(String(ctx.from.id), orderId);
      await ctx.reply("📸 Please send your payment screenshot.");
    } catch (error) {
      console.error("Payment method error:", error);
      await ctx.reply("❌ Something went wrong.");
    }
  }

  // ============================================
  // PAYMENT SCREENSHOT
  // ============================================
  bot.on("photo", async (ctx) => {
    const userId = String(ctx.from.id);
    const orderId = pendingProofs.get(userId);
    if (!orderId) return;

    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) {
        await ctx.reply("❌ Order not found.");
        pendingProofs.delete(userId);
        return;
      }

      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];
      const paymentProof = largestPhoto.file_id;

      await db.public.Order.where({ id: orderId }).update({ paymentProof });
      pendingProofs.delete(userId);

      await ctx.reply("✅ Payment Screenshot Received\n\n⏳ Admin will verify your payment.");

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      const adminCaption =
        `💰 PAYMENT VERIFICATION\n\n` +
        `Order: ${order.orderNumber}\n` +
        `Plan: ${order.plan}\n` +
        `Price: $${order.price}\n\n` +
        `Customer: ${customer?.firstName || "N/A"}\n` +
        `Username: @${customer?.username || "N/A"}\n` +
        `Telegram ID: ${customer?.telegramId}`;

      await bot.telegram.sendPhoto(ADMIN_TELEGRAM_ID, paymentProof, {
        caption: adminCaption,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Approve", `approve_payment_${order.id}`),
            Markup.button.callback("❌ Reject", `reject_payment_${order.id}`),
          ],
        ]),
      });
    } catch (error) {
      console.error("Payment proof error:", error);
      await ctx.reply("❌ Failed to submit payment proof.");
    }
  });

  // ============================================
  // ADMIN APPROVE PAYMENT
  // ============================================
  bot.action(/^approve_payment_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }

    await ctx.answerCbQuery("Processing...");
    const orderId = Number(ctx.match[1]);

    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) {
        await ctx.reply("❌ Order not found.");
        return;
      }

      if (order.status !== "PENDING_PAYMENT") {
        await ctx.reply(`⚠️ Order already processed.\n\nStatus: ${order.status}`);
        return;
      }

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      if (!customer) {
        await ctx.reply("❌ Customer not found.");
        return;
      }

      const days = getPlanDays(order.plan);
      if (!days) {
        await ctx.reply("❌ Invalid VPN plan.");
        return;
      }

      const now = Temporal.Now.instant();
      let subscription = await db.public.Subscription.where({ customerId: customer.id }).first();

      if (!subscription) {
        // New Subscription
        const accessKey = await createAccessKey(order);
        const expiresAt = now.add({ hours: days * 24 });

        subscription = await db.public.Subscription.create({
          customerId: customer.id,
          plan: order.plan,
          status: "ACTIVE",
          vpnKey: accessKey.accessUrl,
          vpnKeyId: accessKey.id,
          vpnKeyCreatedAt: now,
          startedAt: now,
          expiresAt,
          dataLimitGb: 100,
          dataUsedGb: 0,
        });

        await db.public.Order.where({ id: order.id }).update({
          status: "PAID",
          paidAt: now,
          vpnKey: accessKey.accessUrl,
          vpnKeyId: accessKey.id,
          vpnKeyCreatedAt: now,
          expiresAt,
          revokedAt: null,
        });

        await bot.telegram.sendMessage(
          customer.telegramId,
          `🎉 Payment Approved!\n\n` +
            `Order: ${order.orderNumber}\n` +
            `Plan: ${order.plan}\n\n` +
            `🔐 VPN Subscription Created\n\n` +
            `⏰ Expires:\n${formatInstant(expiresAt)}\n\n` +
            `📊 Data Limit: 100 GB\n` +
            `📊 Data Used: 0 GB\n\n` +
            `⚠️ This is currently a test VPN subscription.\n` +
            `Real Outline VPN access will be connected later.`
        );

        console.log(`New subscription created for customer ${customer.id}.`);
        console.log(`Order ${order.orderNumber} approved.`);
      } else {
        // Existing Subscription
        let newExpiresAt;
        if (subscription.expiresAt && Temporal.Instant.compare(subscription.expiresAt, now) > 0) {
          newExpiresAt = subscription.expiresAt.add({ hours: days * 24 });
        } else {
          newExpiresAt = now.add({ hours: days * 24 });
        }

        await db.public.Subscription.where({ id: subscription.id }).update({
          plan: order.plan,
          status: "ACTIVE",
          expiresAt: newExpiresAt,
          revokedAt: null,
        });

        await db.public.Order.where({ id: order.id }).update({
          status: "PAID",
          paidAt: now,
          vpnKey: subscription.vpnKey,
          vpnKeyId: subscription.vpnKeyId,
          vpnKeyCreatedAt: subscription.vpnKeyCreatedAt,
          expiresAt: newExpiresAt,
          revokedAt: null,
        });

        await bot.telegram.sendMessage(
          customer.telegramId,
          `🎉 Payment Approved!\n\n` +
            `Order: ${order.orderNumber}\n` +
            `Plan: ${order.plan}\n\n` +
            `🔄 Your existing VPN subscription has been extended.\n\n` +
            `⏰ New Expiry:\n${formatInstant(newExpiresAt)}\n\n` +
            `🔐 Your existing VPN key remains active.\n` +
            `You do not need to add a new key.`
        );

        console.log(`Subscription ${subscription.id} extended.`);
        console.log(`Order ${order.orderNumber} approved.`);
      }

      await ctx.editMessageCaption(
        `${ctx.callbackQuery.message.caption}\n\n\n✅ PAYMENT APPROVED\n🔐 Subscription activated`
      );
    } catch (error) {
      console.error("Approve payment error:", error);
      await ctx.reply("❌ Failed to approve payment.");
    }
  });

  // ============================================
  // ADMIN REJECT PAYMENT
  // ============================================
  bot.action(/^reject_payment_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }

    await ctx.answerCbQuery("Rejecting...");
    const orderId = Number(ctx.match[1]);

    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) {
        await ctx.reply("❌ Order not found.");
        return;
      }

      if (order.status !== "PENDING_PAYMENT") {
        await ctx.reply(`⚠️ Order already processed.\n\nStatus: ${order.status}`);
        return;
      }

      await db.public.Order.where({ id: order.id }).update({ status: "PAYMENT_REJECTED" });

      const customer = await db.public.Customer.where({ id: order.customerId }).first();
      if (customer) {
        await bot.telegram.sendMessage(
          customer.telegramId,
          `❌ Payment Rejected\n\nOrder: ${order.orderNumber}\n\nPlease contact admin or submit a valid payment screenshot.`
        );
      }

      await ctx.editMessageCaption(`${ctx.callbackQuery.message.caption}\n\n\n❌ PAYMENT REJECTED`);
      console.log(`Order ${order.orderNumber} rejected.`);
    } catch (error) {
      console.error("Reject payment error:", error);
      await ctx.reply("❌ Failed to reject payment.");
    }
  });

  // ============================================
  // CANCEL ORDER
  // ============================================
  bot.action(/^cancel_order_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = Number(ctx.match[1]);

    try {
      const order = await db.public.Order.where({ id: orderId }).first();
      if (!order) {
        await ctx.reply("❌ Order not found.");
        return;
      }

      if (order.status !== "PENDING_PAYMENT") {
        await ctx.reply("⚠️ This order cannot be cancelled.");
        return;
      }

      await db.public.Order.where({ id: orderId }).update({ status: "CANCELLED" });
      pendingProofs.delete(String(ctx.from.id));

      await ctx.reply(`❌ Order cancelled.\n\nOrder: ${order.orderNumber}`);
    } catch (error) {
      console.error("Cancel order error:", error);
      await ctx.reply("❌ Failed to cancel order.");
    }
  });

  // ============================================
  // MY ORDERS
  // ============================================
  bot.action("my_orders", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const customer = await db.public.Customer.where({ telegramId: String(ctx.from.id) }).first();
      if (!customer) {
        await ctx.reply("📦 You don't have any orders yet.");
        return;
      }

      const orders = await db.public.Order.where({ customerId: customer.id })
        .orderBy((order) => order.createdAt.desc())
        .all();

      if (!orders.length) {
        await ctx.reply("📦 You don't have any orders yet.");
        return;
      }

      let message = "📦 Your Orders\n\n";
      for (const order of orders) {
        message +=
          `🧾 ${order.orderNumber}\n` +
          `Plan: ${order.plan}\n` +
          `Price: $${order.price}\n` +
          `Status: ${order.status}\n`;

        if (order.expiresAt) {
          message += `Expires: ${formatInstant(order.expiresAt)}\n`;
        }
        message += "\n";
      }

      await ctx.reply(message);
    } catch (error) {
      console.error("My orders error:", error);
      await ctx.reply("❌ Failed to load orders.");
    }
  });

  // ============================================
  // ERROR HANDLER & STARTUP
  // ============================================
  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  console.log("Starting Telegram bot...");
  bot.launch();
  console.log("VPN Bot is running...");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

startBot().catch((error) => {
  console.error("Failed to start VPN Bot:", error);
  process.exit(1);
});