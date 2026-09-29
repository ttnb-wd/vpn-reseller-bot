const { Markup } = require("telegraf");

function buildCustomerMenu(isAdmin, adminRows = [], miniAppUrl = null) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛡️ Buy VPN", "buy_vpn"), Markup.button.callback("🌐 My VPN", "my_vpn")],
    [Markup.button.callback("🗂️ My Orders", "my_orders"), Markup.button.callback("🛰️ Setup VPN", "setup_vpn")],
    [Markup.button.callback("🎧 Help", "help")],
    ...(miniAppUrl ? [[Markup.button.webApp("🧭 Open Metro", miniAppUrl)]] : []),
    ...(isAdmin ? adminRows : []),
  ]);
}

module.exports = { buildCustomerMenu };
