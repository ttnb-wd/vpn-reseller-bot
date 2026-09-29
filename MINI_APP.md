# Metro Secure Telegram Mini App

On startup, the bot sets Telegram's native chat menu button to **Metro** with
`MenuButtonWebApp` pointing to `PUBLIC_BASE_URL/app`. The `/app` route opens the
same Mini App previously served at `/mini-app/`. The menu URL contains no user
ID, customer ID, setup token, or VPN key. Telegram controls the native blue
button and its icon. No BotFather menu configuration or new database tables
are required.

The bot's main menu also includes **🧭 Open Metro** as an inline button. Sending
`/start` in a private chat displays the persistent six-button Reply Keyboard
with the `Select an option` input placeholder. Its text buttons run the
existing Buy VPN, My VPN, Usage, Renew, Connect, and Support flows.

The home screen reads the signed-in Telegram customer's current subscription,
30-day usage, expiry, and active packages. `VPN_REGION` controls the displayed
location; its default is `Singapore`, matching the Metro design. Set it to the
actual Outline server location when different. The screen does not display a
sample subscription when an account has none.

**Connect VPN** requests a fresh ten-minute setup link and opens the existing
Outline handoff page. That page uses the customer's existing key; it does not
create a key or connect the device without Outline. **Renew** and package
selection send the corresponding checkout screen to the customer's Telegram
chat, where the existing payment and approval flow continues. The Support
button sends the existing Support entry point to that chat.

The Mini App accepts only recent, valid Telegram Web App `initData` signed with
`BOT_TOKEN`. It does not use the untrusted `initDataUnsafe` identity. No VPN key
is returned by the account API. The Mini App route permits Telegram Web to frame
it, while the admin and setup routes keep their stronger framing policy.

The public URL must be HTTPS. If `PUBLIC_BASE_URL` contains a path prefix, the
reverse proxy must strip that prefix before forwarding to Express, as with the
existing setup link. Test the native **Metro** button in Telegram after deployment;
the browser alone cannot provide signed Mini App data.
