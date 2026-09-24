require("dotenv").config();

const { Telegraf } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async (ctx) => {
  console.log("Received /start from:", ctx.from.username);

  await ctx.reply("Test bot is working!");
});

async function start() {
  console.log("Creating Telegram bot...");

  const me = await bot.telegram.getMe();

  console.log("Bot:", `@${me.username}`);
  console.log("Launching polling...");

  bot.launch();

  console.log("Polling launch called.");
}

start().catch((error) => {
  console.error("START ERROR:");
  console.error(error);
});