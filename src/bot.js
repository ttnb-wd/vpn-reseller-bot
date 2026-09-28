require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const { Telegraf, Markup } = require("telegraf");
const { Temporal } = require("@js-temporal/polyfill");

const { createDatabase } = require("./db");
const { PAYMENT_METHODS } = require("./payment-config");

const {
  createAccessKey,
  setAccessKeyDataLimit,
  validateOutlineConfig,
  testOutlineConnection,
  isAccessKeyNotFoundError,
} = require("./outline");

const app = express();

// HTTPS terminates at the reverse proxy. Only trust forwarded headers from
// local/private proxy addresses; keep the Express port private in production.
app.set("trust proxy", "loopback, linklocal, uniquelocal");

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("VPN Bot is running!");
});

let server;

let bot;

const ADMIN_TELEGRAM_ID = String(
  process.env.ADMIN_TELEGRAM_ID
);

let db;

const pendingProofs = new Map();

const PROCESSING_TIMEOUT_MINUTES = 15;

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

const GB_IN_BYTES = 1024 * 1024 * 1024;
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

function safeDiagnosticCode(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}

function safeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function sanitizeDiagnosticMessage(value) {
  if (typeof value !== "string") return undefined;

  let message = value;
  const secrets = [
    process.env.OUTLINE_API_URL,
    process.env.OUTLINE_API_CERT_SHA256,
    process.env.BOT_TOKEN,
    process.env.DATABASE_URL,
    process.env.CONNECT_TOKEN_SECRET,
  ];

  try {
    const managementPath = new URL(process.env.OUTLINE_API_URL).pathname;
    if (managementPath.length > 1) secrets.push(managementPath);
  } catch {
    // Configuration validation reports malformed URLs separately.
  }

  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }

  return message
    .replace(/(?:https?|ss|postgres(?:ql)?):\/\/[^\s"'<>)]*/gi, "[redacted URL]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/(?:password|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function logStartupFailure(error) {
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
  return String(ctx.from?.id) === ADMIN_TELEGRAM_ID;
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
      "🌐 My VPN\n\nYou don't have an active VPN subscription yet.",
      buildMainMenu()
    );
    return null;
  }

  if (!isSubscriptionActive(subscription)) {
    await ctx.reply(
      "⏳ VPN Subscription Expired\n\nYour VPN package is expired or inactive.",
      renewBuyKeyboard()
    );
    return null;
  }

  if (!isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey)) {
    await ctx.reply(
      "Your VPN key is not available. Please renew or buy VPN, or contact support.",
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
      "1️⃣ Copy your VPN key\n2️⃣ Open Outline\n3️⃣ Add the VPN\n4️⃣ Tap Connect\n\n" +
      "If Outline does not open, use Safari or Chrome, or paste your key into Outline.\n" +
      "Keep your key private. The setup link expires within 10 minutes; My VPN gives you a new link.",
    Markup.inlineKeyboard([
      [copyVpnKeyButton(subscription.vpnKey), Markup.button.url("🧭 Open Outline", createVpnConnectUrl(subscription))],
      [Markup.button.callback("← Back to My VPN", "my_vpn")],
    ])
  );
}

async function sendExistingVpnKey(ctx, actionTitle) {
  const { customer, subscription } = await findCustomerSubscription(ctx.from.id);

  if (!customer || !subscription) {
    await ctx.reply(
      "🌐 My VPN\n\nYou don't have an active VPN subscription yet.",
      buildMainMenu()
    );
    return;
  }

  if (!isSubscriptionActive(subscription)) {
    await ctx.reply(
      "⏳ VPN Subscription Expired\n\nYour VPN package is expired or inactive.",
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
      "Your VPN key is not available yet. Please contact support or renew your VPN.",
      renewBuyKeyboard()
    );
    return;
  }

  await ctx.reply(
    `${actionTitle}\n\nCopy this existing key into the Outline app:\n\n${subscription.vpnKey}\n\nKeep this key private.`
  );
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

function formatMmk(value) {
  return `${formatNumber(value)} MMK`;
}

function formatOrderStatus(status) {
  return {
    PENDING_PAYMENT: "Awaiting payment review",
    PROCESSING: "Activating VPN",
    PAID: "Paid",
    PAYMENT_REJECTED: "Payment rejected",
    CANCELLED: "Cancelled",
  }[status] || status;
}

// Keep text and keyboards separate so these screens can later use photo captions.
function buildMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛡️ Buy VPN", "buy_vpn"), Markup.button.callback("🌐 My VPN", "my_vpn")],
    [Markup.button.callback("🗂️ My Orders", "my_orders"), Markup.button.callback("🛰️ Setup VPN", "setup_vpn")],
    [Markup.button.callback("🎧 Help", "help")],
  ]);
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

function buildPackageKeyboard(packages, isRenewal = false) {
  const buttons = packages.map((pkg) => Markup.button.callback(
    /premium/i.test(pkg.name) ? `💎 ${pkg.name}` : pkg.name,
    `${isRenewal ? "renew_package" : "package"}_${pkg.id}`
  ));
  return Markup.inlineKeyboard([
    ...compactButtonRows(buttons),
    [Markup.button.callback("← Back", isRenewal ? "my_vpn" : "back_to_start")],
  ]);
}

function formatPackageDetails(pkg) {
  const title = /\bplan$/i.test(pkg.name) ? pkg.name : `${pkg.name} Plan`;
  return `💎 ${title.toUpperCase()}\n\n` +
    `📡 Data: ${formatNumber(pkg.dataLimitGb)} GB\n` +
    `⏳ Duration: ${pkg.durationDays} Days\n` +
    `🧾 Price: ${formatMmk(pkg.priceMmk)}\n\n` +
    "Network:\n• Outline VPN\n• Android / iPhone / iPad\n• Windows / macOS\n" +
    "• Secure personal access key\n• Renewal uses the same VPN key";
}

function buildPackageDetailKeyboard(pkg, isRenewal = false) {
  const prefix = isRenewal ? "renew_duration" : "duration";
  return Markup.inlineKeyboard([
    [Markup.button.callback(isRenewal ? "♻️ Renew This Plan" : "🧾 Buy This Plan", `${prefix}_${pkg.id}_1`)],
    // Retain the existing multi-month purchases with database-derived day counts.
    [3, 6].map((months) => Markup.button.callback(
      `⏳ ${Number(pkg.durationDays) * months} Days`, `${prefix}_${pkg.id}_${months}`
    )),
    [Markup.button.callback("← Back to Packages", isRenewal ? "renew_vpn" : "buy_vpn")],
  ]);
}

function formatPurchaseConfirmation(pkg, durationMonths, isRenewal = false) {
  const { totalDataGb, totalPriceMmk, durationDays } = calculatePackage(pkg, durationMonths);
  return `🧾 Confirm Your ${isRenewal ? "Renewal" : "Order"}\n\n` +
    `Plan: ${pkg.name}\n📡 Data: ${formatNumber(totalDataGb)} GB\n` +
    `⏳ Duration: ${durationDays} Days\n🧾 Price: ${formatMmk(totalPriceMmk)}\n\n` +
    "Please confirm before continuing.";
}

function buildConfirmationKeyboard(pkg, durationMonths, isRenewal = false) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(isRenewal ? "Confirm Renewal" : "Confirm Purchase",
      `${isRenewal ? "confirm_renewal" : "confirm_package"}_${pkg.id}_${durationMonths}`)],
    [Markup.button.callback("← Back", `${isRenewal ? "renew_package" : "package"}_${pkg.id}`)],
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
  return `VPN ${isRenewal ? "RENEWED" : "ACTIVATED"}\n\nYour VPN is ready.\n\n` +
    `Plan: ${pkg.name}\n📡 Data: ${formatNumber(dataLimitGb)} GB\n` +
    `⏳ Expiry: ${formatInstant(expiresAt)}\nStatus: Active\n\nNext step 👇`;
}

function buildHelpKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛰️ VPN Setup", "setup_vpn"), Markup.button.callback("🧾 Payment Help", "payment_help")],
    [Markup.button.callback("🌐 My VPN", "my_vpn"),
      Markup.button.url("Contact Support", `tg://user?id=${ADMIN_TELEGRAM_ID}`)],
    [Markup.button.callback("← Main Menu", "back_to_start")],
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
  return `🧾 Payment\n\nOrder: ${order.orderNumber}\nPlan: ${order.plan}\n` +
    `Amount: ${formatMmk(order.price)}\n\n` +
    "1️⃣ Choose a payment method\n2️⃣ Send the exact amount\n3️⃣ Upload the payment screenshot";
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

async function sendMainMenu(ctx) {
  await ctx.reply(
    "👋 Welcome to Metro VPN\n\nFast • Secure • Simple\n\n" +
      "VPN စသုံးဖို့ 3 steps ပဲလိုပါတယ်:\n\n" +
      "1️⃣ VPN Package ရွေးပါ\n2️⃣ Payment ပြုလုပ်ပါ\n3️⃣ VPN Setup လုပ်ပြီး Connect လုပ်ပါ\n\n" +
      "အောက်က menu ကနေ စတင်နိုင်ပါတယ် 👇",
    buildMainMenu()
  );
}

async function getActivePackages() {
  return await db.public.Package
    .where({
      active: true,
    })
    .orderBy((pkg) =>
      pkg.sortOrder.asc()
    )
    .all();
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
  isRenewal = false
) {
  try {
    const pkg =
      await getPackageById(packageId);

    if (!pkg) {
      return await ctx.reply(
        "❌ Package not found or currently unavailable."
      );
    }

    const {
      totalDataGb,
      totalPriceMmk,
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
          "❌ You don't have a VPN subscription yet.\n\nPlease use Buy VPN first."
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
      return await ctx.reply("Please choose your package again from Buy VPN.", buildMainMenu());
    }
    const purchaseId = crypto.createHash("sha256").update(JSON.stringify([
      String(ctx.from.id), confirmation.chat.id, confirmation.message_id,
      pkg.id, durationMonths, isRenewal,
    ])).digest("hex").slice(0, 32);
    const orderNumber = `VPN-${purchaseId}`;
    const order = await db.public.Order.upsert({
      conflictOn: { orderNumber: true },
      create: {
        orderNumber, plan, packageId: pkg.id, durationMonths,
        totalDataGb, price: totalPriceMmk, status: "PENDING_PAYMENT", customerId: customer.id,
      },
      update: { orderNumber },
    });

    if (order.status !== "PENDING_PAYMENT") {
      await ctx.reply(
        `🗂️ Order: ${order.orderNumber}\nStatus: ${formatOrderStatus(order.status)}\n\nOpen My Orders for details.`,
        buildMainMenu()
      );
      return order;
    }

    await ctx.reply(formatPayment(order), buildPaymentKeyboard(order));
    return order;
  } catch (error) {
    console.error("Create package order failed.");

    await ctx.reply(
      "❌ Failed to create order."
    );
  }
}

async function startBot() {
  console.log("Starting VPN Bot...");

  startupStage = "production config validation";
  validateOutlineConfig();
  getConnectConfig();

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

  // =========================
  // START
  // =========================

  bot.start(async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(
      `Your Telegram ID:\n${ctx.from.id}`
    );
  });

  // =========================
  // MY VPN
  // =========================

  bot.action("my_vpn", async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const { customer, subscription } = await findCustomerSubscription(ctx.from.id);

      if (!customer || !subscription) {
        return await ctx.reply(
          "🌐 My VPN\n\nYou don't have an active VPN subscription yet.",
          buildMainMenu()
        );
      }

      if (!isSubscriptionActive(subscription)) {
        return await ctx.reply(
          "⏳ VPN Subscription Expired\n\nYour VPN package has expired or is inactive.",
          renewBuyKeyboard()
        );
      }

      const pkg = subscription.packageId
        ? await db.public.Package.where({ id: subscription.packageId }).first()
        : null;
      const packageLabel = pkg?.name || subscription.plan || "VPN package";
      const hasReusableKey = Boolean(subscription.vpnKeyId &&
        isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) &&
        isValidOutlineAccessKey(subscription.vpnKey));

      await ctx.reply(
        `🌐 My VPN\n\nPlan: ${packageLabel}\n` +
          `📡 Usage: ${formatNumber(subscription.dataUsedGb || 0)} GB / ${formatNumber(subscription.dataLimitGb || 0)} GB\n` +
          `⏳ Expiry: ${formatInstant(subscription.expiresAt)}\nStatus: Active` +
          (hasReusableKey ? "" : "\n\nYour VPN key is unavailable. Please contact support."),
        buildMyVpnKeyboard(subscription)
      );
    } catch {
      console.error("Could not load My VPN.");

      await ctx.reply(
        "❌ Failed to load VPN information."
      );
    }
  });

  bot.action("copy_vpn_key", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await sendExistingVpnKey(ctx, "Copy VPN Key");
    } catch {
      console.error("Could not load VPN key for copying.");
      await ctx.reply("Failed to load your VPN key.");
    }
  });

  bot.action(/^(?:setup_vpn|add_device)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await sendVpnSetup(ctx);
    } catch {
      console.error("Could not load VPN setup.");
      await ctx.reply("Failed to load VPN setup. Please try again from My VPN.");
    }
  });

  bot.action(/^setup_platform_(android|ios|windows|macos)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      // Old device-picker messages now issue the same direct helper link.
      await sendVpnSetup(ctx);
    } catch {
      console.error("Could not load platform VPN setup.");
      await ctx.reply("Failed to load VPN setup. Please try again from My VPN.");
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
      } catch {
        console.error("Could not load VPN setup from the connection link.");
        await ctx.reply("Failed to load VPN setup. Please try again from My VPN.");
      }
    }
  );

  // =========================
  // RENEW VPN
  // =========================

  bot.action(
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
            "❌ Customer account not found."
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
            "❌ You don't have a VPN subscription yet.\n\nPlease use Buy VPN first."
          );
        }

        const packages =
          await getActivePackages();

        if (!packages.length) {
          return await ctx.reply(
            "❌ No VPN packages are currently available."
          );
        }

        await ctx.reply(
          "♻️ Choose Your Renewal Package\n\nသင့်အတွက်သင့်တော်တဲ့ package ကိုရွေးပါ 👇",
          buildPackageKeyboard(packages, true)
        );
      } catch (error) {
        console.error("Renew package failed.");

        await ctx.reply(
          "❌ Failed to load renewal packages."
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
          return await ctx.reply(
            "❌ Package not found."
          );
        }

        await ctx.reply(formatPackageDetails(pkg), buildPackageDetailKeyboard(pkg, true));
      } catch (error) {
        console.error("Renew package selection failed.");

        await ctx.reply(
          "❌ Failed to load renewal package."
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
          return await ctx.reply(
            "❌ Package not found."
          );
        }

        await ctx.reply(
          formatPurchaseConfirmation(pkg, durationMonths, true),
          buildConfirmationKeyboard(pkg, durationMonths, true)
        );
      } catch (error) {
        console.error("Renew duration selection failed.");

        await ctx.reply(
          "❌ Failed to calculate renewal."
        );
      }
    }
  );

  bot.action(
    /^confirm_renewal_(\d+)_(1|3|6)$/,
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
        true
      );
    }
  );

  // =========================
  // BUY VPN
  // =========================

  bot.action(
    "buy_vpn",
    async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const packages =
          await getActivePackages();

        if (!packages.length) {
          return await ctx.reply(
            "❌ No VPN packages are currently available."
          );
        }

        await ctx.reply(
          "💎 Choose Your VPN Package\n\nသင့်အတွက်သင့်တော်တဲ့ package ကိုရွေးပါ 👇",
          buildPackageKeyboard(packages)
        );
      } catch (error) {
        console.error("Could not load packages.");

        await ctx.reply(
          "❌ Failed to load VPN packages."
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
          return await ctx.reply(
            "❌ Package not found or unavailable."
          );
        }

        await ctx.reply(formatPackageDetails(pkg), buildPackageDetailKeyboard(pkg));
      } catch (error) {
        console.error("Package selection failed.");

        await ctx.reply(
          "❌ Failed to load package."
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
          return await ctx.reply(
            "❌ Package not found or unavailable."
          );
        }

        await ctx.reply(
          formatPurchaseConfirmation(pkg, durationMonths),
          buildConfirmationKeyboard(pkg, durationMonths)
        );
      } catch (error) {
        console.error("Duration selection failed.");

        await ctx.reply(
          "❌ Failed to calculate package price."
        );
      }
    }
  );

  // =========================
  // CONFIRM PACKAGE
  // =========================

  bot.action(
    /^confirm_package_(\d+)_(1|3|6)$/,
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
        false
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

      await sendMainMenu(ctx);
    }
  );

  // =========================
  // HELP
  // =========================

  bot.action("help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "🎧 Metro VPN Help\n\nHaving trouble?\nChoose what you need help with:",
      buildHelpKeyboard()
    );
  });

  bot.action("payment_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "🧾 Payment Help\n\n1️⃣ Choose a method on your order's Payment screen\n" +
        "2️⃣ Send the exact amount to the displayed account\n3️⃣ Upload a clear screenshot in this chat\n\n" +
        "After uploading, wait for admin approval. For payment questions, contact support with your order number.",
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
          "❌ Order not found."
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
          "❌ You are not authorized to access this order."
        );
      }

      if (
        order.status !==
        "PENDING_PAYMENT"
      ) {
        return await ctx.reply(
          `⚠️ This order cannot accept payment.\n\nStatus: ${order.status}`
        );
      }

      const payment =
        PAYMENT_METHODS[method];

      if (!payment) {
        return await ctx.reply(
          "❌ Payment method unavailable."
        );
      }

      await db.public.Order
        .where({
          id: orderId,
        })
        .update({
          paymentMethod: method,
        });

      await ctx.reply(
        `🧾 Payment — ${payment.name}\n\n` +
          `Order: ${order.orderNumber}\nPlan: ${order.plan}\nAmount: ${formatMmk(order.price)}\n\n` +
          `Account Name: ${payment.accountName}\nAccount Number: ${payment.accountNumber}\n\n` +
          "Send the exact amount, then upload your payment screenshot in this chat.",
        buildPaymentKeyboard(order)
      );

      pendingProofs.set(
        String(ctx.from.id),
        orderId
      );
    } catch (error) {
      console.error("Payment method selection failed.");

      await ctx.reply(
        "❌ Something went wrong."
      );
    }
  }

  // =========================
  // PAYMENT PROOF
  // =========================

  bot.on("photo", async (ctx) => {
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
          "❌ Order not found."
        );
      }

      if (
        order.status !==
        "PENDING_PAYMENT"
      ) {
        pendingProofs.delete(
          userId
        );

        return await ctx.reply(
          "⚠️ This order is no longer waiting for payment."
        );
      }

      const photos =
        ctx.message.photo;

      const paymentProof =
        photos[
          photos.length - 1
        ].file_id;

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
        "🧾 Payment Screenshot Received\n\nYour payment is awaiting admin review. We'll notify you when your VPN is ready.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🗂️ My Orders", "my_orders"), Markup.button.callback("🎧 Help", "payment_help")],
        ])
      );

      const customer =
        await db.public.Customer
          .where({
            id: order.customerId,
          })
          .first();

      const pkg = order.packageId
        ? await db.public.Package
            .where({
              id: order.packageId,
            })
            .first()
        : null;

      const adminCaption =
        `💰 PAYMENT VERIFICATION\n\n` +
        `Order: ${order.orderNumber}\n` +
        `Package: ${
          pkg?.name || order.plan
        }\n` +
        `Duration: ${getDurationLabel(
          order.durationMonths || 1
        )}\n` +
        `Data: ${formatNumber(
          order.totalDataGb || 0
        )} GB\n` +
        `Price: ${formatNumber(
          order.price
        )} MMK\n\n` +
        `Customer: ${
          customer?.firstName ||
          "N/A"
        }\n` +
        `Username: @${
          customer?.username ||
          "N/A"
        }\n` +
        `Telegram ID: ${
          customer?.telegramId ||
          "N/A"
        }`;

      await bot.telegram.sendPhoto(
        ADMIN_TELEGRAM_ID,
        paymentProof,
        {
          caption: adminCaption,

          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "✅ Approve",
                `approve_payment_${order.id}`
              ),

              Markup.button.callback(
                "❌ Reject",
                `reject_payment_${order.id}`
              ),
            ],
          ]),
        }
      );
    } catch (error) {
      console.error("Payment proof handling failed.");

      await ctx.reply(
        "❌ Failed to submit payment proof."
      );
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

        const totalDataGb =
          Number(order.totalDataGb) ||
          Number(pkg.dataLimitGb) *
            durationMonths;

        const durationDays =
          Number(pkg.durationDays) *
          durationMonths;

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

            accessKey =
              await createAccessKey(
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

          const expiresAt =
            now.add({
              hours:
                durationDays * 24,
            });

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

                plan:
                  `${pkg.name} - ${getDurationLabel(
                    durationMonths
                  )}`,

                status: "ACTIVE",

                durationMonths,

                vpnKey:
                  accessKey.accessUrl,

                vpnKeyId:
                  accessKey.id,

                vpnKeyCreatedAt:
                  now,

                startedAt:
                  now,

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
                now,

              startedAt:
                now,

              expiresAt,

              revokedAt:
                null,
            });

          // ---------------------------------
          // 14. Notify customer
          // ---------------------------------

          await bot.telegram.sendMessage(
            customer.telegramId,
            formatActivation(pkg, totalDataGb, expiresAt),
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
            renewalAccessKey = await createAccessKey(order);

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

          const isFuture =
            subscription.expiresAt &&
            Temporal.Instant.compare(
              subscription.expiresAt,
              now
            ) > 0;

          const newExpiresAt = (
            isFuture
              ? subscription.expiresAt
              : now
          ).add({
            hours:
              durationDays * 24,
          });

          const currentDataLimitGb =
            Number(
              subscription.dataLimitGb || 0
            );

          const newTotalDataGb =
            currentDataLimitGb +
            totalDataGb;

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
            const replacement = await createAccessKey(order);
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

              plan:
                `${pkg.name} - ${getDurationLabel(
                  durationMonths
                )}`,

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
            formatActivation(pkg, newTotalDataGb, newExpiresAt, true),
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

            `🧾 Payment Rejected\n\n` +
              `Order: ${order.orderNumber}\n\n` +
              `Please contact support with your order number for help.`,
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
            "❌ Order not found."
          );
        }

        if (
          order.status !==
          "PENDING_PAYMENT"
        ) {
          return await ctx.reply(
            "⚠️ This order cannot be cancelled."
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
            "❌ You are not authorized to cancel this order."
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
          `🗂️ Order cancelled.\n\nOrder: ${order.orderNumber}`,
          buildMainMenu()
        );
      } catch (error) {
        console.error("Cancel order failed.");

        await ctx.reply(
          "❌ Failed to cancel order."
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
            "🗂️ My Orders\n\nYou don't have any orders yet.", buildMainMenu()
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
            "🗂️ My Orders\n\nYou don't have any orders yet.", buildMainMenu()
          );
        }

        let message =
          "🗂️ My Orders\n\n";

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
            `Plan: ${
              pkg?.name ||
              order.plan
            }\n` +
            `📡 Data: ${
              order.totalDataGb ||
              0
            } GB\n` +
            `⏳ Duration: ${getDurationLabel(
              order.durationMonths ||
                1
            )}\n` +
            `🧾 Price: ${formatNumber(
              order.price
            )} MMK\n` +
            `Status: ${formatOrderStatus(order.status)}\n`;

          if (order.expiresAt) {
            message +=
              `⏳ Expiry: ${formatInstant(
                order.expiresAt
              )}\n`;
          }

          message += "\n";
        }

        await ctx.reply(
          message,
          buildMainMenu()
        );
      } catch (error) {
        console.error("Could not load orders.");

        await ctx.reply(
          "❌ Failed to load orders."
        );
      }
    }
  );

  // =========================
  // TELEGRAM ERROR HANDLER
  // =========================

  bot.catch(() => {
    console.error("Telegram bot handler failed.");
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

  startupStage = "Telegram launch";
  await bot.launch();

  console.log(
    "VPN Bot is running..."
  );

  // =========================
  // SHUTDOWN
  // =========================

  const shutdown = (signal) => {
    console.log(
      `${signal} received. Shutting down...`
    );

    bot.stop(signal);

    server.close(() => {
      console.log(
        "HTTP server closed."
      );

      process.exit(0);
    });
  };

  process.once(
    "SIGINT",
    () => shutdown("SIGINT")
  );

  process.once(
    "SIGTERM",
    () => shutdown("SIGTERM")
  );
}

startBot().catch((error) => {
  logStartupFailure(error);
  process.exit(1);
});
