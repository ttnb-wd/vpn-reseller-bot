const { Markup } = require("telegraf");

function buildCustomerMenu(isAdmin, adminRows = []) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛡️ Buy VPN", "buy_vpn"), Markup.button.callback("🌐 My VPN", "my_vpn")],
    [Markup.button.callback("🗂️ My Orders", "my_orders"), Markup.button.callback("🛰️ Setup VPN", "setup_vpn")],
    [Markup.button.callback("🎧 Help", "help")],
    ...(isAdmin ? adminRows : []),
  ]);
}

function buildPersistentCustomerKeyboard() {
  return Markup.keyboard([
    ["🛡️ Buy VPN", "🌐 My VPN"],
    ["📊 Usage", "♻️ Renew"],
    ["⚡ Connect", "🎧 Support"],
  ]).resize().persistent().oneTime(false).placeholder("Select an option");
}

module.exports = { buildCustomerMenu, buildPersistentCustomerKeyboard };
