# Direct Outline setup

`src/bot.js` contains the complete implementation. The My VPN menu's **Setup
VPN** button now opens `PUBLIC_BASE_URL/connect/:token` on the existing Express
server. Older setup/device/connection callbacks issue a fresh helper link.

The page immediately navigates to the current `subscription.vpnKey`. **Open
Outline** retries that exact `ss://` string synchronously inside the click
handler. **Copy VPN Key** uses the clipboard API, with a second-click legacy copy
fallback when clipboard permission is denied. The key is not displayed as page
text. There are no download links, store redirects, installation detection, or
invented schemes in this flow.

## Configuration and hosting

- `PUBLIC_BASE_URL`: the public HTTPS address routed to this Express server,
  without credentials, a query, or a fragment. An optional path prefix must be
  stripped by the reverse proxy before forwarding to Express.
- `CONNECT_TOKEN_SECRET`: at least 32 bytes of cryptographically random secret
  material. Keep the same value on all instances and across restarts. Rotating
  it invalidates outstanding helper links. The application derives an AES key
  from this secret; hashing does not make a predictable password secure.
- Terminate HTTPS at the reverse proxy and forward `X-Forwarded-Proto: https`.
  Express trusts loopback, link-local, and private proxy addresses. Keep its
  listening port private, and have the proxy overwrite forwarded headers. If
  your proxy connects from a public address, configure trust for that specific
  proxy address in Express rather than trusting arbitrary callers.
- Do not record `/connect/*` bearer tokens or response bodies in proxy,
  monitoring, analytics, or request logs. This application does not log them.
  Serve this route without caching; it already sends `no-store` headers.

Both environment variables already existed in this workspace. No schema change
or new package is needed. The helper is part of the existing bot process; restart
the bot to use the change.

## Token and subscription behavior

Tokens use AES-256-GCM with a fresh random IV and an authenticated version
context. They encrypt only the subscription ID and expiry. They contain no VPN
key or Telegram ID and do not expose database IDs. They expire after ten minutes
or at subscription expiry, whichever comes first, and can survive restarts when
the secret is unchanged. They are bearer links: anyone possessing an unexpired
link can load its key.

Every page request reads the subscription again and requires `ACTIVE` status,
an expiry in the future, no `revokedAt`, an existing non-mock `vpnKeyId`, and an
existing `ss://` key. Invalid, tampered, expired, or ineligible links receive
410; database failures receive a generic 503; HTTP requests receive 400 without
a key or redirect. The setup path never invokes `createAccessKey()` or writes
to the database. Existing order/renewal provisioning remains separate.

The client necessarily receives the key in the page's script to open or copy
it, although it is never shown in the visible page body. Once delivered, a key
cannot be recalled from a browser or clipboard by expiring a link. The page
disables its buttons after its remaining validity period; server validation
continues to apply to every new page request.

## Platform evidence and expected behavior

Checked Outline's current `master` source at revision
`95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b` on 2026-09-28:

| Platform | Registration and expected handoff |
| --- | --- |
| iOS / iPadOS Safari | Both the [Apple client plist](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/src/cordova/apple/xcode/Outline/Outline-Info.plist) and [Capacitor iOS plist](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/capacitor/ios/App/App/Info.plist) declare `ss` and `ssconf`. The OS may prompt to open the app. If automatic navigation is blocked, use the click retry. iPads presenting a desktop user agent receive the same behavior. |
| Android Chrome | [Cordova configuration](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/config.xml) and the [Capacitor manifest](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/capacitor/android/app/src/main/AndroidManifest.xml) register browsable `ss` and `ssconf` intents. [Chrome documents gesture restrictions](https://developer.chrome.com/docs/android/intents). The retry uses the original custom scheme with a real click, without an intent wrapper or store fallback. |
| Windows | [Electron registration and handling](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/electron/index.ts) registers both protocols and accepts them from process arguments. A working installed protocol association and browser approval are required. |
| macOS | The native Apple client uses the [shared plist](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/src/cordova/apple/xcode/Outline/Outline-Info.plist) declaring both schemes and [Apple URL interception](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/web/app/url_interceptor.ts). Browser/OS permission and the installed scheme association determine whether navigation opens Outline. |

The [shared app handler](https://github.com/OutlineFoundation/outline-apps/blob/95dbc8c7b1f86992b32cb5c383bdf8c405bfd19b/client/web/app/app.ts)
accepts both `ss` (static) and `ssconf` (dynamic) keys and calls `confirmAddServer`
for intercepted URLs. This implementation uses only the customer's stored
static `ss://` key; it does not convert it into `ssconf://`.

Source support does not guarantee that every installed release, browser, or
Telegram embedded browser will open the app. Browsers do not reliably report
custom-scheme success or failure. The page therefore keeps both buttons visible
and never interprets a timeout as permission to send the user to a store. If
another Shadowsocks app owns the scheme, the OS may choose that app or ask the
user to choose. Test the installed Outline association on each target device.

## Verification

Run:

```powershell
node --test .\src\vpn-setup.test.cjs
node --check .\src\bot.js
git diff --check
```

Tests use synthetic keys, a fake database, and the real Express route on
loopback. They cover token protection/expiry, subscription eligibility, HTTPS
enforcement, safe script serialization, exact automatic/click navigation,
clipboard fallback, and the no-new-key rule. Browser behavior is simulated in
these tests; no actual mobile or desktop Outline launch has been verified.

For device testing, open **My VPN** in Telegram to obtain a fresh link. Tap
**Setup VPN**, approve the app-opening prompt if offered, and confirm Outline
offers the existing key. If it does not open automatically, tap **Open Outline**.
Also test **Copy VPN Key** after cancelling the browser prompt. On a device
without a registered handler, verify that the page retains the copy option and
does not redirect to an installer. Repeat on iOS/iPadOS Safari, Android Chrome,
Windows, and macOS, including Telegram's embedded browser where applicable.
