const { Temporal } = require("@js-temporal/polyfill");
const { Markup } = require("telegraf");
const { createWindowLimiter } = require("./abuse-limits");
const { createSupportEvents } = require("./support-events");
const { redactConnectionText } = require("./customer-dto");

const REPLY_WINDOW_MINUTES = 15;
const CUSTOMER_ACK = "စာရပါပြီ။\nတတ်နိုင်သမျှ အမြန်ပြန်ဖြေပေးပါမယ်။";

function ticketNumber(ticket) {
  return `SUP-${String(ticket.id).padStart(4, "0")}`;
}

function safeText(value) {
  return redactConnectionText(value);
}

function ticketKeyboard(ticket) {
  return Markup.inlineKeyboard([[
    Markup.button.callback("↩️ Reply", `support_reply_${ticket.id}`),
    Markup.button.callback("✅ Close Ticket", `support_close_${ticket.id}`),
  ]]);
}

function supportPromptKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Back", "support_main_menu")],
    [Markup.button.callback("❌ ရပ်မယ်", "support_cancel")],
  ]);
}

function createSupportService({ db, bot, adminTelegramId, isAdmin, helpKeyboard, supportEvents }) {
  supportEvents ||= createSupportEvents();
  const allowText = createWindowLimiter({ windowMs: 60000, max: 10 });
  const allowPhoto = createWindowLimiter({ windowMs: 60000, max: 4 });
  const limitMessage = "စာတွေ ဆက်တိုက်ပို့နေပါတယ်။ တစ်မိနစ်လောက်စောင့်ပြီး ပြန်ပို့ပေးပါ။";
  async function customerForTelegramId(telegramId) {
    return db.public.Customer.where({ telegramId: String(telegramId) }).first();
  }

  async function openTicketForCustomer(customerId) {
    return db.public.SupportTicket.where({ customerId, status: "OPEN" }).first();
  }

  async function openOrResumeTicket(telegramId, activateInput = false) {
    const customer = await customerForTelegramId(telegramId);
    if (!customer) return null;
    let ticket = await openTicketForCustomer(customer.id);
    if (!ticket) {
      try {
        ticket = await db.public.SupportTicket.create({
          customerId: customer.id, status: "OPEN", customerInputActive: activateInput,
          adminReplySelected: false,
        });
      } catch {
        ticket = await openTicketForCustomer(customer.id);
        if (!ticket) throw new Error("Support ticket could not be opened.");
      }
    }
    if (activateInput && !ticket.customerInputActive) {
      ticket = await db.public.SupportTicket.where({ id: ticket.id, status: "OPEN" })
        .update({ customerInputActive: true, acknowledgedAt: null,
          updatedAt: Temporal.Now.instant() });
    }
    return { customer, ticket };
  }

  async function recordMessage(ticket, sender, text) {
    const saved = await db.public.SupportMessage.create({ ticketId: ticket.id,
      customerId: ticket.customerId, sender, text, createdAt: Temporal.Now.instant() });
    const message = publicMessage(saved);
    supportEvents.publish(ticket.customerId, message);
    return message;
  }

  function publicMessage(message) {
    return { key: supportEvents.messageId(message.id),
      sender: message.sender, text: message.text,
      createdAt: message.createdAt?.toString() || null };
  }

  async function listMessages(telegramId) {
    const customer = await customerForTelegramId(telegramId);
    if (!customer) return null;
    const ticket = await openTicketForCustomer(customer.id);
    if (!ticket) return { messages: [] };
    const rows = await db.public.SupportMessage.where({ ticketId: ticket.id,
      customerId: customer.id }).orderBy((message) => message.createdAt.desc()).limit(100).all();
    return { messages: rows.sort((a, b) => a.id - b.id).map(publicMessage) };
  }

  async function sendCustomerMessage(telegramId, text) {
    if (typeof text !== "string" || !text.trim() || text.length > 3000)
      return { error: "ပို့ချင်တဲ့စာကို ရေးပေးပါ။ စာလုံးရေ 3000 ထက် မကျော်ရပါဘူး။", status: 400 };
    const target = await openOrResumeTicket(telegramId);
    if (!target) return { error: "အကောင့်ကို အခုကြည့်လို့မရသေးပါဘူး။ Support မှာ ဆက်သွယ်ပေးပါ။", status: 403 };
    if (!allowText(telegramId)) return { error: limitMessage, status: 429 };
    const content = safeText(text.trim());
    await relayCustomerText(target.customer, target.ticket, content);
    const message = await recordMessage(target.ticket, "customer", content);
    await db.public.SupportTicket.where({ id: target.ticket.id, status: "OPEN" })
      .update({ updatedAt: Temporal.Now.instant() });
    return { ok: true, message };
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
      await openOrResumeTicket(customer.telegramId, true);
      await ctx.reply(
        "🎧 Metro Secure Support\n\nဘာအကူအညီလိုလဲ ရေးပို့ပေးပါ။ ပုံလည်း ပို့လို့ရပါတယ်။\nတတ်နိုင်သမျှ အမြန်ပြန်ဖြေပေးပါမယ်။",
        supportPromptKeyboard()
      );
    } catch {
      console.error("Support ticket opening failed.");
      await ctx.reply("Support ကို အခုဖွင့်လို့မရသေးပါဘူး။ ခဏနေရင် ပြန်စမ်းကြည့်ပေးပါ။");
    }
  }

  async function cancel(ctx) {
    await ctx.answerCbQuery();
    try {
      await pauseCustomer(ctx.from.id);
      await ctx.reply("Support စာပို့တာကို ရပ်ထားပါပြီ။\nလိုအပ်ရင် Support ကို ပြန်နှိပ်လို့ရပါတယ်။",
        helpKeyboard());
    } catch {
      console.error("Support cancellation failed.");
      await ctx.reply("အခုရပ်လို့မရသေးပါဘူး။ ခဏနေရင် ပြန်စမ်းကြည့်ပေးပါ။");
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
        "ဒီမေးခွန်းအတွက် Support ကို ပိတ်ထားပါပြီ။\nအကူအညီထပ်လိုရင် Support မှာ ပြန်ဆက်သွယ်လို့ရပါတယ်။");
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
      await recordMessage(target.ticket, "support", content);
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
    await recordMessage(target.ticket, "customer", safeText(ctx.message.text));
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
      await recordMessage(target.ticket, "support", caption || "Support က ပုံပို့ထားပါတယ်။");
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
      await ctx.reply("20 MB ထက်ငယ်တဲ့ ပုံကို ပို့ပေးပါ။");
      return true;
    }
    await relayCustomerPhoto(target.customer, target.ticket, photo, ctx.message.caption);
    await recordMessage(target.ticket, "customer", safeText(ctx.message.caption) || "ပုံပို့ထားပါတယ်။");
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
    clearAdminReply, openOrResumeTicket, listMessages, sendCustomerMessage };
}

module.exports = { createSupportService, ticketNumber };
