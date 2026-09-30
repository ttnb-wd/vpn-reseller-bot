if (process.env.NODE_ENV !== "production") require("dotenv").config({ quiet: true });

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const { Telegraf, Markup, Input } = require("telegraf");
const { Temporal } = require("@js-temporal/polyfill");

const { createDatabase } = require("./db");
const { createNavigation } = require("./navigation");
const { PAYMENT_METHODS } = require("./payment-config");
const { validateAdminConfig, createAdminRouter } = require("./admin-auth");
const { createSupportService } = require("./support");
const { createSupportEvents } = require("./support-events");
const { createTelegramAdmin } = require("./telegram-admin");
const { buildCustomerMenu, buildPersistentCustomerKeyboard,
  buildPersistentAdminKeyboard } = require("./customer-menu");
const { createWindowLimiter } = require("./abuse-limits");
const { createMiniAppRouter } = require("./mini-app");
const { safeDiagnosticCode, sanitizeDiagnosticMessage,
  logHandlerFailure } = require("./safe-diagnostics");

const {
  createOrderAccessKey,
  setAccessKeyDataLimit,
  validateOutlineConfig,
  testOutlineConnection,
  getAllAccessKeyUsage,
  getExistingAccessKeyIds,
  isAccessKeyNotFoundError,
} = require("./outline");

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (process.env.NODE_ENV === "production") {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Render places one TLS-terminating proxy in front of the private Express port.
// Trust that hop there so req.secure and req.ip reflect the external request.
// Keep the narrower private-proxy policy outside Render.
app.set("trust proxy", process.env.RENDER === "true"
  ? 1 : "loopback, linklocal, uniquelocal");

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("VPN Bot is running!");
});

let server;

let bot;
let miniAppSupportService;

const ADMIN_TELEGRAM_ID = String(
  process.env.ADMIN_TELEGRAM_ID
);

let db;
let usageSyncTimer;
let usageSyncRunning = false;

const pendingProofs = new Map();
const allowConnect = createWindowLimiter({ windowMs: 60000, max: 30 });
const allowNewOrder = createWindowLimiter({ windowMs: 60000, max: 6 });
const allowMiniFlow = createWindowLimiter({ windowMs: 60000, max: 6 });
const allowMiniConnect = createWindowLimiter({ windowMs: 60000, max: 12 });
const recentConfirmations = new Map();
const MINI_PAYMENT_CALLBACKS = { bank_transfer: "bank", mobile_wallet: "wallet" };

const PROCESSING_TIMEOUT_MINUTES = 15;

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
const USAGE_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const REPLY_SHORTCUTS = new Map([
  ["🛡️ Buy VPN", "buy_vpn"], ["🌐 My VPN", "my_vpn"],
  ["📊 Usage", "my_vpn"], ["♻️ Renew", "renew_vpn"],
  ["🎧 Support", "contact_support"],
]);

const GB_IN_BYTES = 1024 * 1024 * 1024;
const WELCOME_IMAGE = path.join(__dirname, "..", "assets", "images", "welcome-metro-secure.png");
const PACKAGE_IMAGE = path.join(__dirname, "..", "assets", "images", "package-metro-secure.png");
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;
const CONNECT_TOKEN_AAD = Buffer.from("vpn-connect:v1");

function getConnectConfig() {
  let baseUrl;
  try {
    baseUrl = new URL(process.env.PUBLIC_BASE_URL);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be the public HTTPS URL of this Express server.");
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password ||
      baseUrl.search || baseUrl.hash) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS without credentials, query, or fragment.");
  }
  const secret = process.env.CONNECT_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("CONNECT_TOKEN_SECRET must contain at least 32 bytes of random secret material.");
  }
  return {
    baseUrl: baseUrl.href.replace(/\/+$/, ""),
    tokenKey: crypto.createHash("sha256").update(secret).digest(),
  };
}

function createVpnConnectUrl(subscription) {
  if (!isSubscriptionActive(subscription) ||
      !isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) ||
      !Number.isSafeInteger(subscription.id) || subscription.id <= 0) {
    throw new Error("VPN setup requires an active subscription with an existing key.");
  }
  const { baseUrl, tokenKey } = getConnectConfig();
  const expiresAt = Math.min(
    Date.now() + CONNECT_TOKEN_TTL_MS,
    Number(Temporal.Instant.from(subscription.expiresAt).epochMilliseconds)
  );
  // Authenticated encryption hides the database ID. Neither the Telegram ID
  // nor the VPN key is included. Random IVs make every link different.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey, iv);
  cipher.setAAD(CONNECT_TOKEN_AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ subscriptionId: subscription.id, expiresAt }), "utf8"),
    cipher.final(),
  ]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  return `${baseUrl}/connect/v1.${token}`;
}

function readConnectToken(token) {
  if (typeof token !== "string" || !/^v1\.[A-Za-z0-9_-]{40,240}$/.test(token)) return null;
  try {
    const encoded = token.slice(3);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return null;
    const { tokenKey } = getConnectConfig();
    const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey, bytes.subarray(0, 12));
    decipher.setAAD(CONNECT_TOKEN_AAD);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(28)), decipher.final(),
    ]).toString("utf8"));
    if (!Number.isSafeInteger(payload.subscriptionId) || payload.subscriptionId <= 0 ||
        !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now() ||
        payload.expiresAt > Date.now() + CONNECT_TOKEN_TTL_MS) return null;
    return payload;
  } catch {
    // Never log bearer tokens, decrypted payloads, keys, or crypto errors.
    return null;
  }
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

function renderVpnConnectPage(vpnKey, nonce, remainingMs) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>VPN Setup</title>
  <style nonce="${nonce}">
    body { font-family: system-ui, sans-serif; margin: 0; background: #f4f7fa; color: #172b3a; }
    main { box-sizing: border-box; max-width: 440px; margin: 8vh auto; padding: 28px; }
    h1 { font-size: 2rem; }
    p { line-height: 1.55; }
    button { display: block; width: 100%; padding: 16px; margin: 12px 0; border: 0;
      border-radius: 12px; font: inherit; font-weight: 600; cursor: pointer;
      background: #087e8b; color: white; }
    button.secondary { background: #dfe9ef; color: #172b3a; }
    button:focus-visible { outline: 3px solid #172b3a; outline-offset: 3px; }
    button:disabled { opacity: .5; cursor: default; }
    .hint { font-size: .9rem; color: #425969; }
    .clipboard-buffer { position: fixed; top: 0; left: 0; width: 1px; height: 1px;
      opacity: 0; font-size: 16px; }
  </style>
</head>
<body>
  <main>
    <h1>VPN Setup</h1>
    <p id="status" role="status" aria-live="polite">Opening Outline...</p>
    <p>If Outline does not open:</p>
    <button id="open-outline" type="button">🧭 Open Outline</button>
    <button id="copy-key" class="secondary" type="button">Copy VPN Key</button>
    <p id="platform-help" class="hint">Allow your browser to open Outline, then tap Add / Connect.</p>
    <p class="hint">If Telegram's browser blocks opening Outline, open this page in Safari or Chrome,
      or copy the key and paste it into Outline. Keep this setup link private. It expires within 10 minutes.</p>
    <noscript>Enable JavaScript to open Outline or copy your key. You can also use Copy VPN Key in Telegram.</noscript>
  </main>
  <script nonce="${nonce}">
    (() => {
      let vpnKey = ${scriptJson(vpnKey)};
      const deadline = performance.now() + ${Math.max(0, remainingMs)};
      const status = document.getElementById("status");
      const openButton = document.getElementById("open-outline");
      const copyButton = document.getElementById("copy-key");
      let useLegacyCopy = false;
      let hintTimer;
      function isUsable() {
        if (vpnKey && performance.now() < deadline) return true;
        vpnKey = "";
        openButton.disabled = true;
        copyButton.disabled = true;
        status.textContent = "This setup link has expired. Return to My VPN in Telegram for a new link.";
        return false;
      }
      function openOutline() {
        if (!isUsable()) return;
        clearTimeout(hintTimer);
        status.textContent = "Opening Outline...";
        // Keep this synchronous inside the real click. No fetch, await, timer,
        // iframe, invented scheme, or Android intent/store fallback.
        try { window.location.href = vpnKey; } catch {
          status.textContent = "Your browser blocked opening Outline. Copy the key and open Outline manually.";
        }
        // Browsers cannot reliably report whether a custom-scheme app opened.
        hintTimer = setTimeout(() => {
          if (isUsable()) status.textContent = "If Outline did not open, tap Open Outline or copy your VPN key.";
        }, 1800);
      }
      function legacyCopy() {
        const field = document.createElement("textarea");
        field.value = vpnKey;
        field.readOnly = true;
        field.className = "clipboard-buffer";
        field.setAttribute("aria-hidden", "true");
        document.body.appendChild(field);
        try {
          field.focus({ preventScroll: true });
          field.select();
          field.setSelectionRange(0, field.value.length);
          return document.execCommand("copy");
        } finally {
          field.remove();
          copyButton.focus({ preventScroll: true });
        }
      }
      openButton.addEventListener("click", openOutline);
      copyButton.addEventListener("click", async () => {
        if (!isUsable()) return;
        clearTimeout(hintTimer);
        try {
          if (!useLegacyCopy && navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(vpnKey);
          } else if (!legacyCopy()) {
            throw new Error("Copy unavailable");
          }
          if (isUsable()) status.textContent = "VPN key copied. Open Outline, add the copied key, then connect.";
        } catch {
          if (!isUsable()) return;
          // A rejected async clipboard call may consume user activation. The
          // next click performs the legacy copy synchronously with a new gesture.
          useLegacyCopy = true;
          status.textContent = "Copy was blocked. Tap Copy VPN Key again, or use Copy VPN Key in Telegram.";
        }
      });
      const ua = navigator.userAgent;
      const isAppleMobile = /iPhone|iPad|iPod/.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const help = document.getElementById("platform-help");
      if (isAppleMobile) {
        help.textContent = "In Safari, tap Open if asked. If nothing opens, tap Open Outline. Then tap Add / Connect.";
      } else if (/Android/.test(ua)) {
        help.textContent = "Chrome may require a tap on Open Outline. Choose Outline if asked, then tap Add / Connect.";
      } else if (/Windows/.test(ua)) {
        help.textContent = "Allow the browser to open Outline. If Windows asks for an app, choose Outline. Then add the key and connect.";
      } else if (/Mac/.test(ua)) {
        help.textContent = "Allow your browser to open Outline on your Mac, then add the key and connect.";
      }
      setTimeout(isUsable, Math.max(0, deadline - performance.now()));
      window.addEventListener("pageshow", isUsable);
      document.addEventListener("visibilitychange", isUsable);
      openOutline();
    })();
  </script>
</body>
</html>`;
}

app.get("/connect/:token", async (req, res) => {
  const nonce = crypto.randomBytes(18).toString("base64");
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  });
  if (!allowConnect(req.ip || req.socket.remoteAddress)) {
    res.set("Retry-After", "60");
    return res.status(429).type("text").send("Too many setup requests. Please try again shortly.");
  }
  // Never redirect an HTTP request with a bearer token or send it a VPN key.
  if (!req.secure) return res.status(400).type("text").send("Open the HTTPS setup link from My VPN in Telegram.");
  const invalidLink = () => res.status(410).type("text").send(
    "This setup link is invalid, expired, or unavailable. Return to My VPN in Telegram for a new link."
  );
  const payload = readConnectToken(req.params.token);
  if (!payload) return invalidLink();
  try {
    const subscription = await db.public.Subscription.where({ id: payload.subscriptionId }).first();
    if (payload.expiresAt <= Date.now() || !isSubscriptionActive(subscription) ||
        !isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey)) return invalidLink();
    const remainingMs = Math.min(payload.expiresAt,
      Number(Temporal.Instant.from(subscription.expiresAt).epochMilliseconds)) - Date.now();
    if (remainingMs <= 0) return invalidLink();
    return res.type("html").send(renderVpnConnectPage(subscription.vpnKey, nonce, remainingMs));
  } catch {
    console.error("VPN setup page could not be loaded.");
    return res.status(503).type("text").send("VPN setup is temporarily unavailable. Please try again from My VPN in Telegram.");
  }
});

let startupStage = "production config validation";

function safeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function logStartupFailure(error) {
  if (startupStage === "admin configuration") {
    const missing = /^(ADMIN_(?:EMAIL|PASSWORD_HASH|SESSION_SECRET)) is required\.$/
      .exec(error?.message || "");
    if (missing) {
      console.error("VPN Bot startup failed: missing", missing[1]);
      return;
    }
  }
  const code = safeDiagnosticCode(error?.code) ||
    safeDiagnosticCode(error?.cause?.code);
  const certificateFailure = startupStage === "Outline API connection" &&
    (code?.startsWith("OUTLINE_CERT_") ||
      /^Outline API certificate (?:fingerprint mismatch|is unavailable)\.$/.test(error?.message || ""));
  const response = error?.response;
  const providerData = response?.data;

  console.error("VPN Bot startup failed:", {
    stage: certificateFailure ? "certificate fingerprint verification" : startupStage,
    name: safeDiagnosticCode(error?.name),
    message: sanitizeDiagnosticMessage(error?.message),
    code,
    status: safeHttpStatus(response?.status ?? response?.error_code ?? error?.status),
    outlineCode: safeDiagnosticCode(providerData?.code),
    outlineMessage: sanitizeDiagnosticMessage(providerData?.message),
    outlineApiUrlPresent: Boolean(process.env.OUTLINE_API_URL),
    outlineCertSha256Present: Boolean(process.env.OUTLINE_API_CERT_SHA256),
  });
}

function isAdmin(ctx) {
  return ctx.from?.id != null && String(ctx.from.id) === ADMIN_TELEGRAM_ID &&
    ctx.chat?.type === "private" && String(ctx.chat.id) === ADMIN_TELEGRAM_ID;
}

function assertIdempotentProvisioningOrder(order) {
  // Pre-deployment orders may have an unrecorded random POST result. A saved
  // key is reused, but an unrecorded legacy create needs manual review.
  if (!/^VPN-I[a-f0-9]{32}$/.test(order.orderNumber || "")) {
    throw new Error("Legacy order requires manual provisioning review.");
  }
}

function formatInstant(instant) {
  if (!instant) return "N/A";

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(instant.epochMilliseconds)));
}

function isSubscriptionActive(subscription, now = Temporal.Now.instant()) {
  return Boolean(
    subscription &&
      subscription.status === "ACTIVE" &&
      !subscription.revokedAt &&
      subscription.expiresAt &&
      Temporal.Instant.compare(subscription.expiresAt, now) > 0
  );
}

function isValidOutlineAccessKey(value) {
  return typeof value === "string" && /^ss:\/\/\S+$/.test(value);
}

async function findCustomerSubscription(telegramId) {
  const customer = await db.public.Customer
    .where({ telegramId: String(telegramId) })
    .first();

  if (!customer) return { customer: null, subscription: null };

  const subscription = await db.public.Subscription
    .where({ customerId: customer.id })
    .first();

  return { customer, subscription };
}

function renewBuyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("♻️ Renew", "renew_vpn"), Markup.button.callback("🛡️ Buy VPN", "buy_vpn")],
    [Markup.button.callback("🎧 Help", "help")],
  ]);
}

function copyVpnKeyButton(vpnKey) {
  // Telegram CopyTextButton accepts at most 256 characters. Telegraf 4.16
  // passes this Bot API button through without a dedicated builder method.
  if (Array.from(vpnKey).length <= 256) {
    return {
      text: "Copy VPN Key",
      copy_text: { text: vpnKey },
    };
  }

  return Markup.button.callback("Copy VPN Key", "copy_vpn_key");
}

async function getUsableVpnSubscription(ctx) {
  const { customer, subscription } = await findCustomerSubscription(ctx.from.id);

  if (!customer || !subscription) {
    await ctx.reply(
      "🌐 My VPN\n\nVPN package မရှိသေးပါ။ Buy VPN ကိုနှိပ်ပြီး package ရွေးပါ။\nငွေပေးချေပြီး Admin အတည်ပြုရင် စသုံးနိုင်ပါမယ်။",
      buildMainMenu(ctx)
    );
    return null;
  }

  if (!isSubscriptionActive(subscription)) {
    await ctx.reply(
      "⏳ VPN သက်တမ်းကုန်နေပါပြီ သို့မဟုတ် လက်ရှိသုံးမရပါ။\n\nRenew ကိုနှိပ်ပြီး Data နဲ့ သက်တမ်း တိုးနိုင်ပါတယ်။ မူလ VPN key ကိုပဲ ဆက်သုံးပါမယ်။\nအကူအညီလိုရင် Help ကိုနှိပ်ပါ။",
      renewBuyKeyboard()
    );
    return null;
  }

  if (!isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey)) {
    await ctx.reply(
      "VPN key ကို လောလောဆယ် ရယူမရပါ။\nHelp → Contact Support ကိုနှိပ်ပြီး အကူအညီတောင်းပါ။",
      renewBuyKeyboard()
    );
    return null;
  }

  return subscription;
}

async function sendVpnSetup(ctx) {
  const subscription = await getUsableVpnSubscription(ctx);
  if (!subscription) return;

  await ctx.reply(
    "🛰️ Setup VPN\n\n" +
      "VPN ချိတ်ဆက်ဖို့ ဒီအဆင့်တွေကို လုပ်ပါ။\n" +
      "1️⃣ Copy VPN Key ကိုနှိပ်ပြီး key ကူးပါ\n2️⃣ Open Outline ကိုနှိပ်ပါ\n" +
      "3️⃣ Outline ထဲမှာ key ထည့်ပြီး Add ကိုနှိပ်ပါ\n4️⃣ Connect ကိုနှိပ်ရင် VPN စသုံးနိုင်ပါပြီ\n\n" +
      "Outline မပွင့်ရင် link ကို Safari / Chrome နဲ့ဖွင့်ပါ၊ ဒါမှမဟုတ် key ကို Outline ထဲ ကူးထည့်ပါ။\n" +
      "Link သက်တမ်း ၁၀ မိနစ်အတွင်း ကုန်ပါမယ်။ ကုန်သွားရင် My VPN → Setup VPN ကိုပြန်နှိပ်ပါ။ Key ကို မမျှဝေပါနဲ့။",
    Markup.inlineKeyboard([
      [copyVpnKeyButton(subscription.vpnKey), Markup.button.url("🧭 Open Outline", createVpnConnectUrl(subscription))],
      [Markup.button.callback("⬅️ Back", "my_vpn")],
    ])
  );
}

async function sendExistingVpnKey(ctx, actionTitle) {
  const { customer, subscription } = await findCustomerSubscription(ctx.from.id);

  if (!customer || !subscription) {
    await ctx.reply(
      "🌐 My VPN\n\nVPN package မရှိသေးပါ။ Buy VPN ကိုနှိပ်ပြီး package ရွေးပါ။\nငွေပေးချေပြီး Admin အတည်ပြုရင် စသုံးနိုင်ပါမယ်။",
      buildMainMenu(ctx)
    );
    return;
  }

  if (!isSubscriptionActive(subscription)) {
    await ctx.reply(
      "⏳ VPN သက်တမ်းကုန်နေပါပြီ သို့မဟုတ် လက်ရှိသုံးမရပါ။\n\nRenew ကိုနှိပ်ပြီး Data နဲ့ သက်တမ်း တိုးနိုင်ပါတယ်။ မူလ VPN key ကိုပဲ ဆက်သုံးပါမယ်။\nအကူအညီလိုရင် Help ကိုနှိပ်ပါ။",
      renewBuyKeyboard()
    );
    return;
  }

  if (
    !subscription.vpnKeyId ||
    !isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) ||
    !isValidOutlineAccessKey(subscription.vpnKey)
  ) {
    await ctx.reply(
      "VPN key ကို လောလောဆယ် ရယူမရပါ။\nHelp → Contact Support ကိုနှိပ်ပြီး အကူအညီတောင်းပါ။",
      renewBuyKeyboard()
    );
    return;
  }

  await ctx.reply(
    `${actionTitle}\n\nဒါက သင့်လက်ရှိ VPN key ပါ။ အောက်က key အပြည့်အစုံကို ကူးပါ။\n\n${subscription.vpnKey}\n\nOutline ထဲ ကူးထည့်ပြီး Add → Connect ကိုနှိပ်ရင် စသုံးနိုင်ပါပြီ။ Key ကို မမျှဝေပါနဲ့။`
  );
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

function formatUsageGb(value) {
  const gb = Number(value);
  return (Number.isFinite(gb) && gb >= 0 ? gb : 0)
    .toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatMmk(value) {
  return formatNumber(value);
}

function formatOrderStatus(status) {
  return {
    PENDING_PAYMENT: "ငွေပေးချေရန် / ငွေလွှဲပုံစစ်ဆေးရန် စောင့်နေသည်",
    PROCESSING: "VPN ဖွင့်ပေးနေသည် — ခဏစောင့်ပါ",
    PAID: "ငွေပေးချေပြီး — VPN ဖွင့်ပေးပြီးပြီ",
    PAYMENT_REJECTED: "ငွေပေးချေမှု အတည်မပြုနိုင်ပါ — Help မှ ဆက်သွယ်ပါ",
    CANCELLED: "မှာယူမှု ပယ်ဖျက်ထားသည်",
  }[status] || status;
}

// Keep text and keyboards separate so these screens can later use photo captions.
let telegramAdmin;
let navigation;
function buildMainMenu(ctx) {
  return buildCustomerMenu(Boolean(ctx && isAdmin(ctx) && ctx.chat?.type === "private"),
    telegramAdmin?.customerAdminRows());
}

function buildMetroMenuButton() {
  return {
    type: "web_app",
    text: "Metro",
    web_app: { url: `${getConnectConfig().baseUrl}/app` },
  };
}

function compactButtonRows(buttons) {
  const rows = [];
  for (const button of buttons) {
    const last = rows[rows.length - 1];
    if (last?.length === 1 && Array.from(last[0].text).length <= 20 &&
        Array.from(button.text).length <= 20) {
      last.push(button);
    } else {
      rows.push([button]);
    }
  }
  return rows;
}

function packageSelectionLabel(pkg) {
  const icon = {
    basic: "🛡️",
    standard: "🔷",
    premium: "💎",
  }[pkg.name.trim().toLowerCase()] || "🛡️";
  return `${icon} ${pkg.name}`;
}

function formatPackageSelection(packages) {
  const summary = packages.map((pkg) =>
    `${packageSelectionLabel(pkg)} • ${formatNumber(pkg.dataLimitGb)} GB` +
    ` • ${pkg.durationDays} Days • ${formatMmk(pkg.priceMmk)}`
  ).join("\n");
  return `💎 Choose Your VPN Package\n\nသင့်အတွက် package ကိုရွေးပါ 👇\n\n${summary}`;
}

function buildPackageKeyboard(packages, isRenewal = false) {
  const buttons = packages.map((pkg) => Markup.button.callback(
    isRenewal
      ? (/premium/i.test(pkg.name) ? `💎 ${pkg.name}` : pkg.name)
      : packageSelectionLabel(pkg),
    `${isRenewal ? "renew_package" : "package"}_${pkg.id}`
  ));
  return Markup.inlineKeyboard([
    ...compactButtonRows(buttons),
    [Markup.button.callback("⬅️ Back", isRenewal ? "my_vpn" : "back_to_start")],
  ]);
}

function formatPackageDetails(pkg, isRenewal = false) {
  const title = /\bplan$/i.test(pkg.name) ? pkg.name : `${pkg.name} Plan`;
  return `💎 ${title.toUpperCase()}\n\n` +
    `📡 အသုံးပြုနိုင်သော Data: ${formatNumber(pkg.dataLimitGb)} GB\n` +
    `⏳ သက်တမ်း: ${pkg.durationDays} ရက်\n` +
    `🧾 ဈေးနှုန်း: ${formatMmk(pkg.priceMmk)}\n\n` +
    "Outline VPN ကို Android / iPhone / iPad / Windows / macOS မှာ သုံးနိုင်ပါတယ်။\n" +
    "ကိုယ်ပိုင် VPN key ရပါမယ်။ သက်တမ်းတိုးရင် မူလ key ကိုပဲ ဆက်သုံးပါမယ်။\n\n" +
    (isRenewal
      ? "Renew This Plan ကိုနှိပ်ပြီး သက်တမ်းတိုးမယ့် အချက်အလက်တွေကို အတည်ပြုပါ။\n"
      : "Buy This Plan ကိုနှိပ်ရင် မှာယူမှုအတည်ပြုမယ့် စာမျက်နှာကို ရောက်ပါမယ်။\n") +
    "ပိုကြာကြာသုံးချင်ရင် အောက်က ရက်အရေအတွက်ခလုတ်ကို ရွေးပါ။";
}

function buildPackageDetailKeyboard(pkg, isRenewal = false) {
  const prefix = isRenewal ? "renew_duration" : "duration";
  return Markup.inlineKeyboard([
    [Markup.button.callback(isRenewal ? "♻️ Renew This Plan" : "🧾 Buy This Plan", `${prefix}_${pkg.id}_1`)],
    // Retain the existing multi-month purchases with database-derived day counts.
    [3, 6].map((months) => Markup.button.callback(
      `⏳ ${Number(pkg.durationDays) * months} Days`, `${prefix}_${pkg.id}_${months}`
    )),
    [Markup.button.callback("⬅️ Back", isRenewal ? "renew_vpn" : "buy_vpn")],
  ]);
}

function formatPurchaseConfirmation(pkg, durationMonths, isRenewal = false) {
  const { totalDataGb, totalPriceMmk, durationDays } = calculatePackage(pkg, durationMonths);
  return `🧾 ${isRenewal ? "သက်တမ်းတိုးမှု" : "မှာယူမှု"} အတည်ပြုပါ\n\n` +
    `Package: ${pkg.name}\n📡 ${isRenewal ? "ထပ်တိုးမယ့် Data" : "Data"}: ${formatNumber(totalDataGb)} GB\n` +
    `⏳ ${isRenewal ? "ထပ်တိုးမယ့် သက်တမ်း" : "သက်တမ်း"}: ${durationDays} ရက်\n🧾 ဈေးနှုန်း: ${formatMmk(totalPriceMmk)}\n\n` +
    (isRenewal ? "မူလ VPN key ကိုပဲ ဆက်သုံးပြီး Data နဲ့ သက်တမ်းကို တိုးပေးပါမယ်။\n" : "") +
    `အချက်အလက်မှန်ရင် ${isRenewal ? "Confirm Renewal" : "Confirm Purchase"} ကိုနှိပ်ပါ။\n` +
    "ငွေပေးချေမယ့် စာမျက်နှာကို ရောက်ပါမယ်။ ပြန်ရွေးချင်ရင် ← Back ကိုနှိပ်ပါ။";
}

function buildConfirmationKeyboard(pkg, durationMonths, isRenewal = false) {
  const version = packageVersion(pkg);
  return Markup.inlineKeyboard([
    [Markup.button.callback(isRenewal ? "Confirm Renewal" : "Confirm Purchase",
      `${isRenewal ? "confirm_renewal" : "confirm_package"}_${pkg.id}_${durationMonths}_${version}`)],
    [Markup.button.callback("⬅️ Back", `${isRenewal ? "renew_package" : "package"}_${pkg.id}`)],
  ]);
}

function buildMyVpnKeyboard(subscription, activated = false) {
  const hasKey = isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey);
  return Markup.inlineKeyboard([
    hasKey
      ? [Markup.button.callback("🛰️ Setup VPN", "setup_vpn"), copyVpnKeyButton(subscription.vpnKey)]
      : [Markup.button.callback("🎧 Help", "help")],
    [activated ? Markup.button.callback("🌐 My VPN", "my_vpn") : Markup.button.callback("♻️ Renew", "renew_vpn"),
      Markup.button.callback("🗂️ My Orders", "my_orders")],
  ]);
}

function formatActivation(pkg, dataLimitGb, expiresAt, isRenewal = false) {
  return `🌐 VPN ${isRenewal ? "သက်တမ်းတိုးပြီးပါပြီ" : "အဆင်သင့်ဖြစ်ပါပြီ"}\n\n` +
    `Package: ${pkg.name}\n📡 စုစုပေါင်း Data: ${formatNumber(dataLimitGb)} GB\n` +
    `⏳ သက်တမ်းကုန်ရက်: ${formatInstant(expiresAt)}\nအခြေအနေ: အသုံးပြုနိုင်ပါပြီ\n\n` +
    (isRenewal ? "Data နဲ့ သက်တမ်း တိုးပေးပြီးပါပြီ။ လက်ရှိ VPN key နဲ့ ဆက်သုံးနိုင်ပါတယ်။\n" : "") +
    "Setup VPN ကိုနှိပ်ပါ။ Key ထည့်နည်းကို တစ်ဆင့်ချင်းပြပေးပြီး Outline မှာ Connect လုပ်နိုင်ပါမယ်။";
}

function buildHelpKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💬 Contact Support", "contact_support")],
    [Markup.button.callback("⬅️ Back", "back_to_start")],
  ]);
}

function buildPaymentKeyboard(order) {
  const callbacks = { bank_transfer: "bank", mobile_wallet: "wallet" };
  return Markup.inlineKeyboard([
    ...compactButtonRows(Object.entries(PAYMENT_METHODS)
      .filter(([method]) => callbacks[method])
      .map(([method, payment]) => Markup.button.callback(payment.name, `payment_${callbacks[method]}_${order.id}`))),
    [Markup.button.callback("Cancel Order", `cancel_order_${order.id}`), Markup.button.callback("🎧 Help", "payment_help")],
  ]);
}

function formatPayment(order) {
  return `🧾 Payment — ငွေပေးချေပါ\n\nမှာယူမှု: ${order.orderNumber}\nPackage: ${order.plan}\n` +
    `ပေးချေရန်: ${formatMmk(order.price)}\n\n` +
    "1️⃣ အောက်က ငွေပေးချေနည်းခလုတ်တစ်ခုကို နှိပ်ပါ\n" +
    "2️⃣ ပေါ်လာမယ့် အကောင့်ကို ငွေပမာဏအတိအကျ လွှဲပါ\n" +
    "3️⃣ ငွေလွှဲပြီးကြောင်း screenshot ကို ဒီ chat မှာ ပုံအဖြစ်ပို့ပါ\n" +
    "4️⃣ Admin စစ်ဆေးအတည်ပြုတာကို စောင့်ပါ\n\nအတည်ပြုပြီးရင် VPN အဆင်သင့်ဖြစ်ကြောင်းနဲ့ Setup လုပ်နည်းကို ပို့ပေးပါမယ်။";
}

function getDurationLabel(months) {
  return `${months} Month${months > 1 ? "s" : ""}`;
}

function calculatePackage(pkg, durationMonths) {
  const totalDataGb =
    Number(pkg.dataLimitGb) * durationMonths;

  const totalPriceMmk =
    Number(pkg.priceMmk) * durationMonths;

  const durationDays =
    Number(pkg.durationDays) * durationMonths;

  return {
    totalDataGb,
    totalPriceMmk,
    durationDays,
  };
}

function packageVersion(pkg) {
  // The callback carries a fingerprint, never business values. Always re-read
  // the Package row and compare before writing an order.
  return crypto.createHash("sha256").update(JSON.stringify([
    pkg.id, pkg.name, Number(pkg.dataLimitGb), Number(pkg.durationDays),
    String(pkg.priceMmk), pkg.active,
  ])).digest("hex").slice(0, 16);
}

function unavailablePackageKeyboard(isRenewal = false) {
  return Markup.inlineKeyboard([[
    Markup.button.callback("⬅️ Back", isRenewal ? "renew_vpn" : "buy_vpn"),
  ]]);
}

async function replyUnavailablePackage(ctx, isRenewal = false) {
  return ctx.reply("ဒီ package ကို လောလောဆယ် မရနိုင်တော့ပါ။\nPackage အသစ်ရွေးပေးပါ။",
    unavailablePackageKeyboard(isRenewal));
}

function gbToBytes(gb) {
  const bytes = Number(gb) * GB_IN_BYTES;

  if (!Number.isFinite(bytes)) {
    throw new Error(
      `Invalid GB value: ${gb}`
    );
  }

  if (!Number.isInteger(bytes)) {
    throw new Error(
      `GB value must convert to an integer byte value: ${gb}`
    );
  }

  if (bytes < 0) {
    throw new Error(
      `GB value must be non-negative: ${gb}`
    );
  }

  return bytes;
}

function isReusableAccessKey(keyId, vpnKey) {
  return Boolean(
    keyId &&
    !String(keyId).startsWith("mock-") &&
    isValidOutlineAccessKey(vpnKey)
  );
}

async function persistReplacementAccessKey(order, subscription, accessKey, createdAt) {
  // The order is the retry checkpoint if the subscription write fails.
  await db.public.Order
    .where({ id: order.id, status: "PROCESSING" })
    .update({
      vpnKey: accessKey.accessUrl,
      vpnKeyId: accessKey.id,
      vpnKeyCreatedAt: createdAt,
    });

  order.vpnKey = accessKey.accessUrl;
  order.vpnKeyId = accessKey.id;
  order.vpnKeyCreatedAt = createdAt;

  if (subscription) {
    await db.public.Subscription
      .where({ id: subscription.id })
      .update({
        vpnKey: accessKey.accessUrl,
        vpnKeyId: accessKey.id,
        vpnKeyCreatedAt: createdAt,
      });

    subscription.vpnKey = accessKey.accessUrl;
    subscription.vpnKeyId = accessKey.id;
    subscription.vpnKeyCreatedAt = createdAt;
  }
}

/**
 * Recover orders stuck in PROCESSING.
 *
 * IMPORTANT:
 * If an Outline key was already created, the approval
 * handler will reuse the existing key instead of creating
 * another one.
 */
async function recoverStuckProcessingOrders() {
  if (!db) return;

  try {
    const now = Temporal.Now.instant();

    const processingOrders =
      await db.public.Order
        .where({
          status: "PROCESSING",
        })
        .all();

    if (!processingOrders.length) {
      return;
    }

    for (const order of processingOrders) {
      if (!order.processingAt) {
        console.log(
          `Processing order ${order.orderNumber} has no processingAt timestamp. Skipping recovery.`
        );

        continue;
      }

      let ageMinutes;
      try {
        const processingAt = Temporal.Instant.from(order.processingAt);
        ageMinutes = Number(now.epochMilliseconds - processingAt.epochMilliseconds) / 60000;
      } catch {
        console.warn(`Processing order ${order.orderNumber} has an invalid processingAt timestamp. Skipping recovery.`);
        continue;
      }

      if (!Number.isFinite(ageMinutes) || ageMinutes < 0) {
        console.warn(`Processing order ${order.orderNumber} has an invalid processingAt timestamp. Skipping recovery.`);
        continue;
      }

      if (
        ageMinutes <
        PROCESSING_TIMEOUT_MINUTES
      ) {
        continue;
      }

      const recoveredOrders =
        await db.public.Order
          .where({
            id: order.id,
            status: "PROCESSING",
          })
          .updateAll({
            status: "PENDING_PAYMENT",
            processingAt: null,
          });

      if (recoveredOrders.length > 0) {
        console.log(
          `Recovered stuck order ${order.orderNumber}. It was PROCESSING for ${Math.floor(
            ageMinutes
          )} minutes.`
        );
      }
    }
  } catch {
    console.error("PROCESSING recovery failed.");
  }
}

function startProcessingRecovery() {
  setInterval(
    () => recoverStuckProcessingOrders(),
    RECOVERY_INTERVAL_MS
  );

  console.log(
    `PROCESSING recovery enabled. Timeout: ${PROCESSING_TIMEOUT_MINUTES} minutes.`
  );
}

async function syncAccessKeyUsage() {
  if (!db || usageSyncRunning) return;
  usageSyncRunning = true;

  try {
    const usageByKeyId = await getAllAccessKeyUsage();
    const existingKeyIds = await getExistingAccessKeyIds();
    const subscriptions = await db.public.Subscription.where({ status: "ACTIVE" }).all();
    let updated = 0;
    let skipped = 0;

    for (const subscription of subscriptions) {
      const keyId = subscription.vpnKeyId;
      if (!keyId || String(keyId).startsWith("mock-") ||
          subscription.revokedAt || !existingKeyIds.has(String(keyId))) {
        skipped++;
        continue;
      }

      // Outline omits existing keys with no traffic from the transfer map.
      const bytes = Object.hasOwn(usageByKeyId, String(keyId))
        ? usageByKeyId[String(keyId)] : 0;
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        skipped++;
        continue;
      }

      try {
        // Match the same 1024^3 GB unit used for Outline data limits.
        const dataUsedGb = bytes / GB_IN_BYTES;
        const changed = await db.public.Subscription
          .where({ id: subscription.id, vpnKeyId: keyId, status: "ACTIVE" })
          .updateAll({ dataUsedGb });
        updated += changed.length;
      } catch {
        skipped++;
      }
    }

    console.log(`Outline usage sync completed: ${updated} updated, ${skipped} skipped.`);
  } catch (error) {
    // Axios errors can contain the management URL and credentials. Log only a
    // numeric HTTP status, never the error object or its request config.
    console.error("Outline usage sync failed.", {
      status: safeHttpStatus(error?.response?.status),
    });
  } finally {
    usageSyncRunning = false;
  }
}

function startUsageSync() {
  void syncAccessKeyUsage();
  usageSyncTimer = setInterval(() => { void syncAccessKeyUsage(); }, USAGE_SYNC_INTERVAL_MS);
  console.log("Outline usage sync enabled (every 15 minutes).");
}

async function sendMainMenu(ctx) {
  navigation?.reset(ctx);
  await ctx.reply(
    "👋 Metro VPN မှ ကြိုဆိုပါတယ်\n\n" +
      "VPN စသုံးဖို့ အဆင့် ၃ ဆင့်ပဲ လိုပါတယ်။\n" +
      "1️⃣ Package ရွေးပါ\n2️⃣ ငွေပေးချေပြီး screenshot ပို့ပါ\n3️⃣ Admin အတည်ပြုပြီးရင် VPN Setup လုပ်ပါ\n\n" +
      "စဝယ်ဖို့ Buy VPN ကိုနှိပ်ပါ။ Package အသေးစိတ်ကို အရင်ကြည့်နိုင်ပါတယ်။\nဝယ်ပြီးသားဆိုရင် My VPN မှာ စစ်ကြည့်ပါ။",
    buildMainMenu(ctx)
  );
  if (ctx.chat?.type === "private") {
    await ctx.reply("Choose an option below.", isAdmin(ctx)
      ? buildPersistentAdminKeyboard() : buildPersistentCustomerKeyboard());
  }
}

async function getActivePackages() {
  const packages = await db.public.Package
    .where({
      active: true,
    })
    .all();
  return packages.sort((a, b) =>
    Number(a.sortOrder) - Number(b.sortOrder) || Number(a.id) - Number(b.id));
}

async function getPackageById(packageId) {
  return await db.public.Package
    .where({
      id: packageId,
      active: true,
    })
    .first();
}

async function createPackageOrder(
  ctx,
  packageId,
  durationMonths,
  isRenewal = false,
  confirmedVersion = null
) {
  try {
    const pkg =
      await getPackageById(packageId);

    if (!pkg) {
      return replyUnavailablePackage(ctx, isRenewal);
    }

    if (confirmedVersion !== packageVersion(pkg)) {
      return await ctx.reply(
        "Package အချက်အလက် ပြောင်းထားပါတယ်။ အောက်က လက်ရှိဈေးနှုန်းနဲ့ Data ကို ပြန်စစ်ပြီး အတည်ပြုပေးပါ။\n\n" +
          formatPurchaseConfirmation(pkg, durationMonths, isRenewal),
        buildConfirmationKeyboard(pkg, durationMonths, isRenewal)
      );
    }

    const {
      totalDataGb,
      totalPriceMmk,
      durationDays,
    } = calculatePackage(
      pkg,
      durationMonths
    );

    const customer =
      await db.public.Customer.upsert({
        conflictOn: {
          telegramId: true,
        },

        create: {
          telegramId: String(ctx.from.id),
          username:
            ctx.from.username || null,
          firstName:
            ctx.from.first_name || null,
        },

        update: {
          username:
            ctx.from.username || null,
          firstName:
            ctx.from.first_name || null,
        },
      });

    if (isRenewal) {
      const subscription =
        await db.public.Subscription
          .where({
            customerId: customer.id,
          })
          .first();

      if (!subscription) {
        return await ctx.reply(
          "VPN package မရှိသေးလို့ သက်တမ်းတိုးမရသေးပါ။\n/start → Buy VPN ကိုနှိပ်ပြီး package အရင်ဝယ်ပါ။"
        );
      }
    }

    const plan =
      `${pkg.name} - ${getDurationLabel(
        durationMonths
      )}`;

    // One confirmation message identifies one order, including after a restart.
    // The existing unique orderNumber constraint makes concurrent presses atomic.
    const confirmation = ctx.callbackQuery?.message;
    if (!confirmation?.chat?.id || !confirmation.message_id) {
      return await ctx.reply("မှာယူမှုကို ပြန်စဖို့ Buy VPN ကိုနှိပ်ပြီး package ပြန်ရွေးပါ။", buildMainMenu(ctx));
    }
    const purchaseId = crypto.createHash("sha256").update(JSON.stringify([
      String(ctx.from.id), confirmation.chat.id, confirmation.message_id,
      pkg.id, durationMonths, isRenewal, confirmedVersion,
    ])).digest("hex").slice(0, 32);
    const legacyOrder = await db.public.Order.where({ orderNumber: `VPN-${purchaseId}` }).first();
    if (legacyOrder) {
      if (legacyOrder.status === "PENDING_PAYMENT") {
        await ctx.reply(formatPayment(legacyOrder), buildPaymentKeyboard(legacyOrder));
      } else {
        await ctx.reply(`🗂️ မှာယူမှု: ${legacyOrder.orderNumber}\nအခြေအနေ: ${formatOrderStatus(legacyOrder.status)}\n\nဒီမှာယူမှုကို ထပ်အတည်ပြုစရာ မလိုပါ။ အသေးစိတ်ကြည့်ဖို့ My Orders ကိုနှိပ်ပါ။`, buildMainMenu(ctx));
      }
      return legacyOrder;
    }
    const orderNumber = `VPN-I${purchaseId}`;
    // A new confirmation message can have a different ID even when it repeats
    // the same purchase. Reuse its recent pending order and keep renewals after
    // a completed payment available.
    const recentPending = await db.public.Order.where({
      customerId: customer.id, packageId: pkg.id, durationMonths,
      status: "PENDING_PAYMENT",
    }).orderBy((row) => row.createdAt.desc()).first();
    const pendingAt = recentPending?.createdAt?.epochMilliseconds === undefined
      ? new Date(recentPending?.createdAt).getTime()
      : Number(recentPending.createdAt.epochMilliseconds);
    if (recentPending && recentPending.plan === plan &&
        Number(recentPending.price) === Number(totalPriceMmk) &&
        Number.isFinite(pendingAt) && Date.now() - pendingAt < 60000) {
      await ctx.reply(formatPayment(recentPending), buildPaymentKeyboard(recentPending));
      return recentPending;
    }
    const confirmationKey = `${ctx.from.id}:${confirmation.chat.id}:${confirmation.message_id}`;
    const now = Date.now();
    if (recentConfirmations.size > 10000) {
      for (const [key, until] of recentConfirmations) if (until <= now) recentConfirmations.delete(key);
      if (recentConfirmations.size > 10000) recentConfirmations.delete(recentConfirmations.keys().next().value);
    }
    if (!recentConfirmations.has(confirmationKey) && !allowNewOrder(ctx.from.id, now)) {
      await ctx.reply("Please wait a minute before creating another order. Your existing order is in My Orders.");
      return;
    }
    recentConfirmations.set(confirmationKey, now + 60000);
    const order = await db.public.Order.upsert({
      conflictOn: { orderNumber: true },
      create: {
        orderNumber, plan, packageId: pkg.id, durationMonths, totalDurationDays: durationDays,
        totalDataGb, price: totalPriceMmk, status: "PENDING_PAYMENT", customerId: customer.id,
      },
      update: { orderNumber },
    });

    if (order.status !== "PENDING_PAYMENT") {
      await ctx.reply(
        `🗂️ မှာယူမှု: ${order.orderNumber}\nအခြေအနေ: ${formatOrderStatus(order.status)}\n\nဒီမှာယူမှုကို ထပ်အတည်ပြုစရာ မလိုပါ။ အသေးစိတ်ကြည့်ဖို့ My Orders ကိုနှိပ်ပါ။`,
        buildMainMenu(ctx)
      );
      return order;
    }

    await ctx.reply(formatPayment(order), buildPaymentKeyboard(order));
    return order;
  } catch (error) {
    console.error("Create package order failed.");

    await ctx.reply(
      "မှာယူမှုကို အပြီးသတ်မလုပ်နိုင်သေးပါ။\nခဏစောင့်ပြီး မူလ Confirm ခလုတ်ကို ပြန်နှိပ်ပါ။ ထပ်ဖြစ်ရင် /start → Help မှ ဆက်သွယ်ပါ။"
    );
  }
}

async function miniAppOwnedOrder(telegramId, orderNumber) {
  const { customer } = await findCustomerSubscription(telegramId);
  if (!customer) return null;
  return db.public.Order.where({ customerId: customer.id, orderNumber }).first();
}

function proofReviewKeyboard(order) {
  return Markup.inlineKeyboard([[
    Markup.button.callback("✅ Approve", `approve_payment_${order.id}`),
    Markup.button.callback("❌ Reject", `reject_payment_${order.id}`),
  ]]);
}

async function sendAdminProofReview(order, photo, deferActions = false) {
  const customer = await db.public.Customer.where({ id: order.customerId }).first();
  const pkg = order.packageId ? await db.public.Package.where({ id: order.packageId }).first() : null;
  const caption =
    `💰 PAYMENT VERIFICATION\n\n` +
    `Order: ${order.orderNumber}\n` +
    `Package: ${pkg?.name || order.plan}\n` +
    `Duration: ${getDurationLabel(order.durationMonths || 1)}\n` +
    `Data: ${formatNumber(order.totalDataGb || 0)} GB\n` +
    `Price: ${formatMmk(order.price)}\n\n` +
    `Customer: ${customer?.firstName || "N/A"}\n` +
    `Username: @${customer?.username || "N/A"}\n` +
    `Telegram ID: ${customer?.telegramId || "N/A"}`;
  return bot.telegram.sendPhoto(ADMIN_TELEGRAM_ID, photo, {
    caption, ...(deferActions ? {} : proofReviewKeyboard(order)),
  });
}

async function miniAppCreateOrder(telegramUser, _account, packageId, confirmedVersion) {
  const { customer, subscription } = await findCustomerSubscription(telegramUser.id);
  if (!customer) return null;
  const isRenewal = isSubscriptionActive(subscription);
  for (const status of ["PENDING_PAYMENT", "PROCESSING"]) {
    const current = await db.public.Order.where({ customerId: customer.id, status })
      .orderBy((order) => order.createdAt.desc()).first();
    const created = current?.createdAt?.epochMilliseconds === undefined
      ? new Date(current?.createdAt).getTime() : Number(current.createdAt.epochMilliseconds);
    if (current && Number.isFinite(created) && Date.now() - created < 24 * 60 * 60 * 1000)
      return { order: current, inProgress: true };
  }
  // The existing order helper uses a Telegram confirmation message to derive
  // an idempotent purchase ID. A stable minute bucket provides that identity
  // for Mini App confirmations, including concurrent taps and retries.
  const confirmationMinute = Math.floor(Date.now() / 60000);
  const ctx = {
    from: telegramUser,
    chat: { id: telegramUser.id, type: "private" },
    callbackQuery: { message: { chat: { id: telegramUser.id }, message_id: confirmationMinute } },
    async reply() {},
  };
  const order = await createPackageOrder(ctx, packageId, 1, isRenewal, confirmedVersion);
  if (order) return { order, inProgress: false };
  const latest = await getPackageById(packageId);
  return latest && packageVersion(latest) !== confirmedVersion
    ? { changed: true } : { order: null };
}

const supportEvents = createSupportEvents(process.env.BOT_TOKEN);
const miniAppRouter = createMiniAppRouter({
  botToken: process.env.BOT_TOKEN,
  supportEvents,
  getSupportService: () => miniAppSupportService,
  async getAccount(telegramId, telegramUser) {
    const { customer, subscription } = await findCustomerSubscription(telegramId);
    const active = isSubscriptionActive(subscription);
    const expired = Boolean(subscription?.expiresAt &&
      Temporal.Instant.compare(subscription.expiresAt, Temporal.Now.instant()) <= 0);
    const configuredLabel = process.env.VPN_SERVER_LABEL || process.env.VPN_REGION || "";
    const serverLabel = /^[\p{L}][\p{L}\p{N} '-]{0,39}$/u.test(configuredLabel)
      ? configuredLabel : "VPN server";
    return {
      customerExists: Boolean(customer),
      hasSubscription: Boolean(subscription),
      status: subscription?.revokedAt ? "REVOKED" : active ? "ACTIVE" :
        expired ? "EXPIRED" : subscription ? "INACTIVE" : "NONE",
      displayName: customer?.firstName || telegramUser?.first_name || null,
      plan: subscription?.plan || null,
      dataUsedGb: subscription?.dataUsedGb ?? null,
      dataLimitGb: subscription?.dataLimitGb ?? null,
      startedAt: subscription?.startedAt?.toString() || null,
      expiresAt: subscription?.expiresAt?.toString() || null,
      serverLabel,
      usageSyncedAt: null,
      canConnect: active && isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) &&
        isValidOutlineAccessKey(subscription.vpnKey),
    };
  },
  async getPackages() {
    return (await getActivePackages()).map((pkg) => ({
      id: pkg.id, name: pkg.name, dataLimitGb: pkg.dataLimitGb,
      durationDays: pkg.durationDays, priceMmk: Number(pkg.priceMmk),
      version: packageVersion(pkg),
    }));
  },
  async getPackage(packageId) {
    const pkg = await getPackageById(packageId);
    return pkg ? { id: pkg.id, name: pkg.name, dataLimitGb: pkg.dataLimitGb,
      durationDays: pkg.durationDays, priceMmk: Number(pkg.priceMmk),
      version: packageVersion(pkg) } : null;
  },
  createOrder: miniAppCreateOrder,
  getOrder: miniAppOwnedOrder,
  async getOrders(telegramId) {
    const { customer } = await findCustomerSubscription(telegramId);
    if (!customer) return [];
    return db.public.Order.where({ customerId: customer.id })
      .orderBy((order) => order.createdAt.desc()).limit(20).all();
  },
  async getPaymentMethods() {
    return Object.entries(PAYMENT_METHODS)
      .filter(([code, method]) => MINI_PAYMENT_CALLBACKS[code] && method.name &&
        method.accountName && method.accountNumber &&
        !String(method.accountName).startsWith("YOUR_") &&
        !String(method.accountNumber).startsWith("YOUR_"))
      .map(([code, method]) => ({ code, name: method.name,
        accountName: method.accountName, accountNumber: method.accountNumber }));
  },
  async selectPaymentMethod(telegramId, orderNumber, methodCode) {
    const method = PAYMENT_METHODS[methodCode];
    if (!MINI_PAYMENT_CALLBACKS[methodCode] || !method || !method.accountName || !method.accountNumber ||
        String(method.accountName).startsWith("YOUR_") ||
        String(method.accountNumber).startsWith("YOUR_")) return null;
    const order = await miniAppOwnedOrder(telegramId, orderNumber);
    if (!order || order.status !== "PENDING_PAYMENT" || order.paymentProof) return null;
    const updated = await db.public.Order.where({ id: order.id, customerId: order.customerId,
      status: "PENDING_PAYMENT" }).update({ paymentMethod: methodCode });
    if (!updated) return null;
    return updated;
  },
  async handoffProof(telegramId, orderNumber) {
    const order = await miniAppOwnedOrder(telegramId, orderNumber);
    if (!order || order.status !== "PENDING_PAYMENT" || !MINI_PAYMENT_CALLBACKS[order.paymentMethod] ||
        order.paymentProof) return false;
    await miniAppSupportService.pauseCustomer(telegramId);
    pendingProofs.set(String(telegramId), order.id);
    await bot.telegram.sendMessage(telegramId,
      `🧾 Order ${order.orderNumber}\n\nSend your payment screenshot as a photo in this chat. Admin review starts after your proof is received.`,
      Markup.inlineKeyboard([[
        Markup.button.callback(`Use ${PAYMENT_METHODS[order.paymentMethod].name}`,
          `payment_${MINI_PAYMENT_CALLBACKS[order.paymentMethod]}_${order.id}`),
        Markup.button.callback("🗂️ My Orders", "my_orders"),
      ]]));
    return true;
  },
  async uploadProof(telegramId, orderNumber, image, mimeType) {
    const order = await miniAppOwnedOrder(telegramId, orderNumber);
    if (!order) return null;
    if (order.paymentProof) return { already: true, order };
    if (order.status !== "PENDING_PAYMENT" || !order.paymentMethod) return null;
    if (order.paymentReference) return { busy: true };
    const reservation = `MINI_UPLOAD_V1:${crypto.randomUUID()}`;
    const claimed = await db.public.Order.where({
      id: order.id, customerId: order.customerId, status: "PENDING_PAYMENT",
      paymentProof: null, paymentReference: null,
    }).updateAll({ paymentReference: reservation });
    if (!claimed.length) {
      const latest = await miniAppOwnedOrder(telegramId, orderNumber);
      return latest?.paymentProof ? { already: true, order: latest } : { busy: true };
    }
    // Keep the reservation if Telegram accepted the photo but the response or
    // database write fails. Retrying must never send another admin proof.
    let sent;
    try {
      sent = await sendAdminProofReview(order,
        Input.fromBuffer(image, mimeType === "image/png" ? "proof.png" : "proof.jpg"), true);
    } catch (error) {
      // Telegram 4xx responses mean the photo was rejected before storage.
      // Transport failures are ambiguous, so retain the reservation.
      if ([400, 413, 429].includes(Number(error?.response?.error_code))) {
        await db.public.Order.where({ id: order.id, customerId: order.customerId,
          paymentProof: null, paymentReference: reservation })
          .updateAll({ paymentReference: null });
      }
      throw error;
    }
    const fileId = sent?.photo?.at(-1)?.file_id;
    if (typeof fileId !== "string" || !fileId) throw new Error("Telegram photo reference unavailable.");
    const saved = await db.public.Order.where({
      id: order.id, customerId: order.customerId, status: "PENDING_PAYMENT",
      paymentProof: null, paymentReference: reservation,
    }).updateAll({ paymentProof: fileId, paymentReference: null });
    if (!saved.length) throw new Error("Payment proof reservation changed.");
    try {
      await bot.telegram.editMessageReplyMarkup(ADMIN_TELEGRAM_ID, sent.message_id,
        undefined, proofReviewKeyboard(order).reply_markup);
    } catch {
      // The protected admin order page can still review the stored proof.
      console.error("Mini App proof review buttons unavailable.");
    }
    return { order: saved[0] };
  },
  async getConnectUrl(telegramId) {
    if (!allowMiniConnect(telegramId)) return null;
    const { subscription } = await findCustomerSubscription(telegramId);
    if (!isSubscriptionActive(subscription) ||
        !isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) ||
        !isValidOutlineAccessKey(subscription.vpnKey)) return null;
    return createVpnConnectUrl(subscription);
  },
  async sendBotFlow(telegramId, flow, packageId) {
    if (!allowMiniFlow(telegramId)) throw new Error("Too many requests");
    if (flow === "support") {
      await bot.telegram.sendMessage(telegramId,
        "🎧 Help\n\nTap Contact Support to message the Metro Secure team.",
        buildHelpKeyboard());
      return;
    }
    const packages = await getActivePackages();
    if (!packages.length) throw new Error("No packages");
    const selected = packageId === undefined ? null : packages.find((pkg) => pkg.id === packageId);
    if (packageId !== undefined && !selected) throw new Error("Package unavailable");
    if (flow === "renew") {
      const { subscription } = await findCustomerSubscription(telegramId);
      if (!subscription) throw new Error("No subscription");
    }
    const isRenewal = flow === "renew";
    await bot.telegram.sendMessage(telegramId,
      selected ? formatPackageDetails(selected, isRenewal) :
        isRenewal ? "♻️ Choose a package to renew your VPN." : formatPackageSelection(packages),
      selected ? buildPackageDetailKeyboard(selected, isRenewal) :
        buildPackageKeyboard(packages, isRenewal));
  },
});
app.get("/app", (req, res, next) => {
  if (req.path === "/app") return res.redirect(302, "app/");
  next();
});
app.use("/app", miniAppRouter);
app.use("/mini-app", miniAppRouter);

async function startBot() {
  console.log("Starting VPN Bot...");

  startupStage = "production config validation";
  console.log("DATABASE_URL configured:", process.env.DATABASE_URL ? "yes" : "no");
  validateOutlineConfig();
  const connectConfig = getConnectConfig();

  startupStage = "admin configuration";
  const adminConfig = validateAdminConfig();
  app.use("/admin", createAdminRouter({
    ...adminConfig,
    expectedOrigin: new URL(connectConfig.baseUrl).origin,
    getOperationalStatus: () => ({
      databaseConnected: Boolean(db),
      usageWorkerEnabled: Boolean(usageSyncTimer),
      usageSyncRunning,
      usageIntervalMinutes: USAGE_SYNC_INTERVAL_MS / 60000,
      processingRecoveryMinutes: PROCESSING_TIMEOUT_MINUTES,
    }),
  }));

  startupStage = "Outline API connection";
  await testOutlineConnection();
  console.log("Outline API connected with verified certificate.");

  startupStage = "PostgreSQL connection";
  const database = await createDatabase();
  db = database.client;
  console.log("PostgreSQL connected.");

  startupStage = "PROCESSING recovery";
  await recoverStuckProcessingOrders();
  startProcessingRecovery();

  startupStage = "Telegram launch";
  bot = new Telegraf(process.env.BOT_TOKEN);
  navigation = createNavigation();
  const screenActions = [];
  const originalAction = bot.action.bind(bot);
  const originalStart = bot.start.bind(bot);
  const textScreens = new Map([
    ["🛡️ Buy VPN", "buy_vpn"], ["🌐 My VPN", "my_vpn"],
    ["📊 Usage", "my_vpn"], ["♻️ Renew", "renew_vpn"],
    ["⚡ Connect", "setup_vpn"], ["🎧 Support", "contact_support"],
    ["📊 Admin Panel", "ta_dashboard"], ["👥 Users", "ta_users_1"],
    ["🗂️ Orders", "ta_orders_1"], ["🧾 Payments", "ta_payments_1"],
    ["💎 Packages", "ta_packages_1"],
  ]);
  function screenForAction(action) {
    if (/^confirm_(?:package|renewal)_\d+_(?:1|3|6)(?:_[a-f0-9]{16})?$/.test(action)) {
      return "unavailable_package";
    }
    if (/^(?:add_device|connection_link|setup_platform_(?:android|ios|windows|macos))$/.test(action)) {
      return "setup_vpn";
    }
    if (/^(?:buy_vpn|my_vpn|setup_vpn|copy_vpn_key|renew_vpn|help|contact_support|my_orders|payment_help)$/.test(action) ||
        /^(?:package|renew_package)_\d+$/.test(action) ||
        /^(?:duration|renew_duration)_\d+_(?:1|3|6)$/.test(action) ||
        /^payment_(?:bank|wallet)_\d+$/.test(action) ||
        /^support_reply_\d+$/.test(action) ||
        /^ta_(?:menu|dashboard|(?:users|orders|payments|packages)_\d+|(?:user|order|package|edit)_\d+_\d+|field_\d+_\d+_(?:name|priceMmk|dataLimitGb|durationDays|sortOrder))$/.test(action)) {
      return action;
    }
    return null;
  }
  function screenForReply(defaultScreen, extra) {
    if (/^payment_(?:bank|wallet)_\d+$/.test(defaultScreen || "")) return defaultScreen;
    const buttons = extra?.reply_markup?.inline_keyboard?.flat() || [];
    const payment = buttons.map((button) => /^payment_(?:bank|wallet)_(\d+)$/.exec(button.callback_data || ""))
      .find(Boolean);
    return payment ? `payment_select_${payment[1]}` : defaultScreen;
  }
  async function withNavigationReply(ctx, defaultScreen, handler, restoring = false) {
    const originalReply = ctx.reply;
    const ownedReply = Object.hasOwn(ctx, "reply");
    ctx.reply = async (message, extra) => {
      if (!restoring && ctx.navigationRestoring) return originalReply.call(ctx, message, extra);
      const screen = screenForReply(defaultScreen, extra);
      if (!screen || ctx.chat?.type !== "private" || extra?.reply_markup?.keyboard) {
        return originalReply.call(ctx, message, extra);
      }
      const token = restoring ? navigation.currentToken(ctx) : navigation.enter(ctx, screen);
      if (!token) return originalReply.call(ctx, message, extra);
      const rows = (extra?.reply_markup?.inline_keyboard || []).map((row) =>
        row.filter((button) => !/(?:^⬅️ Back$|^← Back(?: to .*)?$)/.test(button.text || ""))
      ).filter((row) => row.length);
      rows.push([Markup.button.callback("⬅️ Back", `nav_back_${token}`)]);
      return originalReply.call(ctx, message, {
        ...extra, reply_markup: { ...extra?.reply_markup, inline_keyboard: rows },
      });
    };
    try { return await handler(); } finally {
      if (ownedReply) ctx.reply = originalReply;
      else delete ctx.reply;
    }
  }
  bot.action = (trigger, handler) => {
    screenActions.push({ trigger, handler });
    return originalAction(trigger, (ctx) => {
      const action = typeof trigger === "string" ? trigger : ctx.match?.[0];
      return withNavigationReply(ctx, screenForAction(action || ""), () => handler(ctx));
    });
  };
  bot.start = (handler) => originalStart((ctx) => {
    navigation.reset(ctx);
    return handler(ctx);
  });
  const supportService = createSupportService({
    db, bot, adminTelegramId: ADMIN_TELEGRAM_ID, isAdmin,
    helpKeyboard: buildHelpKeyboard, supportEvents,
  });
  miniAppSupportService = supportService;
  telegramAdmin = createTelegramAdmin({ bot, db, adminTelegramId: ADMIN_TELEGRAM_ID,
    supportService });
  async function renderNavigationScreen(ctx, screen) {
    if (screen === "main") return sendMainMenu(ctx);
    if (/^payment_select_(\d+)$/.test(screen)) {
      const id = Number(screen.slice("payment_select_".length));
      const order = await db.public.Order.where({ id }).first();
      const customer = order && await db.public.Customer.where({ id: order.customerId }).first();
      if (!order || customer?.telegramId !== String(ctx.from.id) ||
          order.status !== "PENDING_PAYMENT") return false;
      await withNavigationReply(ctx, screen,
        () => ctx.reply(formatPayment(order), buildPaymentKeyboard(order)), true);
      return true;
    }
    const registered = screenActions.find(({ trigger }) => typeof trigger === "string"
      ? trigger === screen : trigger.test(screen));
    if (!registered) return false;
    const replay = Object.create(ctx);
    replay.answerCbQuery = async () => {};
    replay.navigationRestore = true;
    replay.match = typeof registered.trigger === "string" ? undefined : screen.match(registered.trigger);
    await withNavigationReply(replay, screen, () => registered.handler(replay), true);
    return true;
  }
  bot.action(/^nav_back_([A-Za-z0-9_-]{8})$/, async (ctx) => {
    await ctx.answerCbQuery();
    const previous = navigation.back(ctx, ctx.match[1]);
    if (!previous) return ctx.reply("This Back button is no longer active. Open /start to continue.");
    pendingProofs.delete(String(ctx.from.id));
    telegramAdmin.clearInput();
    if (previous.leaving === "contact_support") {
      await supportService.pauseCustomer(ctx.from.id);
      return sendMainMenu(ctx);
    }
    if (previous.leaving.startsWith("support_reply_")) await supportService.clearAdminReply();
    try {
      ctx.navigationRestoring = true;
      if (await renderNavigationScreen(ctx, previous.screen) === false) {
        await sendMainMenu(ctx);
      }
    } catch (error) {
      logHandlerFailure("navigation.back", error);
      await sendMainMenu(ctx);
    } finally {
      delete ctx.navigationRestoring;
    }
  });
  const shortcutActions = new Map();
  function registerShortcutAction(name, handler) {
    shortcutActions.set(name, handler);
    bot.action(name, handler);
  }

  // =========================
  // START
  // =========================

  bot.start(async (ctx) => {
    if (ctx.chat?.type === "private" && ctx.from?.id != null) {
      try {
        await db.public.Customer.upsert({
          conflictOn: { telegramId: true },
          create: { telegramId: String(ctx.from.id), username: ctx.from.username || null,
            firstName: ctx.from.first_name || null },
          update: { username: ctx.from.username || null,
            firstName: ctx.from.first_name || null },
        });
      } catch (error) {
        logHandlerFailure("start.customerRegistration", error);
      }
    }
    await ctx.replyWithPhoto(Input.fromLocalFile(WELCOME_IMAGE));
    await sendMainMenu(ctx);
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(
      `သင့် Telegram ID:\n${ctx.from.id}\n\nအကူအညီတောင်းတဲ့အခါ ဒီနံပါတ်ကို ပေးနိုင်ပါတယ်။ Menu ကိုပြန်ဖွင့်ဖို့ /start ကိုနှိပ်ပါ။`
    );
  });

  // =========================
  // MY VPN
  // =========================

  registerShortcutAction("my_vpn", async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const { customer, subscription } = await findCustomerSubscription(ctx.from.id);

      if (!customer || !subscription) {
        return await ctx.reply(
          "🌐 My VPN\n\nVPN package မရှိသေးပါ။ Buy VPN ကိုနှိပ်ပြီး package ရွေးပါ။\nငွေပေးချေပြီး Admin အတည်ပြုရင် စသုံးနိုင်ပါမယ်။",
          buildMainMenu(ctx)
        );
      }

      const subscriptionActive = isSubscriptionActive(subscription);
      const statusLabel = subscriptionActive
        ? "အသုံးပြုနိုင်ပါသည်"
        : "အသုံးပြုမရပါ";

      if (!subscriptionActive) {
        return await ctx.reply(
          `🌐 My VPN\n\nအခြေအနေ: ${statusLabel}\n\nVPN ကို လက်ရှိ အသုံးပြုမရပါ။ သက်တမ်းတိုးဖို့ ♻️ Renew ကိုနှိပ်ပါ။`,
          renewBuyKeyboard()
        );
      }

      const packageLabel = subscription.plan || "VPN package";
      const hasReusableKey = Boolean(subscription.vpnKeyId &&
        isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) &&
        isValidOutlineAccessKey(subscription.vpnKey));
      await ctx.reply(
        `🌐 My VPN\n\nPackage: ${packageLabel}\n` +
          `📡 အသုံးပြုမှု: ${formatUsageGb(subscription.dataUsedGb)} GB / ${formatNumber(subscription.dataLimitGb || 0)} GB\n` +
          `⏳ သက်တမ်းကုန်ရက်: ${formatInstant(subscription.expiresAt)}\nအခြေအနေ: ${statusLabel}\n\n` +
          "အသုံးပြုမှုက နောက်ဆုံး 30 ရက်အတွင်း သုံးထားတဲ့ Data ဖြစ်ပါတယ်။\n\n" +
          (hasReusableKey
            ? "VPN ချိတ်ဖို့ 🛰️ Setup VPN ကိုနှိပ်ပါ။\nData သို့မဟုတ် သက်တမ်းတိုးဖို့ ♻️ Renew ကိုနှိပ်ပါ။"
            : "VPN key ကို လောလောဆယ် ရယူမရပါ။ Help → Contact Support ကိုနှိပ်ပြီး အကူအညီတောင်းပါ။"),
        buildMyVpnKeyboard(subscription)
      );
    } catch (error) {
      logHandlerFailure("my_vpn", error);

      await ctx.reply(
        "VPN အချက်အလက်ကို လောလောဆယ် မဖော်ပြနိုင်ပါ။\nခဏစောင့်ပြီး My VPN ကို ပြန်နှိပ်ပါ။"
      );
    }
  });

  bot.action("copy_vpn_key", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await sendExistingVpnKey(ctx, "Copy VPN Key");
    } catch {
      console.error("Could not load VPN key for copying.");
      await ctx.reply("VPN key ကို လောလောဆယ် ရယူမရပါ။\nMy VPN → Copy VPN Key ကို ပြန်နှိပ်ပါ။ ထပ်ဖြစ်ရင် /start → Help မှ ဆက်သွယ်ပါ။");
    }
  });

  bot.action(/^(?:setup_vpn|add_device)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await sendVpnSetup(ctx);
    } catch (error) {
      logHandlerFailure("setup_vpn", error);
      await ctx.reply("VPN Setup ကို လောလောဆယ် ဖွင့်မရပါ။\nMy VPN → Setup VPN ကို ပြန်နှိပ်ပါ။ ထပ်ဖြစ်ရင် /start → Help မှ ဆက်သွယ်ပါ။");
    }
  });

  bot.action(/^setup_platform_(android|ios|windows|macos)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      // Old device-picker messages now issue the same direct helper link.
      await sendVpnSetup(ctx);
    } catch (error) {
      logHandlerFailure("setup_platform", error);
      await ctx.reply("VPN Setup ကို လောလောဆယ် ဖွင့်မရပါ။\nMy VPN → Setup VPN ကို ပြန်နှိပ်ပါ။ ထပ်ဖြစ်ရင် /start → Help မှ ဆက်သွယ်ပါ။");
    }
  });

  // =========================
  // CONNECTION LINK
  // =========================

  bot.action(
    "connection_link",
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        await sendVpnSetup(ctx);
      } catch (error) {
        logHandlerFailure("connection_link", error);
        await ctx.reply("VPN Setup ကို လောလောဆယ် ဖွင့်မရပါ။\nMy VPN → Setup VPN ကို ပြန်နှိပ်ပါ။ ထပ်ဖြစ်ရင် /start → Help မှ ဆက်သွယ်ပါ။");
      }
    }
  );

  // =========================
  // RENEW VPN
  // =========================

  registerShortcutAction(
    "renew_vpn",
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const customer =
          await db.public.Customer
            .where({
              telegramId: String(
                ctx.from.id
              ),
            })
            .first();

        if (!customer) {
          return await ctx.reply(
            "သင့်အကောင့်မှာ VPN ဝယ်ယူထားတာ မတွေ့သေးပါ။\n/start → Buy VPN ကိုနှိပ်ပြီး စဝယ်နိုင်ပါတယ်။"
          );
        }

        const subscription =
          await db.public.Subscription
            .where({
              customerId: customer.id,
            })
            .first();

        if (!subscription) {
          return await ctx.reply(
            "VPN package မရှိသေးလို့ သက်တမ်းတိုးမရသေးပါ။\n/start → Buy VPN ကိုနှိပ်ပြီး package အရင်ဝယ်ပါ။"
          );
        }

        const packages =
          await getActivePackages();

        if (!packages.length) {
          return await ctx.reply(
            "လောလောဆယ် ရွေးနိုင်တဲ့ package မရှိသေးပါ။\nခဏကြာမှ ပြန်ကြည့်ပါ၊ ဒါမှမဟုတ် /start → Help မှ ဆက်သွယ်ပါ။"
          );
        }

        await ctx.reply(
          "♻️ VPN သက်တမ်းတိုးပါ\n\nမူလ VPN key ကိုပဲ ဆက်သုံးပြီး Data နဲ့ သက်တမ်းကို ထပ်တိုးပေးပါမယ်။\nအောက်က package ခလုတ်တစ်ခုကိုနှိပ်ပြီး ထပ်တိုးမယ့် ပမာဏနဲ့ ဈေးနှုန်းကိုကြည့်ပါ။\nငွေပေးချေပြီး Admin အတည်ပြုရင် သက်တမ်းတိုးပြီးပါပြီ။",
          buildPackageKeyboard(packages, true)
        );
      } catch (error) {
        logHandlerFailure("renew_vpn", error);

        await ctx.reply(
          "သက်တမ်းတိုးနိုင်တဲ့ package တွေကို မဖော်ပြနိုင်သေးပါ။\nခဏစောင့်ပြီး My VPN → Renew ကို ပြန်နှိပ်ပါ။"
        );
      }
    }
  );

  bot.action(
    /^renew_package_(\d+)$/,
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const packageId =
          Number(ctx.match[1]);

        const pkg =
          await getPackageById(
            packageId
          );

        if (!pkg) {
          return replyUnavailablePackage(ctx, true);
        }

        await ctx.reply(formatPackageDetails(pkg, true), buildPackageDetailKeyboard(pkg, true));
      } catch (error) {
        console.error("Renew package selection failed.");

        await ctx.reply(
          "ဒီ package အသေးစိတ်ကို မဖော်ပြနိုင်သေးပါ။\nခဏစောင့်ပြီး မူလ package ခလုတ်ကို ပြန်နှိပ်ပါ။"
        );
      }
    }
  );

  bot.action(
    /^renew_duration_(\d+)_(1|3|6)$/,
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const packageId =
          Number(ctx.match[1]);

        const durationMonths =
          Number(ctx.match[2]);

        const pkg =
          await getPackageById(
            packageId
          );

        if (!pkg) {
          return replyUnavailablePackage(ctx, true);
        }

        await ctx.reply(
          formatPurchaseConfirmation(pkg, durationMonths, true),
          buildConfirmationKeyboard(pkg, durationMonths, true)
        );
      } catch (error) {
        console.error("Renew duration selection failed.");

        await ctx.reply(
          "သက်တမ်းတိုးမယ့် ဈေးနှုန်းကို မဖော်ပြနိုင်သေးပါ။\nခဏစောင့်ပြီး My VPN → Renew မှ ပြန်ရွေးပါ။"
        );
      }
    }
  );

  bot.action(
    /^confirm_renewal_(\d+)_(1|3|6)(?:_([a-f0-9]{16}))?$/,
    async (ctx) => {
      await ctx.answerCbQuery();

      const packageId =
        Number(ctx.match[1]);

      const durationMonths =
        Number(ctx.match[2]);

      await createPackageOrder(
        ctx,
        packageId,
        durationMonths,
        true,
        ctx.match[3] || null
      );
    }
  );

  // =========================
  // BUY VPN
  // =========================

  registerShortcutAction(
    "buy_vpn",
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const packages =
          await getActivePackages();

        if (!packages.length) {
          return await ctx.reply(
            "လောလောဆယ် ရွေးနိုင်တဲ့ package မရှိသေးပါ။\nခဏကြာမှ ပြန်ကြည့်ပါ၊ ဒါမှမဟုတ် /start → Help မှ ဆက်သွယ်ပါ။"
          );
        }

        await ctx.replyWithPhoto(Input.fromLocalFile(PACKAGE_IMAGE));
        await ctx.reply(
          formatPackageSelection(packages),
          buildPackageKeyboard(packages)
        );
      } catch (error) {
        logHandlerFailure("buy_vpn", error);

        await ctx.reply(
          "Package တွေကို မဖော်ပြနိုင်သေးပါ။\nခဏစောင့်ပြီး Buy VPN ကို ပြန်နှိပ်ပါ။"
        );
      }
    }
  );

  // =========================
  // PACKAGE SELECTION
  // =========================

  bot.action(
    /^package_(\d+)$/,
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const packageId =
          Number(ctx.match[1]);

        const pkg =
          await getPackageById(
            packageId
          );

        if (!pkg) {
          return replyUnavailablePackage(ctx);
        }

        await ctx.reply(formatPackageDetails(pkg), buildPackageDetailKeyboard(pkg));
      } catch (error) {
        console.error("Package selection failed.");

        await ctx.reply(
          "ဒီ package အသေးစိတ်ကို မဖော်ပြနိုင်သေးပါ။\nခဏစောင့်ပြီး မူလ package ခလုတ်ကို ပြန်နှိပ်ပါ။"
        );
      }
    }
  );

  // =========================
  // DURATION SELECTION
  // =========================

  bot.action(
    /^duration_(\d+)_(1|3|6)$/,
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const packageId =
          Number(ctx.match[1]);

        const durationMonths =
          Number(ctx.match[2]);

        const pkg =
          await getPackageById(
            packageId
          );

        if (!pkg) {
          return replyUnavailablePackage(ctx);
        }

        await ctx.reply(
          formatPurchaseConfirmation(pkg, durationMonths),
          buildConfirmationKeyboard(pkg, durationMonths)
        );
      } catch (error) {
        console.error("Duration selection failed.");

        await ctx.reply(
          "ဈေးနှုန်းကို မဖော်ပြနိုင်သေးပါ။\nခဏစောင့်ပြီး Buy VPN မှ package ပြန်ရွေးပါ။"
        );
      }
    }
  );

  // =========================
  // CONFIRM PACKAGE
  // =========================

  bot.action(
    /^confirm_package_(\d+)_(1|3|6)(?:_([a-f0-9]{16}))?$/,
    async (ctx) => {
      await ctx.answerCbQuery();

      const packageId =
        Number(ctx.match[1]);

      const durationMonths =
        Number(ctx.match[2]);

      await createPackageOrder(
        ctx,
        packageId,
        durationMonths,
        false,
        ctx.match[3] || null
      );
    }
  );

  // =========================
  // BACK TO START
  // =========================

  bot.action(
    "back_to_start",
    async (ctx) => {
      await ctx.answerCbQuery();
      await supportService.pauseCustomer(ctx.from.id);
      await sendMainMenu(ctx);
    }
  );

  // =========================
  // HELP
  // =========================

  registerShortcutAction("help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "🎧 Help\n\nအကူအညီလိုအပ်ပါက Support ကို တိုက်ရိုက်ဆက်သွယ်နိုင်ပါတယ်။",
      buildHelpKeyboard()
    );
  });

  registerShortcutAction("contact_support", supportService.contact);
  bot.action("support_cancel", supportService.cancel);
  bot.action("support_main_menu", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await supportService.pauseCustomer(ctx.from.id);
      await sendMainMenu(ctx);
    } catch {
      console.error("Support main menu failed.");
      await ctx.reply("Main Menu ကို မဖော်ပြနိုင်သေးပါ။ ခဏနေ ပြန်နှိပ်ပါ။");
    }
  });
  bot.action(/^support_reply_(\d+)$/, async (ctx) => {
    if (isAdmin(ctx)) telegramAdmin.clearInput();
    return supportService.selectReply(ctx);
  });
  bot.action(/^support_close_(\d+)$/, supportService.close);

  bot.action("payment_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "🧾 Payment Help — ငွေပေးချေနည်း\n\n" +
        "1️⃣ မူလ Payment စာက ငွေပေးချေနည်းခလုတ်ကိုနှိပ်ပါ\n" +
        "2️⃣ ပြထားတဲ့အကောင့်ကို ငွေပမာဏအတိအကျ လွှဲပါ\n" +
        "3️⃣ ရှင်းလင်းတဲ့ screenshot ကို ဒီ chat မှာ ပုံအဖြစ်ပို့ပါ\n" +
        "4️⃣ Admin အတည်ပြုတာကို စောင့်ပါ\n\n" +
        "အတည်ပြုပြီးရင် VPN Setup လုပ်နည်းကို ပို့ပေးပါမယ်။\n" +
        "ပြဿနာရှိရင် Contact Support ကိုနှိပ်ပြီး မှာယူမှုနံပါတ်ကို ပေးပါ။ ထပ်ငွေမလွှဲပါနဲ့။",
      buildHelpKeyboard()
    );
  });

  // =========================
  // PAYMENT METHOD
  // =========================

  bot.action(
    /^payment_bank_(\d+)$/,
    async (ctx) => {
      await handlePaymentMethod(
        ctx,
        "bank_transfer",
        Number(ctx.match[1])
      );
    }
  );

  bot.action(
    /^payment_wallet_(\d+)$/,
    async (ctx) => {
      await handlePaymentMethod(
        ctx,
        "mobile_wallet",
        Number(ctx.match[1])
      );
    }
  );

  async function handlePaymentMethod(
    ctx,
    method,
    orderId
  ) {
    await ctx.answerCbQuery();

    try {
      const order =
        await db.public.Order
          .where({
            id: orderId,
          })
          .first();

      if (!order) {
        return await ctx.reply(
          "မှာယူမှုကို မတွေ့ပါ။\n/start → My Orders မှာ ပြန်စစ်ပါ။ အကူအညီလိုရင် Help မှ ဆက်သွယ်ပါ။"
        );
      }

      const customer =
        await db.public.Customer
          .where({
            id: order.customerId,
          })
          .first();

      if (
        !customer ||
        customer.telegramId !==
          String(ctx.from.id)
      ) {
        return await ctx.reply(
          "ဒီမှာယူမှုက သင့်အကောင့်နဲ့ မသက်ဆိုင်ပါ။\n/start → My Orders မှာ သင့်မှာယူမှုကို ပြန်စစ်ပါ။"
        );
      }

      if (
        order.status !==
        "PENDING_PAYMENT"
      ) {
        return await ctx.reply(
          `ဒီမှာယူမှုအတွက် ငွေပေးချေမှု ဆက်လုပ်မရပါ။\nအခြေအနေ: ${formatOrderStatus(order.status)}\n\n/start → My Orders မှာ ပြန်စစ်ပါ။ ငွေလွှဲပြီးသားဆိုရင် Help မှ ဆက်သွယ်ပါ။`
        );
      }

      const payment =
        PAYMENT_METHODS[method];

      if (!payment) {
        return await ctx.reply(
          "ဒီငွေပေးချေနည်းကို လောလောဆယ် သုံးမရပါ။\nမူလ Payment စာမှာ အခြားနည်းကို ရွေးပါ၊ ဒါမှမဟုတ် Help ကိုနှိပ်ပါ။"
        );
      }

      if (!ctx.navigationRestore) {
        await db.public.Order
          .where({
            id: orderId,
          })
          .update({
            paymentMethod: method,
          });
      }

      await ctx.reply(
        `🧾 Payment — ${payment.name}\n\n` +
          `မှာယူမှု: ${order.orderNumber}\nPackage: ${order.plan}\nပေးချေရန်: ${formatMmk(order.price)}\n\n` +
          `အကောင့်အမည်: ${payment.accountName}\nအကောင့်နံပါတ်: ${payment.accountNumber}\n\n` +
          "အပေါ်ကအကောင့်ကို ငွေပမာဏအတိအကျ လွှဲပါ။\n" +
          "ပြီးရင် ငွေလွှဲ screenshot ကို ဒီ chat မှာ ပုံအဖြစ်ပို့ပြီး Admin စစ်ဆေးတာကို စောင့်ပါ။\n" +
          "အတည်ပြုပြီးရင် Setup VPN ခလုတ်နဲ့ ချိတ်ဆက်နည်းကို ပို့ပေးပါမယ်။ မရှင်းလင်းရင် Help ကိုနှိပ်ပါ။",
        buildPaymentKeyboard(order)
      );

      await supportService.pauseCustomer(ctx.from.id);
      pendingProofs.set(
        String(ctx.from.id),
        orderId
      );
    } catch (error) {
      console.error("Payment method selection failed.");

      await ctx.reply(
        "ငွေပေးချေနည်းကို ရွေးချယ်မရသေးပါ။\nခဏစောင့်ပြီး မူလငွေပေးချေနည်းခလုတ်ကို ပြန်နှိပ်ပါ။"
      );
    }
  }

  // =========================
  // PAYMENT PROOF
  // =========================

  bot.on("photo", async (ctx) => {
    try {
      if (await supportService.handlePhoto(ctx)) return;
    } catch {
      console.error("Support photo relay failed.");
      return ctx.reply("Support ပုံကို မပို့နိုင်သေးပါ။ ခဏနေ ပြန်ပို့ပေးပါ။");
    }
    const userId =
      String(ctx.from.id);

    const orderId =
      pendingProofs.get(userId);

    if (!orderId) return;

    try {
      const order =
        await db.public.Order
          .where({
            id: orderId,
          })
          .first();

      if (!order) {
        pendingProofs.delete(
          userId
        );

        return await ctx.reply(
          "မှာယူမှုကို မတွေ့ပါ။\n/start → My Orders မှာ ပြန်စစ်ပါ။ အကူအညီလိုရင် Help မှ ဆက်သွယ်ပါ။"
        );
      }

      const proofOwner = await db.public.Customer.where({ id: order.customerId }).first();
      if (!proofOwner || proofOwner.telegramId !== userId) {
        pendingProofs.delete(userId);
        return await ctx.reply("ဒီမှာယူမှုက သင့်အကောင့်နဲ့ မသက်ဆိုင်ပါ။");
      }
      if (String(order.paymentReference || "").startsWith("MINI_UPLOAD_V1:")) {
        return await ctx.reply("Payment proof upload is in progress. Check My Orders shortly.");
      }

      if (
        order.status !==
        "PENDING_PAYMENT"
      ) {
        pendingProofs.delete(
          userId
        );

        return await ctx.reply(
          "ဒီမှာယူမှုအတွက် screenshot ထပ်ပို့စရာ မလိုတော့ပါ။\n/start → My Orders မှာ အခြေအနေကို ပြန်စစ်ပါ။ မရှင်းလင်းရင် Help မှ ဆက်သွယ်ပါ။"
        );
      }

      const photos =
        ctx.message.photo;
      const selectedPhoto = photos?.at(-1);
      if (!selectedPhoto || (selectedPhoto.file_size != null &&
          (!Number.isSafeInteger(selectedPhoto.file_size) || selectedPhoto.file_size <= 0 ||
           selectedPhoto.file_size > 20 * 1024 * 1024))) {
        return await ctx.reply("Please send a payment photo smaller than 20 MB.");
      }

      const paymentProof =
        selectedPhoto.file_id;

      await db.public.Order
        .where({
          id: orderId,
        })
        .update({
          paymentProof,
        });

      pendingProofs.delete(
        userId
      );

      await ctx.reply(
        "🧾 ငွေလွှဲပုံ လက်ခံရရှိပါပြီ\n\nAdmin စစ်ဆေးအတည်ပြုတာကို စောင့်ပေးပါ။ အတည်ပြုပြီးရင် VPN အဆင်သင့်ဖြစ်ကြောင်း ပို့ပေးပါမယ်။\nအဲဒီစာမှာ Setup VPN ကိုနှိပ်ပြီး စချိတ်ဆက်နိုင်ပါတယ်။\nလက်ရှိအခြေအနေကြည့်ဖို့ My Orders ကိုနှိပ်ပါ။ ထပ်ငွေလွှဲဖို့ မလိုပါ။",
        Markup.inlineKeyboard([
          [Markup.button.callback("🗂️ My Orders", "my_orders"), Markup.button.callback("🎧 Help", "payment_help")],
        ])
      );

      await sendAdminProofReview(order, paymentProof);
    } catch (error) {
      console.error("Payment proof handling failed.");

      await ctx.reply(
        "ငွေလွှဲပုံပို့တာကို အပြီးသတ်မလုပ်နိုင်သေးပါ။ ထပ်ငွေမလွှဲပါနဲ့။\nမူလ Payment စာက Help ကိုနှိပ်ပြီး မှာယူမှုနံပါတ်နဲ့အတူ Contact Support မှ ဆက်သွယ်ပါ။"
      );
    }
  });

  bot.on("text", async (ctx) => {
    let handler = "text";
    try {
      handler = "admin.packageInput";
      if (await telegramAdmin.handleText(ctx)) return;
      handler = "admin.supportReply";
      if (isAdmin(ctx) && await supportService.handleText(ctx)) return;
      handler = "admin.menu";
      if (await withNavigationReply(ctx, textScreens.get(ctx.message?.text),
        () => telegramAdmin.handleMenuText(ctx))) return;
      if (ctx.chat?.type === "private") {
        const label = ctx.message?.text;
        if (label === "⚡ Connect") {
          handler = "connect";
          await withNavigationReply(ctx, "setup_vpn", () => sendVpnSetup(ctx));
          return;
        }
        const shortcut = REPLY_SHORTCUTS.get(label);
        if (shortcut) {
          handler = shortcut;
          const textContext = Object.create(ctx);
          textContext.answerCbQuery = async () => {};
          await withNavigationReply(textContext, shortcut,
            () => shortcutActions.get(shortcut)(textContext));
          return;
        }
      }
      handler = "support.text";
      await supportService.handleText(ctx);
    } catch (error) {
      logHandlerFailure(handler, error);
      await ctx.reply("Support စာကို မပို့နိုင်သေးပါ။ ခဏနေ ပြန်ပို့ပေးပါ။");
    }
  });

  // =========================
  // APPROVE PAYMENT
  // =========================

  bot.action(
    /^approve_payment_(\d+)$/,
    async (ctx) => {
      if (!isAdmin(ctx)) {
        return await ctx.answerCbQuery(
          "Unauthorized"
        );
      }

      await ctx.answerCbQuery(
        "Processing..."
      );

      const orderId =
        Number(ctx.match[1]);

      try {
        // ---------------------------------
        // 1. Load original order
        // ---------------------------------

        const existingOrder =
          await db.public.Order
            .where({
              id: orderId,
            })
            .first();

        if (!existingOrder) {
          return await ctx.reply(
            "❌ Order not found."
          );
        }

        // ---------------------------------
        // 2. Double approval protection
        // ---------------------------------

        const processingAt =
          Temporal.Now.instant();

        const claimedOrders =
          await db.public.Order
            .where({
              id: orderId,
              status: "PENDING_PAYMENT",
            })
            .updateAll({
              status: "PROCESSING",
              processingAt,
            });

        if (
          claimedOrders.length === 0
        ) {
          return await ctx.reply(
            `⚠️ Order already processed or is currently being processed.\n\nStatus: ${existingOrder.status}`
          );
        }

        const order =
          claimedOrders[0];

        console.log(
          `Order ${order.orderNumber} claimed for approval.`
        );

        // ---------------------------------
        // 3. Load customer
        // ---------------------------------

        const customer =
          await db.public.Customer
            .where({
              id: order.customerId,
            })
            .first();

        if (!customer) {
          throw new Error(
            "Customer not found."
          );
        }

        // ---------------------------------
        // 4. Load package
        // ---------------------------------

        const pkg = order.packageId
          ? await db.public.Package
              .where({
                id: order.packageId,
              })
              .first()
          : null;

        if (!pkg) {
          throw new Error(
            "Package not found for order."
          );
        }

        // ---------------------------------
        // 5. Calculate package values
        // ---------------------------------

        const durationMonths =
          Number(
            order.durationMonths
          ) || 1;

        // New orders carry the entitlement shown at confirmation. Older
        // orders retain the existing package-based fallback.
        const totalDataGb = order.totalDataGb == null
          ? Number(pkg.dataLimitGb) * durationMonths
          : Number(order.totalDataGb);

        const durationDays = order.totalDurationDays == null
          ? Number(pkg.durationDays) * durationMonths
          : Number(order.totalDurationDays);

        const dataLimitBytes =
          gbToBytes(totalDataGb);

        const now =
          Temporal.Now.instant();

        console.log(
          `Approval package: ${pkg.name}`
        );

        console.log(
          `Total data: ${totalDataGb} GB`
        );

        console.log(
          `Outline limit: ${dataLimitBytes} bytes`
        );

        // ---------------------------------
        // 6. Load existing subscription
        // ---------------------------------

        let subscription =
          await db.public.Subscription
            .where({
              customerId: customer.id,
            })
            .first();

        // =================================
        // NEW SUBSCRIPTION
        // =================================

        if (!subscription) {
          let accessKey = null;
          // Freeze the entitlement clock before calling Outline so recovery
          // cannot extend the purchase after a partial failure.
          const startedAt = order.startedAt
            ? Temporal.Instant.from(order.startedAt) : now;
          const expiresAt = order.expiresAt
            ? Temporal.Instant.from(order.expiresAt)
            : startedAt.add({ hours: durationDays * 24 });
          if (!order.startedAt || !order.expiresAt) {
            await db.public.Order.where({ id: order.id, status: "PROCESSING" })
              .update({ startedAt, expiresAt });
            order.startedAt = startedAt;
            order.expiresAt = expiresAt;
          }

          // ---------------------------------
          // 7. Reuse existing key if one
          //    was already created
          // ---------------------------------

          if (
            isReusableAccessKey(
              order.vpnKeyId,
              order.vpnKey
            )
          ) {
            accessKey = {
              id: order.vpnKeyId,
              accessUrl: order.vpnKey,
            };

            console.log(
              `Reusing existing Outline key ${accessKey.id} for order ${order.orderNumber}.`
            );
          } else {
            // ---------------------------------
            // 8. Create Outline key
            // ---------------------------------

            assertIdempotentProvisioningOrder(order);
            accessKey =
              await createOrderAccessKey(
                order
              );

            if (
              !accessKey ||
              !accessKey.id ||
              !accessKey.accessUrl ||
              !isReusableAccessKey(
                accessKey.id,
                accessKey.accessUrl
              )
            ) {
              throw new Error(
                "Outline API returned an invalid access key."
              );
            }

            console.log(
              `Outline key created: ${accessKey.id}`
            );

            // ---------------------------------
            // 9. SAVE KEY IMMEDIATELY
            //
            // This is critical for idempotency.
            // If later API/DB operation fails,
            // retry will reuse this key.
            // ---------------------------------

            await db.public.Order
              .where({
                id: order.id,
                status: "PROCESSING",
              })
              .update({
                vpnKey:
                  accessKey.accessUrl,

                vpnKeyId:
                  accessKey.id,

                vpnKeyCreatedAt:
                  now,
              });

            console.log(
              `Outline key ${accessKey.id} saved to order ${order.orderNumber}.`
            );
          }

          // ---------------------------------
          // 10. Set Outline data limit
          // ---------------------------------

          console.log(
            `Setting Outline data limit: ${totalDataGb} GB`
          );

          await setAccessKeyDataLimit(
            accessKey.id,
            dataLimitBytes
          );

          console.log(
            `Outline data limit successfully set: ${totalDataGb} GB`
          );

          // ---------------------------------
          // 11. Calculate subscription expiry
          // ---------------------------------

          // ---------------------------------
          // 12. Create subscription
          // ---------------------------------

          subscription =
            await db.public.Subscription.create(
              {
                customerId:
                  customer.id,

                packageId:
                  pkg.id,

                plan: order.plan,

                status: "ACTIVE",

                durationMonths,

                vpnKey:
                  accessKey.accessUrl,

                vpnKeyId:
                  accessKey.id,

                vpnKeyCreatedAt:
                  order.vpnKeyCreatedAt || now,

                startedAt:
                  startedAt,

                expiresAt,

                dataLimitGb:
                  totalDataGb,

                dataUsedGb: 0,
              }
            );

          // ---------------------------------
          // 13. Mark order PAID
          // ---------------------------------

          await db.public.Order
            .where({
              id: order.id,
            })
            .update({
              status: "PAID",

              processingAt:
                null,

              paidAt:
                now,

              vpnKey:
                accessKey.accessUrl,

              vpnKeyId:
                accessKey.id,

              vpnKeyCreatedAt:
                order.vpnKeyCreatedAt || now,

              startedAt:
                startedAt,

              expiresAt,

              revokedAt:
                null,
            });

          // ---------------------------------
          // 14. Notify customer
          // ---------------------------------

          await bot.telegram.sendMessage(
            customer.telegramId,
            formatActivation({ name: order.plan }, totalDataGb, expiresAt),
            buildMyVpnKeyboard(subscription, true)
          );

          console.log(
            `New subscription created for customer ${customer.id}. Order ${order.orderNumber} approved.`
          );
        }

        // =================================
        // EXISTING SUBSCRIPTION / RENEWAL
        // =================================

        else {
          // ---------------------------------
          // 15. Existing subscription must
          //     have a VPN key
          // ---------------------------------

          const subscriptionHasLegacyKey =
            String(subscription.vpnKeyId || "").startsWith("mock-");
          const orderHasPersistedRealKey =
            isReusableAccessKey(order.vpnKeyId, order.vpnKey);

          if (
            !isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) &&
            !subscriptionHasLegacyKey &&
            !orderHasPersistedRealKey
          ) {
            throw new Error(
              "Existing subscription does not have a valid VPN key."
            );
          }

          let renewalAccessKey = null;

          if (orderHasPersistedRealKey) {
            // A previous attempt may have saved a replacement to the order
            // before the subscription write or data-limit update failed.
            renewalAccessKey = {
              id: order.vpnKeyId,
              accessUrl: order.vpnKey,
              createdAt: order.vpnKeyCreatedAt || now,
            };
          } else if (isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey)) {
            renewalAccessKey = {
              id: subscription.vpnKeyId,
              accessUrl: subscription.vpnKey,
              createdAt: subscription.vpnKeyCreatedAt,
            };
          } else if (subscriptionHasLegacyKey) {
            assertIdempotentProvisioningOrder(order);
            renewalAccessKey = await createOrderAccessKey(order);

            if (
              !renewalAccessKey ||
              !renewalAccessKey.id ||
              !renewalAccessKey.accessUrl ||
              !isReusableAccessKey(renewalAccessKey.id, renewalAccessKey.accessUrl)
            ) {
              throw new Error(
                "Outline API did not return a valid real access key."
              );
            }

            renewalAccessKey.createdAt = now;
            await persistReplacementAccessKey(order, subscription, renewalAccessKey, now);
          }

          if (!renewalAccessKey) {
            throw new Error(
              "Existing subscription does not have a valid VPN key."
            );
          }

          if (orderHasPersistedRealKey &&
              (subscription.vpnKeyId !== renewalAccessKey.id ||
               subscription.vpnKey !== renewalAccessKey.accessUrl)) {
            await persistReplacementAccessKey(
              order, subscription, renewalAccessKey, renewalAccessKey.createdAt
            );
          }

          const isFuture = subscription.expiresAt &&
            Temporal.Instant.compare(subscription.expiresAt, now) > 0;
          const newExpiresAt = order.expiresAt
            ? Temporal.Instant.from(order.expiresAt)
            : (isFuture ? subscription.expiresAt : now).add({ hours: durationDays * 24 });
          if (order.expiresAt && subscription.expiresAt &&
              Temporal.Instant.compare(subscription.expiresAt, newExpiresAt) > 0) {
            throw new Error("Subscription changed during renewal retry.");
          }
          if (!order.expiresAt) {
            // Save the exact renewal target before changing Outline or the
            // subscription. A retry after a partial DB write must not add the
            // purchased duration a second time.
            await db.public.Order.where({ id: order.id, status: "PROCESSING" })
              .update({ expiresAt: newExpiresAt });
            order.expiresAt = newExpiresAt;
          }

          const currentDataLimitGb =
            Number(
              subscription.dataLimitGb || 0
            );

          const alreadyApplied = subscription.expiresAt &&
            Temporal.Instant.compare(subscription.expiresAt, newExpiresAt) === 0;
          const newTotalDataGb = alreadyApplied
            ? currentDataLimitGb : currentDataLimitGb + totalDataGb;

          const newDataLimitBytes =
            gbToBytes(
              newTotalDataGb
            );

          // ---------------------------------
          // 16. Update Outline key limit
          //
          // IMPORTANT:
          // Renewal uses the SAME key.
          // We increase its total limit.
          // ---------------------------------

          console.log(
            "Updating existing Outline key for renewal."
          );

          console.log(
            `New total data limit: ${newTotalDataGb} GB`
          );

          try {
            await setAccessKeyDataLimit(renewalAccessKey.id, newDataLimitBytes);
          } catch (error) {
            if (orderHasPersistedRealKey || subscriptionHasLegacyKey ||
                !isAccessKeyNotFoundError(error)) {
              throw error;
            }

            // Only a confirmed missing access key can be replaced. Save the
            // replacement before retrying the data limit, so a later approval
            // attempt cannot create another key.
            console.warn(`Outline access key missing for order ${order.orderNumber}. Creating one replacement.`);
            assertIdempotentProvisioningOrder(order);
            const replacement = await createOrderAccessKey(order);
            if (!replacement ||
                !isReusableAccessKey(replacement.id, replacement.accessUrl)) {
              throw new Error("Outline API returned an invalid replacement key.");
            }

            replacement.createdAt = now;
            await persistReplacementAccessKey(order, subscription, replacement, now);
            renewalAccessKey = replacement;
            await setAccessKeyDataLimit(renewalAccessKey.id, newDataLimitBytes);
          }

          console.log(
            `Existing Outline key data limit updated to ${newTotalDataGb} GB`
          );

          // ---------------------------------
          // 17. Update subscription
          // ---------------------------------

          await db.public.Subscription
            .where({
              id: subscription.id,
            })
            .update({
              packageId:
                pkg.id,

              plan: order.plan,

              status:
                "ACTIVE",

              durationMonths,

              expiresAt:
                newExpiresAt,

              dataLimitGb:
                newTotalDataGb,

              revokedAt:
                null,
            });

          // ---------------------------------
          // 18. Mark renewal order PAID
          // ---------------------------------

          await db.public.Order
            .where({
              id: order.id,
            })
            .update({
              status: "PAID",

              processingAt:
                null,

              paidAt:
                now,

              vpnKey:
                renewalAccessKey.accessUrl,

              vpnKeyId:
                renewalAccessKey.id,

              vpnKeyCreatedAt:
                renewalAccessKey.createdAt,

              startedAt:
                subscription.startedAt,

              expiresAt:
                newExpiresAt,

              revokedAt:
                null,
            });

          // ---------------------------------
          // 19. Notify customer
          // ---------------------------------

          await bot.telegram.sendMessage(
            customer.telegramId,
            formatActivation({ name: order.plan }, newTotalDataGb, newExpiresAt, true),
            buildMyVpnKeyboard({ vpnKeyId: renewalAccessKey.id, vpnKey: renewalAccessKey.accessUrl }, true)
          );

          console.log(
            `Subscription ${subscription.id} extended. Order ${order.orderNumber} approved.`
          );
        }

        // ---------------------------------
        // 20. Update admin payment message
        // ---------------------------------

        try {
          const caption =
            ctx.callbackQuery
              ?.message?.caption ||
            "";

          await ctx.editMessageCaption(
            `${caption}\n\n\n` +
              `✅ PAYMENT APPROVED\n` +
              `🔐 Subscription activated`
          );
        } catch (editError) {
          console.error("Failed to edit admin payment message.");
        }
      } catch (error) {
        // Do not log provider errors: HTTP client errors can include
        // management URLs, request headers, or other sensitive details.
        console.error("Approve payment failed.");

        await ctx.reply(
          "❌ Failed to approve payment.\n\n" +
            "The order may still be in PROCESSING status. " +
            "If it remains there for more than 15 minutes, " +
            "the system will recover it automatically.\n\n" +
            "If an Outline key was already created, the next approval attempt will reuse that key."
        );
      }
    }
  );

  // =========================
  // REJECT PAYMENT
  // =========================

  bot.action(
    /^reject_payment_(\d+)$/,
    async (ctx) => {
      if (!isAdmin(ctx)) {
        return await ctx.answerCbQuery(
          "Unauthorized"
        );
      }

      await ctx.answerCbQuery(
        "Rejecting..."
      );

      const orderId =
        Number(ctx.match[1]);

      try {
        const order =
          await db.public.Order
            .where({
              id: orderId,
            })
            .first();

        if (!order) {
          return await ctx.reply(
            "❌ Order not found."
          );
        }

        if (
          order.status !==
          "PENDING_PAYMENT"
        ) {
          return await ctx.reply(
            `⚠️ Order already processed.\n\nStatus: ${order.status}`
          );
        }

        await db.public.Order
          .where({
            id: order.id,
          })
          .update({
            status:
              "PAYMENT_REJECTED",

            processingAt:
              null,
          });

        const customer =
          await db.public.Customer
            .where({
              id: order.customerId,
            })
            .first();

        if (customer) {
          await bot.telegram.sendMessage(
            customer.telegramId,

            `🧾 ငွေပေးချေမှု အတည်မပြုနိုင်ပါ\n\n` +
              `မှာယူမှု: ${order.orderNumber}\n\n` +
              `Contact Support ကိုနှိပ်ပြီး မှာယူမှုနံပါတ်နဲ့ ငွေလွှဲပုံကို ပေးပါ။\nပြန်စစ်ဆေးဖို့ အကူအညီတောင်းနိုင်ပါတယ်။ စစ်ဆေးမပြီးမချင်း ထပ်ငွေမလွှဲပါနဲ့။`,
            buildHelpKeyboard()
          );
        }

        try {
          const caption =
            ctx.callbackQuery
              ?.message?.caption ||
            "";

          await ctx.editMessageCaption(
            `${caption}\n\n\n` +
              `❌ PAYMENT REJECTED`
          );
        } catch (editError) {
          console.error("Failed to edit rejected payment message.");
        }

        console.log(
          `Order ${order.orderNumber} rejected.`
        );
      } catch (error) {
        console.error("Reject payment failed.");

        await ctx.reply(
          "❌ Failed to reject payment."
        );
      }
    }
  );

  // =========================
  // CANCEL ORDER
  // =========================

  bot.action(
    /^cancel_order_(\d+)$/,
    async (ctx) => {
      await ctx.answerCbQuery();

      const orderId =
        Number(ctx.match[1]);

      try {
        const order =
          await db.public.Order
            .where({
              id: orderId,
            })
            .first();

        if (!order) {
          return await ctx.reply(
            "မှာယူမှုကို မတွေ့ပါ။\n/start → My Orders မှာ ပြန်စစ်ပါ။ အကူအညီလိုရင် Help မှ ဆက်သွယ်ပါ။"
          );
        }

        if (
          order.status !==
          "PENDING_PAYMENT"
        ) {
          return await ctx.reply(
            "ဒီမှာယူမှုကို ပယ်ဖျက်မရတော့ပါ။\n/start → My Orders မှာ အခြေအနေကိုကြည့်ပါ။ လိုအပ်ရင် Help မှ ဆက်သွယ်ပါ။"
          );
        }

        const customer =
          await db.public.Customer
            .where({
              id: order.customerId,
            })
            .first();

        if (
          !customer ||
          customer.telegramId !==
            String(ctx.from.id)
        ) {
          return await ctx.reply(
            "ဒီမှာယူမှုက သင့်အကောင့်နဲ့ မသက်ဆိုင်လို့ ပယ်ဖျက်မရပါ။\n/start → My Orders မှာ သင့်မှာယူမှုကို ပြန်စစ်ပါ။"
          );
        }

        await db.public.Order
          .where({
            id: orderId,
          })
          .update({
            status: "CANCELLED",
          });

        pendingProofs.delete(
          String(ctx.from.id)
        );

        await ctx.reply(
          `🗂️ မှာယူမှု ပယ်ဖျက်ပြီးပါပြီ\n\nမှာယူမှု: ${order.orderNumber}\n\nအသစ်ဝယ်ချင်ရင် Buy VPN ကိုနှိပ်ပြီး package ပြန်ရွေးပါ။\nငွေလွှဲပြီးသားဆိုရင် Help မှ ဆက်သွယ်ပါ။`,
          buildMainMenu(ctx)
        );
      } catch (error) {
        console.error("Cancel order failed.");

        await ctx.reply(
          "မှာယူမှု ပယ်ဖျက်တာကို အတည်မပြုနိုင်သေးပါ။\n/start → My Orders မှာ ပြန်စစ်ပါ။ လိုအပ်ရင် Help မှ ဆက်သွယ်ပါ။"
        );
      }
    }
  );

  // =========================
  // MY ORDERS
  // =========================

  bot.action(
    "my_orders",
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const customer =
          await db.public.Customer
            .where({
              telegramId: String(
                ctx.from.id
              ),
            })
            .first();

        if (!customer) {
          return await ctx.reply(
            "🗂️ My Orders\n\nမှာယူထားတာ မရှိသေးပါ။\nBuy VPN ကိုနှိပ်ပြီး package ရွေးပါ။ အတည်ပြုပြီးတဲ့ မှာယူမှုတွေကို ဒီနေရာမှာ ပြန်ကြည့်နိုင်ပါတယ်။", buildMainMenu(ctx)
          );
        }

        const orders =
          await db.public.Order
            .where({
              customerId:
                customer.id,
            })
            .orderBy((order) =>
              order.createdAt.desc()
            )
            .all();

        if (!orders.length) {
          return await ctx.reply(
            "🗂️ My Orders\n\nမှာယူထားတာ မရှိသေးပါ။\nBuy VPN ကိုနှိပ်ပြီး package ရွေးပါ။ အတည်ပြုပြီးတဲ့ မှာယူမှုတွေကို ဒီနေရာမှာ ပြန်ကြည့်နိုင်ပါတယ်။", buildMainMenu(ctx)
          );
        }

        let message =
          "🗂️ My Orders — သင့်မှာယူမှုများ\n\n" +
          "အခြေအနေမှာ ငွေပေးချေရန် / စစ်ဆေးရန် စောင့်နေသလား၊ VPN ဖွင့်ပေးနေသလား၊ ပြီးပြီလားဆိုတာ ပြထားပါတယ်။\n" +
          "Screenshot ပို့ပြီးသားဆိုရင် အတည်ပြုတာကို စောင့်ပါ။ ငွေပေးချေပြီးဆိုရင် Setup VPN ကိုနှိပ်ပြီး ချိတ်ဆက်ပါ။\n" +
          "အတည်မပြုနိုင်တာ၊ ပယ်ဖျက်ထားတာနဲ့ ပတ်သက်ပြီး အကူအညီလိုရင် Help ကိုနှိပ်ပါ။\n\n";

        for (const order of orders) {
          const pkg =
            order.packageId
              ? await db.public.Package
                  .where({
                    id: order.packageId,
                  })
                  .first()
              : null;

          message +=
            `🧾 ${order.orderNumber}\n` +
            `Package: ${
              pkg?.name ||
              order.plan
            }\n` +
            `📡 Data: ${
              order.totalDataGb ||
              0
            } GB\n` +
            `⏳ ကာလ: ${order.durationMonths || 1} လ\n` +
            `🧾 ဈေးနှုန်း: ${formatMmk(order.price)}\n` +
            `အခြေအနေ: ${formatOrderStatus(order.status)}\n`;

          if (order.expiresAt) {
            message +=
              `⏳ သက်တမ်းကုန်ရက်: ${formatInstant(
                order.expiresAt
              )}\n`;
          }

          message += "\n";
        }

        await ctx.reply(
          message,
          buildMainMenu(ctx)
        );
      } catch (error) {
        console.error("Could not load orders.");

        await ctx.reply(
          "မှာယူမှုတွေကို မဖော်ပြနိုင်သေးပါ။\nခဏစောင့်ပြီး My Orders ကို ပြန်နှိပ်ပါ။"
        );
      }
    }
  );

  // =========================
  // TELEGRAM ERROR HANDLER
  // =========================

  bot.catch((error, ctx) => {
    logHandlerFailure(`update.${safeDiagnosticCode(ctx?.updateType) || "unknown"}`, error);
  });

  // =========================
  // LAUNCH
  // =========================

  console.log(
    "Starting Telegram bot..."
  );

  startupStage = "Express health server";
  await new Promise((resolve, reject) => {
    server = app.listen(PORT);
    server.once("listening", resolve);
    server.once("error", reject);
  });
  console.log("Server listening on port " + PORT);

  startupStage = "Telegram menu button";
  const metroMenuButton = buildMetroMenuButton();
  try {
    await bot.telegram.setChatMenuButton({ menuButton: metroMenuButton });
    const configuredMenuButton = await bot.telegram.getChatMenuButton();
    if (configuredMenuButton?.type !== "web_app" ||
        configuredMenuButton.text !== metroMenuButton.text ||
        configuredMenuButton.web_app?.url !== metroMenuButton.web_app.url) {
      console.error("Telegram menu button verification did not match Metro /app.");
    }
  } catch (error) {
    console.error("Telegram menu button setup failed:", {
      name: safeDiagnosticCode(error?.name),
      code: safeDiagnosticCode(error?.code),
      message: sanitizeDiagnosticMessage(error?.message),
    });
  }
  startUsageSync();

  console.log("Bot handlers registered. Starting Telegram polling...");

  // =========================
  // SHUTDOWN
  // =========================

  let shuttingDown = false;
  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `${signal} received. Shutting down...`
    );

    clearInterval(usageSyncTimer);
    try {
      bot.stop(signal);
    } catch (error) {
      if (error?.message !== "Bot is not running!") {
        logHandlerFailure("shutdown.telegram", error);
      }
    }
    await new Promise((resolve) => server.close(resolve));
    console.log("HTTP server closed.");
    try {
      await database.runtime.close();
    } catch (error) {
      logHandlerFailure("shutdown.database", error);
    }
    process.exit(exitCode);
  };

  process.once(
    "SIGINT",
    () => { void shutdown("SIGINT"); }
  );

  process.once(
    "SIGTERM",
    () => { void shutdown("SIGTERM"); }
  );

  startupStage = "Telegram polling";
  void bot.launch().catch((error) => {
    if (shuttingDown) return;
    logStartupFailure(error);
    void shutdown("Telegram polling failure", 1);
  });
}

startBot().catch((error) => {
  logStartupFailure(error);
  process.exit(1);
});
