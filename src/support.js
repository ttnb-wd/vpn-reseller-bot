const { Temporal } = require("@js-temporal/polyfill");
const { Markup } = require("telegraf");
const { createWindowLimiter } = require("./abuse-limits");

const REPLY_WINDOW_MINUTES = 15;
const CUSTOMER_ACK = "✅ မက်ဆေ့ချ်ကို လက်ခံရရှိပါပြီ။\nSupport team က မကြာမီ ပြန်လည်ဖြေကြားပေးပါမယ်။";

function ticketNumber(ticket) {
  return `SUP-${String(ticket.id).padStart(4, "0")}`;
}

function safeText(value) {
  return String(value || "").replace(/ss:\/\/\S+/gi, "[VPN key hidden]");
}

function ticketKeyboard(ticket) {
  return Markup.inlineKeyboard([[
    Markup.button.callback("↩️ Reply", `support_reply_${ticket.id}`),
    Markup.button.callback("✅ Close Ticket", `support_close_${ticket.id}`),
  ]]);
}

function supportPromptKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🏠 Main Menu", "support_main_menu")],
    [Markup.button.callback("❌ Cancel", "support_cancel")],
  ]);
}

function createSupportService({ db, bot, adminTelegramId, isAdmin, helpKeyboard }) {
  const allowText = createWindowLimiter({ windowMs: 60000, max: 10 });
  const allowPhoto = createWindowLimiter({ windowMs: 60000, max: 4 });
  const limitMessage = "You are sending support messages too quickly. Please wait a minute and try again.";
  async function customerForTelegramId(telegramId) {
    return db.public.Customer.where({ telegramId: String(telegramId) }).first();
  }

  async function openTicketForCustomer(customerId) {
    return db.public.SupportTicket.where({ customerId, status: "OPEN" }).first();
  }

  async function activeCustomerTicket(telegramId) {
    const customer = await customerForTelegramId(telegramId);
    if (!customer) return null;
    const ticket = await openTicketForCustomer(customer.id);
    return ticket?.customerInputActive ? { customer, ticket } : null;
  }

  async function contact(ctx) {
    await ctx.answerCbQuery();
    if (isAdmin(ctx)) return;
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
      let ticket = await openTicketForCustomer(customer.id);
      if (!ticket) {
        try {
          ticket = await db.public.SupportTicket.create({
            customerId: customer.id, status: "OPEN", customerInputActive: true,
            adminReplySelected: false,
          });
        } catch {
          // The unique open-ticket index handles two simultaneous taps.
          ticket = await openTicketForCustomer(customer.id);
          if (!ticket) throw new Error("Support ticket could not be opened.");
        }
      }
      if (!ticket.customerInputActive) {
        ticket = await db.public.SupportTicket.where({ id: ticket.id, status: "OPEN" })
          .update({ customerInputActive: true, acknowledgedAt: null,
            updatedAt: Temporal.Now.instant() });
      }
      await ctx.reply(
        "🎧 Metro Secure Support\n\nမေးလိုတာကို အောက်မှာ တိုက်ရိုက်ရေးပို့ပါ။\nScreenshot / photo လည်း ပို့နိုင်ပါတယ်။\n\nSupport team က ဒီ chat ထဲမှာပဲ ပြန်လည်ဖြေကြားပေးပါမယ်။",
        supportPromptKeyboard()
      );
    } catch {
      console.error("Support ticket opening failed.");
      await ctx.reply("Support ကို လောလောဆယ် ဖွင့်မရသေးပါ။ ခဏနေ ပြန်ကြိုးစားပါ။");
    }
  }

  async function cancel(ctx) {
    await ctx.answerCbQuery();
    try {
      await pauseCustomer(ctx.from.id);
      await ctx.reply("🎧 Help\n\nSupport စာပို့ခြင်းကို ရပ်ထားပါပြီ။ လိုအပ်ရင် Contact Support ကို ပြန်နှိပ်နိုင်ပါတယ်။",
        helpKeyboard());
    } catch {
      console.error("Support cancellation failed.");
      await ctx.reply("Support ကို ရပ်မရသေးပါ။ ခဏနေ ပြန်ကြိုးစားပါ။");
    }
  }

  function adminContext(customer, ticket) {
    return `🎧 New Support Message\n\nTicket: ${ticketNumber(ticket)}\n` +
      `Customer: ${safeText(customer.firstName) || "-"}\n` +
      `Username: ${customer.username ? `@${safeText(customer.username)}` : "-"}\n` +
      `Telegram ID: ${customer.telegramId}\n\nMessage:\n`;
  }

  async function relayCustomerText(customer, ticket, message) {
    const prefix = adminContext(customer, ticket);
    const content = safeText(message);
    await bot.telegram.sendMessage(adminTelegramId, prefix + content.slice(0, 3000), ticketKeyboard(ticket));
    for (let offset = 3000; offset < content.length; offset += 3500) {
      await bot.telegram.sendMessage(adminTelegramId,
        `${ticketNumber(ticket)} (continued)\n${content.slice(offset, offset + 3500)}`);
    }
  }

  async function relayCustomerPhoto(customer, ticket, photo, caption) {
    const prefix = adminContext(customer, ticket);
    const content = safeText(caption) || "Screenshot / photo";
    const available = Math.max(0, 1000 - prefix.length);
    await bot.telegram.sendPhoto(adminTelegramId, photo.file_id, {
      caption: prefix + content.slice(0, available),
      ...ticketKeyboard(ticket),
    });
    if (content.length > available) {
      await bot.telegram.sendMessage(adminTelegramId,
        `${ticketNumber(ticket)} (caption continued)\n${content.slice(available)}`);
    }
  }

  async function acknowledgeFirstMessage(ctx, ticket) {
    const now = Temporal.Now.instant();
    const claimed = await db.public.SupportTicket
      .where({ id: ticket.id, status: "OPEN", customerInputActive: true })
      .where((row) => row.acknowledgedAt.isNull())
      .updateAll({ acknowledgedAt: now, updatedAt: now });
    if (claimed.length) await ctx.reply(CUSTOMER_ACK, supportPromptKeyboard());
  }

  async function selectedAdminTicket() {
    const ticket = await db.public.SupportTicket
      .where({ status: "OPEN", adminReplySelected: true }).first();
    if (!ticket) return null;
    const selectedAt = ticket.adminReplySelectedAt;
    if (!selectedAt || Temporal.Instant.compare(selectedAt,
      Temporal.Now.instant().subtract({ minutes: REPLY_WINDOW_MINUTES })) < 0) {
      await db.public.SupportTicket.where({ id: ticket.id })
        .update({ adminReplySelected: false, adminReplySelectedAt: null });
      return null;
    }
    const customer = await db.public.Customer.where({ id: ticket.customerId }).first();
    return customer ? { customer, ticket } : null;
  }

  async function selectReply(ctx) {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized");
    await ctx.answerCbQuery();
    try {
      const id = Number(ctx.match[1]);
      const ticket = await db.public.SupportTicket.where({ id, status: "OPEN" }).first();
      if (!ticket) return ctx.reply("Support ticket is already closed or unavailable.");
      await db.public.SupportTicket.where({ adminReplySelected: true })
        .updateAll({ adminReplySelected: false, adminReplySelectedAt: null });
      await db.public.SupportTicket.where({ id, status: "OPEN" }).update({
        adminReplySelected: true,
        adminReplySelectedAt: Temporal.Now.instant(),
        updatedAt: Temporal.Now.instant(),
      });
      await ctx.reply(`↩️ Reply to ${ticketNumber(ticket)}\nSend your next text or photo here within 15 minutes. The customer sees only Metro Secure Support.`);
    } catch {
      console.error("Support reply selection failed.");
      await ctx.reply("Could not select this support ticket. Please try again.");
    }
  }

  async function close(ctx) {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized");
    await ctx.answerCbQuery();
    try {
      const id = Number(ctx.match[1]);
      const ticket = await db.public.SupportTicket.where({ id, status: "OPEN" }).first();
      if (!ticket) return ctx.reply("Support ticket is already closed or unavailable.");
      const now = Temporal.Now.instant();
      await db.public.SupportTicket.where({ id, status: "OPEN" }).update({
        status: "CLOSED", customerInputActive: false, adminReplySelected: false,
        adminReplySelectedAt: null, closedAt: now, updatedAt: now,
      });
      const customer = await db.public.Customer.where({ id: ticket.customerId }).first();
      if (customer) await bot.telegram.sendMessage(customer.telegramId,
        "✅ Support ဆက်သွယ်မှုကို ပိတ်ပြီးပါပြီ။\n\nလိုအပ်ရင် Contact Support မှာ ပြန်လည်ဆက်သွယ်နိုင်ပါတယ်။");
      await ctx.reply(`${ticketNumber(ticket)} closed.`);
    } catch {
      console.error("Support ticket closing failed.");
      await ctx.reply("Could not close this support ticket. Please try again.");
    }
  }

  async function handleText(ctx) {
    if (isAdmin(ctx)) {
      const target = await selectedAdminTicket();
      if (!target) return false;
      const content = safeText(ctx.message.text);
      await bot.telegram.sendMessage(target.customer.telegramId,
        `🎧 Metro Secure Support\n\n${content.slice(0, 3500)}`,
        supportPromptKeyboard());
      for (let offset = 3500; offset < content.length; offset += 3500) {
        await bot.telegram.sendMessage(target.customer.telegramId,
          content.slice(offset, offset + 3500), supportPromptKeyboard());
      }
      await db.public.SupportTicket.where({ id: target.ticket.id, status: "OPEN" })
        .update({ adminReplySelected: false, adminReplySelectedAt: null,
          updatedAt: Temporal.Now.instant() });
      await ctx.reply(`Reply sent to ${ticketNumber(target.ticket)}.`);
      return true;
    }
    const target = await activeCustomerTicket(ctx.from.id);
    if (!target) return false;
    if (!allowText(ctx.from.id)) { await ctx.reply(limitMessage); return true; }
    await relayCustomerText(target.customer, target.ticket, ctx.message.text);
    await db.public.SupportTicket.where({ id: target.ticket.id, status: "OPEN" })
      .update({ updatedAt: Temporal.Now.instant() });
    await acknowledgeFirstMessage(ctx, target.ticket);
    return true;
  }

  async function handlePhoto(ctx) {
    const photo = ctx.message.photo?.at(-1);
    if (!photo) return false;
    if (isAdmin(ctx)) {
      const target = await selectedAdminTicket();
      if (!target) return false;
      const caption = safeText(ctx.message.caption);
      const prefix = "🎧 Metro Secure Support";
      const available = 1000 - prefix.length - 2;
      await bot.telegram.sendPhoto(target.customer.telegramId, photo.file_id, {
        caption: caption ? `${prefix}\n\n${caption.slice(0, available)}` : prefix,
        ...supportPromptKeyboard(),
      });
      if (caption.length > available) {
        await bot.telegram.sendMessage(target.customer.telegramId,
          caption.slice(available), supportPromptKeyboard());
      }
      await db.public.SupportTicket.where({ id: target.ticket.id, status: "OPEN" })
        .update({ adminReplySelected: false, adminReplySelectedAt: null,
          updatedAt: Temporal.Now.instant() });
      await ctx.reply(`Photo sent to ${ticketNumber(target.ticket)}.`);
      return true;
    }
    const target = await activeCustomerTicket(ctx.from.id);
    if (!target) return false;
    if (!allowPhoto(ctx.from.id)) { await ctx.reply(limitMessage); return true; }
    if (photo.file_size != null && (!Number.isSafeInteger(photo.file_size) ||
        photo.file_size <= 0 || photo.file_size > 20 * 1024 * 1024)) {
      await ctx.reply("Please send a photo smaller than 20 MB.");
      return true;
    }
    await relayCustomerPhoto(target.customer, target.ticket, photo, ctx.message.caption);
    await db.public.SupportTicket.where({ id: target.ticket.id, status: "OPEN" })
      .update({ updatedAt: Temporal.Now.instant() });
    await acknowledgeFirstMessage(ctx, target.ticket);
    return true;
  }

  async function pauseCustomer(telegramId) {
    const customer = await customerForTelegramId(telegramId);
    if (!customer) return;
    const ticket = await openTicketForCustomer(customer.id);
    if (ticket?.customerInputActive) await db.public.SupportTicket
      .where({ id: ticket.id, status: "OPEN" })
      .update({ customerInputActive: false, acknowledgedAt: null,
        updatedAt: Temporal.Now.instant() });
  }

  async function clearAdminReply() {
    await db.public.SupportTicket.where({ adminReplySelected: true })
      .updateAll({ adminReplySelected: false, adminReplySelectedAt: null });
  }

  return { contact, cancel, selectReply, close, handleText, handlePhoto, pauseCustomer,
    clearAdminReply };
}

module.exports = { createSupportService, ticketNumber };
