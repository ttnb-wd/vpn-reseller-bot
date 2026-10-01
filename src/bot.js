if (process.env.NODE_ENV !== "production") require("dotenv").config({ quiet: true });

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const { Telegraf, Markup, Input } = require("telegraf");
const { Temporal } = require("@js-temporal/polyfill");

const { createCoordination } = require("./coordination");
const { writeEntitlementAllowance } = require("./entitlement-write");
const { validateProductionEnvironment, createReadiness } = require("./startup-health");
const { createLifecycle } = require("./lifecycle");
const { createSingletonStartup, createSingletonHttpGate } = require("./singleton-startup");
const lifecycle = createLifecycle({ exit: code => process.exit(code) });
let coordination, recoveryTimer, recoveryRun, shutdownProcess, singletonStartup;
let botHealthy = false, envValidated = false;
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
const { connectCopy } = require("./mini-app-connect-copy");
const { OUTLINE_DOWNLOADS, outlinePlatform } = require("./outline-setup");
const { effectiveSubscriptionState } = require("./subscription-state");
const { createExpiryWorker } = require("./expiry-worker");
const { createDynamicKeys, createDynamicConfigRouter } = require("./dynamic-config");
const { createSubscriptionNotifications, renewalNotificationReset } = require("./subscription-notifications");
const { createNotificationStore } = require("./notification-store");
const { USAGE_SYNC_INTERVAL_MS } = require("./worker-intervals");
const { safeDiagnosticCode, sanitizeDiagnosticMessage,
  logHandlerFailure } = require("./safe-diagnostics");

const {
  createOrderAccessKey: createRemoteOrderAccessKey,
  setAccessKeyDataLimit: writeRemoteAccessKeyLimit,
  validateOutlineConfig,
  testOutlineConnection,
  getAllAccessKeyUsage,
  getExistingAccessKeyIds,
  isAccessKeyNotFoundError,
  deleteAccessKey: deleteRemoteAccessKey,
} = require("./outline");

async function createOrderAccessKey(order) {
  coordination?.assertCurrent?.();
  const key = await createRemoteOrderAccessKey(order);
  coordination?.assertCurrent?.();
  return key;
}
async function setAccessKeyDataLimit(id, bytes) {
  coordination?.assertCurrent?.();
  await writeRemoteAccessKeyLimit(id, bytes);
  coordination?.assertCurrent?.();
}
async function deleteAccessKey(id) {
  coordination?.assertCurrent?.();
  await deleteRemoteAccessKey(id);
  coordination?.assertCurrent?.();
}

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

const isReady = createReadiness({ configured: () => envValidated,
  botHealthy: () => botHealthy, ownsLease: () => Boolean(coordination?.owned),
  stopping: () => lifecycle.stopping,
  checkDatabase: () => db.public.Customer.where({ id: 0 }).first() });
app.get("/", async (_req, res) => {
  const ready = await isReady();
  res.status(ready ? 200 : 503).send(ready ? "VPN Bot is running!" : "Service is not ready.");
});
app.get("/live", (_req, res) => res.sendStatus(lifecycle.stopping ? 503 : 200));
app.get("/ready", async (_req, res) => {
  const ready = await isReady();
  res.status(ready ? 200 : 503).json({ ready });
});
app.use((_req, res, next) => lifecycle.stopping ? res.sendStatus(503) : next());
app.use(createSingletonHttpGate(() => envValidated &&
  (botHealthy && Boolean(coordination?.owned) && !lifecycle.stopping)));
let server;

let bot;
let miniAppSupportService;

const ADMIN_TELEGRAM_ID = String(
  process.env.ADMIN_TELEGRAM_ID
);

let db;
let usageSyncTimer;
let usageSyncRunning = false;
let usageSyncCompletion;
let expiryWorker;
let dynamicKeys;
let subscriptionNotifications;
let notificationStore;

app.use("/vpn/config", createDynamicConfigRouter({ getClient: () => db }));

function customerAccessUrl(subscription) {
  return dynamicKeys && subscription.dynamicTokenHash
    ? dynamicKeys.accessUrl(subscription) : subscription.vpnKey;
}

async function prepareDynamicSubscription(subscription) {
  const prepared = dynamicKeys ? await dynamicKeys.ensure(subscription) : subscription;
  return withOutlineProfileCustomer(prepared);
}

async function withOutlineProfileCustomer(subscription) {
  const customer = await db.public.Customer.where({ id: subscription.customerId }).first();
  return { ...subscription, outlineProfileCustomer: {
    username: customer?.username, firstName: customer?.firstName,
  } };
}

const pendingProofs = new Map();
const allowProofUpload = createWindowLimiter({ windowMs: 60000, max: 6 });
const allowConnect = createWindowLimiter({ windowMs: 60000, max: 30 });
const allowNewOrder = createWindowLimiter({ windowMs: 60000, max: 6 });
const allowMiniFlow = createWindowLimiter({ windowMs: 60000, max: 6 });
const allowMiniConnect = createWindowLimiter({ windowMs: 60000, max: 12 });
const recentConfirmations = new Map();
const MINI_PAYMENT_CALLBACKS = { bank_transfer: "bank", mobile_wallet: "wallet" };

const PROCESSING_TIMEOUT_MINUTES = 15;

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
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

function renderVpnConnectPage(vpnKey, nonce, remainingMs, language = "my") {
  const t = (value) => connectCopy(value, language);
  return `<!doctype html>
<html lang="${language === "en" ? "en" : "my"}">
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
    <p id="status" role="status" aria-live="polite">${t("Outline ကို ဖွင့်ပေးနေပါတယ်…")}</p>
    <p>${t("Outline မပွင့်ရင် အောက်ကခလုတ်ကို နှိပ်ပေးပါ။")}</p>
    <button id="open-outline" type="button">Open Outline</button>
    <button id="copy-key" class="secondary" type="button">${t("Copy VPN Key")}</button>
    <button id="need-outline" class="secondary" type="button">${t("Outline လိုပါသလား။")}</button>
    <section id="outline-install" hidden aria-label="${t("Outline လိုပါသလား။")}">
      <h2>${t("Outline လိုပါသလား။")}</h2>
      <p>${t("Outline ကို အရင်သွင်းပြီး ဒီစာမျက်နှာကို ပြန်လာကာ Connect ကို ထပ်နှိပ်ပေးပါ။")}</p>
      <button id="download-outline" type="button">${t("Download Outline")}</button>
      <button id="install-back" class="secondary" type="button">${t("နောက်သို့")}</button>
    </section>
    <p id="platform-help" class="hint">${t("Outline ဖွင့်ဖို့ ခွင့်ပြုပြီး Add → Connect ကိုနှိပ်ပေးပါ။")}</p>
    <p class="hint">${t("မပွင့်ရင် ဒီစာမျက်နှာကို Safari / Chrome နဲ့ ဖွင့်ကြည့်ပေးပါ။")}
      ${t("VPN key ကို ကူးပြီး Outline ထဲ ထည့်လို့လည်း ရပါတယ်။ Link က 10 မိနစ်အတွင်း သက်တမ်းကုန်ပါတယ်။ မမျှဝေပေးပါနဲ့။")}</p>
    <noscript>${t("Outline ဖွင့်ဖို့ JavaScript ကို ဖွင့်ပေးပါ။")}</noscript>
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
      const downloads = ${scriptJson(OUTLINE_DOWNLOADS)};
      const platform = (${outlinePlatform.toString()})(navigator);
      const destination = downloads[platform] || downloads.desktop;
      const install = document.getElementById("outline-install");
      const downloadButton = document.getElementById("download-outline");
      downloadButton.textContent = platform === "ios" ? ${scriptJson(t("App Store ကို ဖွင့်ရန်"))} :
        platform === "android" ? ${scriptJson(t("Google Play ကို ဖွင့်ရန်"))} : ${scriptJson(t("Download Outline"))};
      function showInstall() { install.hidden = false; }
      document.getElementById("need-outline").addEventListener("click", showInstall);
      document.getElementById("install-back").addEventListener("click", () => {
        clearTimeout(hintTimer);
        install.hidden = true;
        openButton.focus();
      });
      downloadButton.addEventListener("click", () => {
        clearTimeout(hintTimer);
        // Only this explicit click leaves for a constant official destination.
        // No access key, token, referrer, analytics or automatic store redirect.
        window.location.href = destination;
      });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) clearTimeout(hintTimer);
      });
      window.addEventListener("pagehide", () => clearTimeout(hintTimer));
      function isUsable() {
        if (vpnKey && performance.now() < deadline) return true;
        vpnKey = "";
        openButton.disabled = true;
        copyButton.disabled = true;
        status.textContent = ${scriptJson(t("ဒီ link က သက်တမ်းကုန်သွားပါပြီ။ My VPN မှာ Connect ကို ပြန်နှိပ်ပေးပါ။"))};
        return false;
      }
      function openOutline() {
        if (!isUsable()) return;
        clearTimeout(hintTimer);
        install.hidden = true;
        status.textContent = ${scriptJson(t("Outline ကို ဖွင့်ပေးနေပါတယ်…"))};
        // Keep this synchronous inside the real click. No fetch, await, timer,
        // iframe, invented scheme, or automatic store redirect.
        try { window.location.href = vpnKey; } catch {
          status.textContent = ${scriptJson(t("Outline မပွင့်သေးပါဘူး။ VPN key ကို ကူးပြီး Outline ထဲ ထည့်ပေးပါ။"))};
        }
        // Browsers cannot reliably report whether a custom-scheme app opened.
        hintTimer = setTimeout(() => {
          if (!document.hidden && isUsable()) {
            status.textContent = ${scriptJson(t("Outline မပွင့်ရင် Open Outline ကိုနှိပ်ပေးပါ။ VPN key ကို ကူးထည့်လို့လည်း ရပါတယ်။"))};
            showInstall();
          }
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
          if (isUsable()) status.textContent = ${scriptJson(t("VPN key ကူးပြီးပါပြီ။ Outline ထဲ ထည့်ပြီး Add → Connect ကိုနှိပ်ပေးပါ။"))};
        } catch {
          if (!isUsable()) return;
          // A rejected async clipboard call may consume user activation. The
          // next click performs the legacy copy synchronously with a new gesture.
          useLegacyCopy = true;
          status.textContent = ${scriptJson(t("ကူးလို့မရသေးပါဘူး။ Copy VPN Key ကို ပြန်နှိပ်ပေးပါ။"))};
        }
      });
      const ua = navigator.userAgent;
      const isAppleMobile = /iPhone|iPad|iPod/.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const help = document.getElementById("platform-help");
      if (isAppleMobile) {
        help.textContent = ${scriptJson(t("Safari က မေးလာရင် Open ကိုနှိပ်ပေးပါ။ မပွင့်ရင် Open Outline ကိုနှိပ်ပြီး Add → Connect ကိုနှိပ်ပေးပါ။"))};
      } else if (/Android/.test(ua)) {
        help.textContent = ${scriptJson(t("Open Outline ကိုနှိပ်ပေးပါ။ Chrome က မေးလာရင် Outline ကိုရွေးပြီး Add → Connect ကိုနှိပ်ပေးပါ။"))};
      } else if (/Windows/.test(ua)) {
        help.textContent = ${scriptJson(t("Outline ဖွင့်ဖို့ ခွင့်ပြုပေးပါ။ Windows က app ရွေးခိုင်းရင် Outline ကိုရွေးပြီး key ထည့်ပေးပါ။ ပြီးရင် Connect ကိုနှိပ်ပေးပါ။"))};
      } else if (/Mac/.test(ua)) {
        help.textContent = ${scriptJson(t("Mac မှာ Outline ဖွင့်ဖို့ ခွင့်ပြုပေးပါ။ Key ထည့်ပြီး Connect ကိုနှိပ်ပေးပါ။"))};
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
  const language = req.query.lang === "en" ? "en" : "my";
  const t = (value) => connectCopy(value, language);
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
    return res.status(429).type("text").send(t("ခဏစောင့်ပြီးမှ Connect ကို ပြန်နှိပ်ပေးပါ။"));
  }
  // Never redirect an HTTP request with a bearer token or send it a VPN key.
  if (!req.secure) return res.status(400).type("text").send(t("My VPN မှာ Connect ကို ပြန်နှိပ်ပေးပါ။"));
  const invalidLink = () => res.status(410).type("text").send(
    t("ဒီ link က သုံးလို့မရတော့ပါဘူး။ My VPN မှာ Connect ကို ပြန်နှိပ်ပေးပါ။")
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
    const namedSubscription = await withOutlineProfileCustomer(subscription);
    return res.type("html").send(renderVpnConnectPage(customerAccessUrl(namedSubscription), nonce, remainingMs, language));
  } catch {
    console.error("VPN setup page could not be loaded.");
    return res.status(503).type("text").send(t("Connect ကို အခုဖွင့်လို့မရသေးပါဘူး။ ခဏနေရင် My VPN မှာ ပြန်စမ်းကြည့်ပေးပါ။"));
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
  return effectiveSubscriptionState(subscription, now) === "ACTIVE";
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
    [Markup.button.callback("🎧 Support", "help")],
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
      "🌐 My VPN\n\nလက်ရှိ VPN မရှိသေးပါဘူး။\nစသုံးချင်ရင် Buy VPN မှာ package ရွေးလို့ရပါတယ်။",
      buildMainMenu(ctx)
    );
    return null;
  }

  if (!isSubscriptionActive(subscription)) {
    await ctx.reply(
      "VPN ကို လောလောဆယ် သုံးလို့မရပါဘူး။\nMy VPN မှာ အခြေအနေကို ကြည့်ပေးပါ။ အကူအညီလိုရင် Support မှာ မေးလို့ရပါတယ်။",
      renewBuyKeyboard()
    );
    return null;
  }

  if (!isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey)) {
    await ctx.reply(
      "VPN key ကို အခုယူလို့မရသေးပါဘူး။\nSupport မှာ ဆက်သွယ်ပေးပါ။",
      renewBuyKeyboard()
    );
    return null;
  }

  return prepareDynamicSubscription(subscription);
}

async function sendVpnSetup(ctx) {
  const subscription = await getUsableVpnSubscription(ctx);
  if (!subscription) return;

  await ctx.reply(
    "🛰️ Setup VPN\n\n" +
      "VPN ချိတ်ဆက်ဖို့ Outline app လိုပါတယ်။\n\n" +
      "Outline ရှိပြီးသားဆို Connect ကိုနှိပ်ပါ။\n" +
      "မရှိသေးရင် Download Outline ကိုနှိပ်ပြီး အရင်သွင်းပေးပါ။\n\n" +
      "Link က 10 မိနစ်အတွင်း သက်တမ်းကုန်ပါတယ်။ လိုရင် Setup VPN ကို ပြန်နှိပ်ပေးပါ။ VPN key ကို မမျှဝေပေးပါနဲ့။",
    Markup.inlineKeyboard([
      [copyVpnKeyButton(customerAccessUrl(subscription)), Markup.button.url("Connect", createVpnConnectUrl(subscription))],
      [Markup.button.callback("⬅️ Back", "my_vpn")],
      [Markup.button.url("Download Outline", OUTLINE_DOWNLOADS.desktop)],
    ])
  );
}

async function sendExistingVpnKey(ctx, actionTitle) {
  const { customer, subscription } = await findCustomerSubscription(ctx.from.id);

  if (!customer || !subscription) {
    await ctx.reply(
      "🌐 My VPN\n\nလက်ရှိ VPN မရှိသေးပါဘူး။\nစသုံးချင်ရင် Buy VPN မှာ package ရွေးလို့ရပါတယ်။",
      buildMainMenu(ctx)
    );
    return;
  }

  if (!isSubscriptionActive(subscription)) {
    await ctx.reply(
      "VPN ကို လောလောဆယ် သုံးလို့မရပါဘူး။\nMy VPN မှာ အခြေအနေကို ကြည့်ပေးပါ။ အကူအညီလိုရင် Support မှာ မေးလို့ရပါတယ်။",
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
      "VPN key ကို အခုယူလို့မရသေးပါဘူး။\nSupport မှာ ဆက်သွယ်ပေးပါ။",
      renewBuyKeyboard()
    );
    return;
  }

  const prepared = await prepareDynamicSubscription(subscription);
  await ctx.reply(
    `${actionTitle}\n\nဒါက လက်ရှိ VPN key ပါ။ အောက်က key ကို ကူးပေးပါ။\n\n${customerAccessUrl(prepared)}\n\nOutline ထဲမှာ key ထည့်ပြီး Add → Connect ကိုနှိပ်ပေးပါ။ VPN key ကို မမျှဝေပေးပါနဲ့။`
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

function formatOrderStatus(status, proofSubmitted = false) {
  if (status === "PENDING_PAYMENT" && proofSubmitted) return "Slip ရပါပြီ။ စစ်ဆေးပေးနေပါတယ်";
  return {
    PENDING_PAYMENT: "ငွေပေးချေဖို့ စောင့်နေပါတယ်",
    PAYMENT_SUBMITTED: "Slip ရပါပြီ",
    PROCESSING: "ခဏစောင့်ပေးပါ",
    PAID: "VPN သုံးလို့ရပါပြီ",
    PAYMENT_REJECTED: "Slip ကို အတည်ပြုလို့မရသေးပါဘူး",
    CANCELLED: "မှာယူမှုကို ပယ်ဖျက်ထားပါတယ်",
    EXPIRED: "သက်တမ်းကုန်ပါပြီ",
  }[status] || "Support မှာ မေးကြည့်ပေးပါ";
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
    `${packageSelectionLabel(pkg)}\n${formatNumber(pkg.dataLimitGb)} GB\n${pkg.durationDays} ရက်\n${formatMmk(pkg.priceMmk)} ကျပ်`
  ).join("\n\n");
  return `လိုအပ်တဲ့ VPN package ကို ရွေးပေးပါ။\n\n${summary}`;
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
  return `${pkg.name}\n${formatNumber(pkg.dataLimitGb)} GB\n${pkg.durationDays} ရက်\n${formatMmk(pkg.priceMmk)} ကျပ်\n\n` +
    (isRenewal ? "သက်တမ်းတိုးမယ်ဆို ‘သက်တမ်းတိုး’ ကိုနှိပ်ပေးပါ။" : "ဆက်ဝယ်မယ်ဆို ‘ဝယ်မယ်’ ကိုနှိပ်ပေးပါ။");
}

function buildPackageDetailKeyboard(pkg, isRenewal = false) {
  const prefix = isRenewal ? "renew_duration" : "duration";
  return Markup.inlineKeyboard([
    [Markup.button.callback(isRenewal ? "♻️ သက်တမ်းတိုး" : "🧾 ဝယ်မယ်", `${prefix}_${pkg.id}_1`)],
    // Retain longer purchases with database-derived day counts.
    [3, 6].map((months) => Markup.button.callback(
      `⏳ ${Number(pkg.durationDays) * months} ရက်`, `${prefix}_${pkg.id}_${months}`
    )),
    [Markup.button.callback("⬅️ Back", isRenewal ? "renew_vpn" : "buy_vpn")],
  ]);
}

function formatPurchaseConfirmation(pkg, durationMonths, isRenewal = false) {
  const { totalDataGb, totalPriceMmk, durationDays } = calculatePackage(pkg, durationMonths);
  return `ဒီ package ကို ရွေးထားပါတယ်။\n\n${pkg.name}\n${formatNumber(totalDataGb)} GB\n${durationDays} ရက်\n${formatMmk(totalPriceMmk)} ကျပ်\n\n` +
    (isRenewal ? "ရှိပြီးသား VPN ကိုပဲ ဆက်သုံးလို့ရပါတယ်။\n" : "") +
    "VPN အသုံးပြုဖို့ Outline app လိုပါတယ်။\nမရှိသေးရင် VPN ဖွင့်ပေးပြီးတဲ့အချိန်မှာ အလွယ်တကူ download လုပ်လို့ရပါတယ်။\n\n" +
    "ဆက်မယ်ဆို Payment ကိုနှိပ်ပေးပါ။";
}

function buildConfirmationKeyboard(pkg, durationMonths, isRenewal = false) {
  const version = packageVersion(pkg);
  return Markup.inlineKeyboard([
    [Markup.button.callback("Payment",
      `${isRenewal ? "confirm_renewal" : "confirm_package"}_${pkg.id}_${durationMonths}_${version}`)],
    [Markup.button.callback("⬅️ Back", `${isRenewal ? "renew_package" : "package"}_${pkg.id}`)],
  ]);
}

function buildMyVpnKeyboard(subscription, activated = false) {
  const hasKey = isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey);
  return Markup.inlineKeyboard([
    hasKey
      ? [Markup.button.callback("🛰️ Setup VPN", "setup_vpn"), copyVpnKeyButton(customerAccessUrl(subscription))]
      : [Markup.button.callback("🎧 Support", "help")],
    [activated ? Markup.button.callback("🌐 My VPN", "my_vpn") : Markup.button.callback("♻️ Renew", "renew_vpn"),
      Markup.button.callback("🗂️ My Orders", "my_orders")],
  ]);
}

function formatActivation(pkg, dataLimitGb, expiresAt, isRenewal = false) {
  return (isRenewal ? "သက်တမ်းတိုးပေးပြီးပါပြီ။\nရှိပြီးသား VPN ကိုပဲ ဆက်သုံးလို့ရပါတယ်။" :
    "VPN ဖွင့်ပေးပြီးပါပြီ။") +
    "\n\nVPN ချိတ်ဆက်ဖို့ Outline app လိုပါတယ်။\nOutline မရှိသေးရင် အရင်ဆုံး download လုပ်ပေးပါ။\n\nရှိပြီးသားဆို Connect ကိုနှိပ်ပြီး တန်းသုံးလို့ရပါတယ်။" +
    `\n\nPackage: ${customerPlanLabel(pkg.name)}\nData: ${formatNumber(dataLimitGb)} GB\nသက်တမ်းကုန်ရက်: ${formatInstant(expiresAt)}\n\n` +
    "ချိတ်ဆက်ဖို့ Setup VPN ကိုနှိပ်ပေးပါ။";
}

function buildHelpKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💬 Support", "contact_support")],
    [Markup.button.callback("⬅️ Back", "back_to_start")],
  ]);
}

function buildPaymentKeyboard(order) {
  const callbacks = { bank_transfer: "bank", mobile_wallet: "wallet" };
  return Markup.inlineKeyboard([
    ...compactButtonRows(Object.entries(PAYMENT_METHODS)
      .filter(([method]) => callbacks[method])
      .map(([method, payment]) => Markup.button.callback(payment.name, `payment_${callbacks[method]}_${order.id}`))),
    [Markup.button.callback("မှာယူမှု ပယ်ဖျက်မယ်", `cancel_order_${order.id}`), Markup.button.callback("🎧 Help", "payment_help")],
  ]);
}

function formatPayment(order) {
  return `Payment\n\nမှာယူမှု: ${order.orderNumber}\nPackage: ${customerPlanLabel(order.plan, order.totalDurationDays)}\nပေးချေရန်: ${formatMmk(order.price)} ကျပ်\n\n` +
    "ငွေပေးချေမယ့်နည်းလမ်းကို ရွေးပေးပါ။";
}

function customerPlanLabel(plan, durationDays) {
  return customerPlan(plan, durationDays).replace(/(\d+) Days?\b/g, "$1 ရက်");
}

function customerPlan(plan, durationDays) {
  const name = String(plan || "VPN package");
  return name.replace(/ - \d+ Months?$/, durationDays == null ? "" : ` - ${durationDays} Days`);
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
  return ctx.reply("ဒီ package ကို မရတော့ပါဘူး။\nPackage အသစ်ရွေးပေးပါ။",
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
    .where({ id: order.id, status: "PROCESSING", processingAt: order.processingAt })
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
  if (!db || lifecycle.stopping || !coordination?.owned) return;

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

      const recoveredOrders = await coordination.customer(order.customerId, async () => {
        return await db.public.Order
          .where({
            id: order.id,
            status: "PROCESSING",
            processingAt: order.processingAt,
          })
          .updateAll({
            status: "PENDING_PAYMENT",
            processingAt: null,
          });

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
  recoveryTimer = setInterval(
    () => { if (!lifecycle.stopping && !recoveryRun) recoveryRun = recoverStuckProcessingOrders().finally(() => { recoveryRun = undefined; }); },
    RECOVERY_INTERVAL_MS
  );

  console.log(
    `PROCESSING recovery enabled. Timeout: ${PROCESSING_TIMEOUT_MINUTES} minutes.`
  );
}

async function syncAccessKeyUsage() {
  if (!db || usageSyncRunning || lifecycle.stopping || !coordination?.owned) return;
  usageSyncRunning = true;
  let finishSync;
  usageSyncCompletion = new Promise((resolve) => { finishSync = resolve; });

  try {
    const usageByKeyId = await getAllAccessKeyUsage();
    let existingKeyIds;
    try {
      existingKeyIds = await getExistingAccessKeyIds();
    } catch (error) {
      // Reported keys can still be synced. An omitted key cannot be
      // interpreted as zero without a successful existence check.
      console.error("Outline access key list unavailable during usage sync.", {
        status: safeHttpStatus(error?.response?.status),
      });
    }
    const subscriptions = [
      ...await db.public.Subscription.where({ status: "ACTIVE" }).all(),
      ...await db.public.Subscription.where({ status: "DATA_LIMIT_REACHED" }).all(),
    ];
    let updated = 0;
    let skipped = 0;

    for (const candidate of subscriptions) {
      if (lifecycle.stopping) break;
      await coordination.customer(candidate.customerId, async () => {
        const subscription = await db.public.Subscription.where({ id: candidate.id }).first();
        if (!subscription) return;
        const keyId = subscription.vpnKeyId;
        const hasUsage = Object.hasOwn(usageByKeyId, String(keyId));
        if (!keyId || String(keyId).startsWith("mock-") ||
            subscription.revokedAt ||
            (subscription.expiresAt && Temporal.Instant.compare(subscription.expiresAt, Temporal.Now.instant()) <= 0) ||
            (existingKeyIds && !existingKeyIds.has(String(keyId))) ||
            (!existingKeyIds && !hasUsage)) {
          skipped++;
          return;
        }

        // Outline treats a missing key in a successful rolling metrics map as
        // zero usage. A failed metrics request never reaches this branch.
        const bytes = hasUsage
          ? usageByKeyId[String(keyId)] : 0;
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          skipped++;
          return;
        }

        try {
          // Match the same 1024^3 GB unit used for Outline data limits.
          const dataUsedGb = bytes / GB_IN_BYTES;
          if (subscription.status === "DATA_LIMIT_REACHED") {
            // Outline's rolling counter can later decrease. Keep the reached
            // purchase blocked until an approved renewal restores the allowance.
            await setAccessKeyDataLimit(keyId, 0);
            const changed = await db.public.Subscription
              .where({ id: subscription.id, vpnKeyId: keyId, status: "DATA_LIMIT_REACHED" })
              .updateAll({ dataUsedGb: Math.max(Number(subscription.dataUsedGb) || 0, dataUsedGb),
                dataUsedBytes: BigInt(Math.max(Number(subscription.dataUsedBytes) || 0, bytes)),
                lastUsageSyncedAt: Temporal.Now.instant() });
            updated += changed.length;
            return;
          }
          const limitGb = Number(subscription.dataLimitGb);
          const reached = Number.isFinite(limitGb) && limitGb > 0 &&
            dataUsedGb >= limitGb;
          if (!Number.isFinite(limitGb) || limitGb <= 0) {
            skipped++;
            return;
          }
          // Only approval restores positive allowance; usage scans cannot resurrect access.
          const current = db.public.Subscription.where({ id: subscription.id,
            vpnKeyId: keyId, status: "ACTIVE", dataLimitGb: subscription.dataLimitGb });
          if (reached) {
            // Latch the quota state before the second Outline call. Only record
            // a completed sync after its zero-limit read-back also succeeds.
            const latched = await current.updateAll({ dataUsedGb, dataUsedBytes: BigInt(bytes), status: "DATA_LIMIT_REACHED" });
            if (latched.length) {
              await setAccessKeyDataLimit(keyId, 0);
              const changed = await db.public.Subscription
                .where({ id: subscription.id, vpnKeyId: keyId, status: "DATA_LIMIT_REACHED" })
                .updateAll({ dataUsedGb, dataUsedBytes: BigInt(bytes), lastUsageSyncedAt: Temporal.Now.instant() });
              updated += changed.length;
            }
          } else {
            const changed = await current.updateAll({ dataUsedGb, dataUsedBytes: BigInt(bytes),
              lastUsageSyncedAt: Temporal.Now.instant() });
            updated += changed.length;
          }
        } catch {
          skipped++;
        }
      });
    }

    console.log(`Outline usage sync completed: ${updated} updated, ${skipped} skipped.`);
  } catch (error) {
    // Axios errors can contain the management URL and credentials. Log only a
    // numeric HTTP status, never the error object or its request config.
    console.error("Outline usage sync failed.", {
      status: safeHttpStatus(error?.response?.status),
    });
  } finally {
    await subscriptionNotifications?.run();
    usageSyncRunning = false;
    finishSync();
    usageSyncCompletion = null;
  }
}

function startUsageSync() {
  void syncAccessKeyUsage();
  usageSyncTimer = setInterval(() => { void syncAccessKeyUsage(); }, USAGE_SYNC_INTERVAL_MS);
  console.log("Outline usage sync enabled (every 60 seconds).");
}

async function sendMainMenu(ctx) {
  navigation?.reset(ctx);
  await ctx.reply("Metro Secure မှ ကြိုဆိုပါတယ်။\n\nလိုအပ်တဲ့ VPN package ကို အောက်ကနေ ရွေးလို့ရပါတယ်။", buildMainMenu(ctx));
  if (ctx.chat?.type === "private") {
    await ctx.reply("အောက်ကနေ ရွေးပေးပါ။", isAdmin(ctx)
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
        "Package အချက်အလက်တွေ ပြောင်းထားပါတယ်။ လက်ရှိဈေးနှုန်းနဲ့ data ကို ပြန်ကြည့်ပေးပါ။\n\n" +
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
          "လက်ရှိ VPN မရှိသေးပါဘူး။\nBuy VPN မှာ package အရင်ရွေးပေးပါ။"
        );
      }
    }

    const plan = `${pkg.name} - ${durationDays} Days`;

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
        await ctx.reply(`🗂️ မှာယူမှု: ${legacyOrder.orderNumber}\nအခြေအနေ: ${formatOrderStatus(legacyOrder.status, Boolean(legacyOrder.paymentProof))}\n\nဒီမှာယူမှုကို ထပ်အတည်ပြုစရာ မလိုပါ။ အသေးစိတ်ကြည့်ဖို့ My Orders ကိုနှိပ်ပါ။`, buildMainMenu(ctx));
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
    if (recentPending && customerPlan(recentPending.plan, recentPending.totalDurationDays) === plan &&
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
      await ctx.reply("တစ်မိနစ်လောက်စောင့်ပြီးမှ ထပ်မှာယူပေးပါ။ လက်ရှိမှာယူမှုကို My Orders မှာ ကြည့်လို့ရပါတယ်။");
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
        `🗂️ မှာယူမှု: ${order.orderNumber}\nအခြေအနေ: ${formatOrderStatus(order.status, Boolean(order.paymentProof))}\n\nဒီမှာယူမှုကို ထပ်အတည်ပြုစရာ မလိုပါ။ အသေးစိတ်ကြည့်ဖို့ My Orders ကိုနှိပ်ပါ။`,
        buildMainMenu(ctx)
      );
      return order;
    }

    await ctx.reply(formatPayment(order), buildPaymentKeyboard(order));
    return order;
  } catch (error) {
    console.error("Create package order failed.");

    await ctx.reply(
      "အခုမှာယူလို့မရသေးပါဘူး။\nခဏနေရင် Payment ကို ပြန်နှိပ်ပေးပါ။"
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
    `Package: ${pkg?.name || customerPlan(order.plan, order.totalDurationDays)}\n` +
    `Duration: ${order.totalDurationDays == null ? "Unavailable" : `${order.totalDurationDays} Days`}\n` +
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
  const isRenewal = Boolean(subscription);
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
function trackedCallbacks(callbacks) {
  for (const [name, callback] of Object.entries(callbacks)) {
    if (typeof callback === "function" && name !== "getSupportService") {
      callbacks[name] = (...args) => lifecycle.track(() => {
        if (!botHealthy || !coordination?.owned) throw new Error("Service restarting.");
        return callback(...args);
      });
    }
  }
  return callbacks;
}
const miniAppRouter = createMiniAppRouter(trackedCallbacks({
  botToken: process.env.BOT_TOKEN,
  supportEvents,
  getSupportService: () => miniAppSupportService,
  async getAccount(telegramId, telegramUser) {
    const { customer, subscription } = await findCustomerSubscription(telegramId);
    const state = subscription ? effectiveSubscriptionState(subscription) : "NONE";
    const active = state === "ACTIVE";
    const configuredLabel = process.env.VPN_SERVER_LABEL || process.env.VPN_REGION || "";
    const serverLabel = /^[\p{L}][\p{L}\p{N} '-]{0,39}$/u.test(configuredLabel)
      ? configuredLabel : "VPN server";
    return {
      customerExists: Boolean(customer),
      hasSubscription: Boolean(subscription),
      status: state,
      displayName: customer?.firstName || telegramUser?.first_name || null,
      plan: subscription ? customerPlan(subscription.plan) : null,
      dataUsedGb: subscription?.dataUsedGb ?? null,
      dataLimitGb: subscription?.dataLimitGb ?? null,
      startedAt: subscription?.startedAt?.toString() || null,
      expiresAt: subscription?.expiresAt?.toString() || null,
      serverLabel,
      lastUsageSyncedAt: subscription?.lastUsageSyncedAt?.toString() || null,
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
      `မှာယူမှု: ${order.orderNumber}\n\nငွေလွှဲပြီးရင် slip ပုံကို ဒီမှာပို့ပေးပါ။`,
      Markup.inlineKeyboard([[
        Markup.button.callback(`${PAYMENT_METHODS[order.paymentMethod].name} နဲ့လွှဲမယ်`,
          `payment_${MINI_PAYMENT_CALLBACKS[order.paymentMethod]}_${order.id}`),
        Markup.button.callback("🗂️ My Orders", "my_orders"),
      ]]));
    return true;
  },
  async uploadProof(telegramId, orderNumber, image, mimeType) {
    if (lifecycle.stopping || !allowProofUpload(telegramId)) return { busy: true };
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
    let { subscription } = await findCustomerSubscription(telegramId);
    if (!isSubscriptionActive(subscription) ||
        !isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) ||
        !isValidOutlineAccessKey(subscription.vpnKey)) return null;
    subscription = await prepareDynamicSubscription(subscription);
    return `${createVpnConnectUrl(subscription)}?lang=en`;
  },
  async sendBotFlow(telegramId, flow, packageId) {
    if (!allowMiniFlow(telegramId)) throw new Error("Too many requests");
    if (flow === "support") {
      await bot.telegram.sendMessage(telegramId,
        "🎧 Support\n\nအကူအညီလိုရင် Support ကိုနှိပ်ပေးပါ။",
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
        isRenewal ? "သက်တမ်းတိုးချင်တဲ့ package ကို ရွေးပေးပါ။" : formatPackageSelection(packages),
      selected ? buildPackageDetailKeyboard(selected, isRenewal) :
        buildPackageKeyboard(packages, isRenewal));
  },
}));
app.get("/app", (req, res, next) => {
  if (req.path === "/app") return res.redirect(302, "app/");
  next();
});
app.use("/app", miniAppRouter);
app.use("/mini-app", miniAppRouter);

async function startBot() {
  console.log("Starting VPN Bot...");

  startupStage = "production config validation";
  validateProductionEnvironment();
  console.log("DATABASE_URL configured:", process.env.DATABASE_URL ? "yes" : "no");
  validateOutlineConfig();
  const connectConfig = getConnectConfig();

  startupStage = "admin configuration";
  const adminConfig = validateAdminConfig();
  envValidated = true;
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
  const shutdown = (signal, exitCode = 0) => lifecycle.stop([
    () => { singletonStartup?.cancel(); botHealthy = false; try { bot?.stop(signal); } catch {} },
    () => { clearInterval(recoveryTimer); clearInterval(usageSyncTimer); expiryWorker?.stopScheduling?.(); subscriptionNotifications?.stopScheduling?.(); },
    () => supportEvents.closeAll(),
    { run: () => Promise.allSettled([lifecycle.drain(), singletonStartup?.drain()]), timeoutMs: 10000 },
    { run: () => Promise.allSettled([usageSyncCompletion, recoveryRun, expiryWorker?.stop(), subscriptionNotifications?.drain?.()]), timeoutMs: 10000 },
    () => coordination?.release(),
    () => new Promise(resolve => { if (!server) return resolve(); server.close(resolve); server.closeIdleConnections?.(); }),
    () => notificationStore?.close(),
    () => database.runtime.close(),
    () => coordination?.close(),
  ], exitCode);
  shutdownProcess = shutdown;

  process.once(
    "SIGINT",
    () => { void shutdown("SIGINT"); }
  );

  process.once(
    "SIGTERM",
    () => { void shutdown("SIGTERM"); }
  );


  coordination = database.coordination || createCoordination({ onLost: () => {
    botHealthy = false;
    console.log("Singleton ownership lost; leaving active state.", { owner: coordination?.owner });
    void shutdownProcess?.("Singleton ownership lost", 1);
  } });
  console.log("PostgreSQL connected.");

  // Construction is read-only. Setup/config HTTP requests can serve the same
  // stored dynamic URL in standby; ensure() remains behind the active API gate.
  dynamicKeys = createDynamicKeys({ client: db, baseUrl: connectConfig.baseUrl,
    secret: process.env.CONNECT_TOKEN_SECRET });
  singletonStartup = createSingletonStartup({ coordination, activate: activateSingletonServices,
    log: console,
    onError(error) { logStartupFailure(error); void shutdown("Singleton activation failure", 1); } });
  startupStage = "Express health server";
  await new Promise((resolve, reject) => {
    server = app.listen(PORT);
    server.once("listening", resolve);
    server.once("error", reject);
  });
  console.log("HTTP liveness available; awaiting singleton ownership.");
  if (lifecycle.stopping) return;
  await singletonStartup.start();
}

async function activateSingletonServices() {
  if (lifecycle.stopping || !coordination.owned) return;
  notificationStore = createNotificationStore();
  subscriptionNotifications = createSubscriptionNotifications({ store: notificationStore,
    sendMessage: (chatId, text, extra) => {
      if (!coordination.owned) throw new Error("Singleton ownership unavailable.");
      return bot.telegram.callApi("sendMessage",
        { chat_id: chatId, text, ...extra }, { signal: AbortSignal.timeout(15000) });
    },
    async prepareMigration(subscription) {
      const prepared = await prepareDynamicSubscription(subscription);
      const accessUrl = dynamicKeys.accessUrl(prepared);
      return { accessUrl,
        text: prepared.dynamicDeliveryMode === "NEW"
          ? formatActivation({ name: customerPlan(prepared.plan) }, prepared.dataLimitGb,
            Temporal.Instant.from(prepared.expiresAt.toISOString?.() || prepared.expiresAt.toString())) : undefined,
        extra: { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [
          [{ text: "ချိတ်ဆက်ရန်", url: createVpnConnectUrl({ ...prepared,
            expiresAt: Temporal.Instant.from(prepared.expiresAt.toISOString?.() || prepared.expiresAt.toString()) }) }],
          [{ ...copyVpnKeyButton(accessUrl), text: "ကီးကို ကူးယူရန်" }],
        ] } },
      };
    },
  });

  expiryWorker = createExpiryWorker({ client: db, deleteAccessKey,
    withCustomerLock: (id, work) => coordination.customer(id, work),
    blockAccessKey: (keyId) => setAccessKeyDataLimit(keyId, 0),
    restoreAccessKey: (keyId, limitGb) => setAccessKeyDataLimit(keyId, gbToBytes(limitGb)),
    isAccessKeyNotFoundError, schedule: setInterval, cancel: clearInterval,
    evaluateNotifications: () => subscriptionNotifications.run() });

  startupStage = "PROCESSING recovery";
  await recoverStuckProcessingOrders();
  if (lifecycle.stopping || !coordination.owned) return;
  startProcessingRecovery();

  startupStage = "Telegram launch";
  bot = new Telegraf(process.env.BOT_TOKEN);
  expiryWorker.start();
  navigation = createNavigation();
  const screenActions = [];
  const originalAction = bot.action.bind(bot);
  const originalStart = bot.start.bind(bot);
  const originalOn = bot.on.bind(bot);
  bot.on = (event, handler) => originalOn(event, ctx => {
    if (lifecycle.stopping || !coordination.owned) return;
    return lifecycle.track(() => handler(ctx));
  });
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
      if (lifecycle.stopping || !coordination.owned) return ctx.answerCbQuery("Service restarting");
      const action = typeof trigger === "string" ? trigger : ctx.match?.[0];
      return lifecycle.track(() => withNavigationReply(ctx, screenForAction(action || ""), () => handler(ctx)));
    });
  };
  bot.start = (handler) => originalStart((ctx) => {
    if (lifecycle.stopping || !coordination.owned) return;
    navigation.reset(ctx);
    return lifecycle.track(() => handler(ctx));
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
    if (!previous) return ctx.reply("ဒီခလုတ်က သုံးလို့မရတော့ပါဘူး။ /start ကို ပြန်ဖွင့်ပေးပါ။");
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
      `Telegram ID:\n${ctx.from.id}\n\nအကူအညီတောင်းတဲ့အခါ ဒီနံပါတ်ကို ပေးလို့ရပါတယ်။`
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
          "🌐 My VPN\n\nလက်ရှိ VPN မရှိသေးပါဘူး။\nစသုံးချင်ရင် Buy VPN မှာ package ရွေးလို့ရပါတယ်။",
          buildMainMenu(ctx)
        );
      }

      const state = effectiveSubscriptionState(subscription);
      const subscriptionActive = state === "ACTIVE";
      const statusLabel = subscriptionActive ? "သုံးလို့ရပါတယ်" : state === "DATA_LIMIT_REACHED"
        ? "Data အကုန်သုံးပြီးပါပြီ" : state === "EXPIRED" ? "VPN သက်တမ်းကုန်သွားပါပြီ။" : "VPN ကို လောလောဆယ် သုံးလို့မရပါဘူး။";

      if (!subscriptionActive) {
        return await ctx.reply(
          `🌐 My VPN\n\n${statusLabel}\n\n${state === "DATA_LIMIT_REACHED"
            ? "ဒီ package ရဲ့ data ကို အကုန်သုံးပြီးပါပြီ။\nဆက်သုံးချင်ရင် package ထပ်ဝယ်လို့ရပါတယ်။"
            : state === "EXPIRED" ? "ဆက်သုံးချင်ရင် သက်တမ်းတိုးလို့ရပါတယ်။"
              : "Support မှာ ဆက်သွယ်ပေးပါ။"}`,
          state === "REVOKED" ? buildHelpKeyboard() : renewBuyKeyboard()
        );
      }

      const packageLabel = customerPlanLabel(subscription.plan);
      const hasReusableKey = Boolean(subscription.vpnKeyId &&
        isReusableAccessKey(subscription.vpnKeyId, subscription.vpnKey) &&
        isValidOutlineAccessKey(subscription.vpnKey));
      await ctx.reply(
        `🌐 My VPN\n\nPackage: ${packageLabel}\n` +
          `📡 သုံးထားတာ: ${formatUsageGb(subscription.dataUsedGb)} GB / ${formatNumber(subscription.dataLimitGb || 0)} GB\n` +
          `ကျန်တဲ့ data: ${formatUsageGb(Math.max(0, Number(subscription.dataLimitGb || 0) - Number(subscription.dataUsedGb || 0)))} GB\n` +
          `⏳ သက်တမ်းကုန်ရက်: ${formatInstant(subscription.expiresAt)}\nအခြေအနေ: ${statusLabel}\n\n` +
          "နောက်ဆုံး 30 ရက်အတွင်း သုံးထားတဲ့ data ပါ။\n\n" +
          (hasReusableKey
            ? "ချိတ်ဆက်ဖို့ Setup VPN ကိုနှိပ်ပေးပါ။\nသက်တမ်းတိုးချင်ရင် Renew ကိုနှိပ်လို့ရပါတယ်။"
            : "VPN key ကို အခုယူလို့မရသေးပါဘူး။ Support မှာ ဆက်သွယ်ပေးပါ။"),
        buildMyVpnKeyboard(await prepareDynamicSubscription(subscription))
      );
    } catch (error) {
      logHandlerFailure("my_vpn", error);

      await ctx.reply(
        "VPN အချက်အလက်ကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် My VPN ကို ပြန်နှိပ်ပေးပါ။"
      );
    }
  });

  bot.action("copy_vpn_key", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await sendExistingVpnKey(ctx, "Copy VPN Key");
    } catch {
      console.error("Could not load VPN key for copying.");
      await ctx.reply("VPN key ကို အခုယူလို့မရသေးပါဘူး။\nခဏနေရင် Copy VPN Key ကို ပြန်နှိပ်ပေးပါ။");
    }
  });

  bot.action(/^(?:setup_vpn|add_device)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await sendVpnSetup(ctx);
    } catch (error) {
      logHandlerFailure("setup_vpn", error);
      await ctx.reply("Connect ကို အခုဖွင့်လို့မရသေးပါဘူး။\nခဏနေရင် Setup VPN ကို ပြန်နှိပ်ပေးပါ။");
    }
  });

  bot.action(/^setup_platform_(android|ios|windows|macos)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      // Old device-picker messages now issue the same direct helper link.
      await sendVpnSetup(ctx);
    } catch (error) {
      logHandlerFailure("setup_platform", error);
      await ctx.reply("Connect ကို အခုဖွင့်လို့မရသေးပါဘူး။\nခဏနေရင် Setup VPN ကို ပြန်နှိပ်ပေးပါ။");
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
        await ctx.reply("Connect ကို အခုဖွင့်လို့မရသေးပါဘူး။\nခဏနေရင် Setup VPN ကို ပြန်နှိပ်ပေးပါ။");
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
            "လက်ရှိ VPN မရှိသေးပါဘူး။\nစသုံးချင်ရင် Buy VPN မှာ package ရွေးလို့ရပါတယ်။"
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
            "လက်ရှိ VPN မရှိသေးပါဘူး။\nBuy VPN မှာ package အရင်ရွေးပေးပါ။"
          );
        }

        const packages =
          await getActivePackages();

        if (!packages.length) {
          return await ctx.reply(
            "လောလောဆယ် package မရှိသေးပါဘူး။\nခဏနေရင် ပြန်ကြည့်ပေးပါ။ အကူအညီလိုရင် Support မှာ မေးလို့ရပါတယ်။"
          );
        }

        await ctx.reply(
          "VPN သက်တမ်းတိုးပါ\n\nသက်တမ်းတိုးချင်တဲ့ package ကို ရွေးပေးပါ။\nရှိပြီးသား VPN ကိုပဲ ဆက်သုံးလို့ရပါတယ်။",
          buildPackageKeyboard(packages, true)
        );
      } catch (error) {
        logHandlerFailure("renew_vpn", error);

        await ctx.reply(
          "Package တွေကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် Renew ကို ပြန်နှိပ်ပေးပါ။"
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
          "ဒီ package ကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် package ကို ပြန်ရွေးပေးပါ။"
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
          "ဈေးနှုန်းကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် Renew မှာ ပြန်ရွေးပေးပါ။"
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
            "လောလောဆယ် package မရှိသေးပါဘူး။\nခဏနေရင် ပြန်ကြည့်ပေးပါ။ အကူအညီလိုရင် Support မှာ မေးလို့ရပါတယ်။"
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
          "Package တွေကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် Buy VPN ကို ပြန်နှိပ်ပေးပါ။"
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
          "ဒီ package ကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် package ကို ပြန်ရွေးပေးပါ။"
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
          "ဈေးနှုန်းကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် Buy VPN မှာ package ပြန်ရွေးပေးပါ။"
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
      "🎧 Support\n\nအကူအညီလိုရင် အောက်က Support ကိုနှိပ်ပေးပါ။",
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
      await ctx.reply("မီနူးကို အခုဖွင့်လို့မရသေးပါဘူး။ ခဏနေရင် /start ကို ပြန်ဖွင့်ပေးပါ။");
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
      "Payment\n\nပြထားတဲ့အကောင့်ကို ငွေပမာဏအတိအကျ လွှဲပေးပါ။\nငွေလွှဲပြီးရင် slip ပုံကို ဒီမှာပို့ပေးပါ။\n\nအခက်အခဲရှိရင် Support မှာ မှာယူမှုနံပါတ်နဲ့အတူ မေးပေးပါ။ ထပ်ငွေလွှဲဖို့ မလိုပါဘူး။",
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
          "ဒီမှာယူမှုကို မတွေ့သေးပါဘူး။\nMy Orders မှာ ပြန်ကြည့်ပေးပါ။"
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
          "ဒီမှာယူမှုကို ဖွင့်လို့မရပါဘူး။\nMy Orders မှာ ကိုယ့်မှာယူမှုကို ပြန်ရွေးပေးပါ။"
        );
      }

      if (
        order.status !==
        "PENDING_PAYMENT"
      ) {
        return await ctx.reply(
          `ဒီမှာယူမှုအတွက် ငွေပေးချေလို့မရတော့ပါဘူး။\nအခြေအနေ: ${formatOrderStatus(order.status, Boolean(order.paymentProof))}\n\nMy Orders မှာ ပြန်ကြည့်ပေးပါ။ ငွေလွှဲပြီးသားဆိုရင် Support မှာ ဆက်သွယ်ပေးပါ။`
        );
      }

      const payment =
        PAYMENT_METHODS[method];

      if (!payment) {
        return await ctx.reply(
          "ဒီငွေပေးချေနည်းကို အခုသုံးလို့မရသေးပါဘူး။\nPayment မှာ အခြားနည်းကို ရွေးပေးပါ။"
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
          `မှာယူမှု: ${order.orderNumber}\nPackage: ${customerPlanLabel(order.plan, order.totalDurationDays)}\nပေးချေရန်: ${formatMmk(order.price)} ကျပ်\n\n` +
          `အကောင့်အမည်: ${payment.accountName}\nအကောင့်နံပါတ်: ${payment.accountNumber}\n\n` +
          "ဒီအကောင့်ကို ပြထားတဲ့ ငွေပမာဏအတိုင်း လွှဲပေးပါ။\nငွေလွှဲပြီးရင် slip ပုံကို ဒီမှာပို့ပေးပါ။",
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
        "ငွေပေးချေနည်းကို အခုရွေးလို့မရသေးပါဘူး။\nခဏနေရင် ပြန်ရွေးပေးပါ။"
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
      return ctx.reply("ပုံပို့လို့မရသေးပါဘူး။ ခဏနေရင် ပြန်ပို့ပေးပါ။");
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
          "ဒီမှာယူမှုကို မတွေ့သေးပါဘူး။\nMy Orders မှာ ပြန်ကြည့်ပေးပါ။"
        );
      }

      const proofOwner = await db.public.Customer.where({ id: order.customerId }).first();
      if (!proofOwner || proofOwner.telegramId !== userId) {
        pendingProofs.delete(userId);
        return await ctx.reply("ဒီမှာယူမှုကို ဖွင့်လို့မရပါဘူး။ My Orders မှာ ပြန်ရွေးပေးပါ။");
      }
      if (String(order.paymentReference || "").startsWith("MINI_UPLOAD_V1:")) {
        return await ctx.reply("Slip တင်နေပါတယ်။ ခဏနေရင် My Orders မှာ ပြန်ကြည့်ပေးပါ။");
      }

      if (
        order.status !==
        "PENDING_PAYMENT"
      ) {
        pendingProofs.delete(
          userId
        );

        return await ctx.reply(
          "ဒီမှာယူမှုအတွက် slip ထပ်ပို့ဖို့ မလိုပါဘူး။\nMy Orders မှာ အခြေအနေကို ကြည့်လို့ရပါတယ်။"
        );
      }

      const photos =
        ctx.message.photo;
      const selectedPhoto = photos?.at(-1);
      if (!selectedPhoto || (selectedPhoto.file_size != null &&
          (!Number.isSafeInteger(selectedPhoto.file_size) || selectedPhoto.file_size <= 0 ||
           selectedPhoto.file_size > 20 * 1024 * 1024))) {
        return await ctx.reply("20 MB ထက်ငယ်တဲ့ slip ပုံကို ပို့ပေးပါ။");
      }

      const paymentProof =
        selectedPhoto.file_id;

      if (!allowProofUpload(userId)) return ctx.reply("ခဏနေရင် ပြန်ကြိုးစားပေးပါ။");
      const saved = await db.public.Order.where({ id: orderId, customerId: proofOwner.id,
        status: "PENDING_PAYMENT", paymentProof: null, paymentReference: null })
        .updateAll({ paymentProof });
      if (!saved.length) return ctx.reply("Slip ရှိပြီးသား သို့မဟုတ် မှာယူမှု ပြောင်းလဲပြီးပါပြီ။ My Orders မှာ ပြန်ကြည့်ပေးပါ။");

      pendingProofs.delete(
        userId
      );

      await ctx.reply(
        "Slip ရပါပြီ။\n\nစစ်ဆေးပြီးတာနဲ့ ပြန်အကြောင်းကြားပေးပါမယ်။",
        Markup.inlineKeyboard([
          [Markup.button.callback("🗂️ My Orders", "my_orders"), Markup.button.callback("🎧 Help", "payment_help")],
        ])
      );

      await sendAdminProofReview(order, paymentProof);
    } catch (error) {
      console.error("Payment proof handling failed.");

      await ctx.reply(
        "Slip ပို့တာ အဆင်မပြေသေးပါဘူး။\nSupport မှာ မှာယူမှုနံပါတ်နဲ့အတူ ဆက်သွယ်ပေးပါ။ ထပ်ငွေလွှဲဖို့ မလိုပါဘူး။"
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
      await ctx.reply("စာပို့လို့မရသေးပါဘူး။ ခဏနေရင် ပြန်ပို့ပေးပါ။");
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

        await coordination.customer(existingOrder.customerId, async (assertOwned) => {
          if (lifecycle.stopping) return;
          assertOwned();
          const unfinished = await db.public.Order.where({ customerId: existingOrder.customerId,
            status: "PROCESSING" }).all();
          if (unfinished.some(row => row.id !== orderId)) return ctx.reply("Customer provisioning is still processing. Please retry later.");
          const pending = await db.public.Order.where({ customerId: existingOrder.customerId,
            status: "PENDING_PAYMENT" }).all();
          if (pending.some(row => row.id !== orderId && row.expiresAt))
            return ctx.reply("Please recover the earlier provisioning order first.");
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
              `⚠️ Order already processed or is currently being processed.\n\nStatus: ${(await db.public.Order.where({ id: orderId }).first())?.status}`
            );
          }

          const order = claimedOrders[0];
          async function completeApproval(values) {
            assertOwned();
            const changed = await db.public.Order.where({ id: order.id,
              status: "PROCESSING", processingAt }).updateAll(values);
            if (!changed.length) {
              await db.public.Order.where({ id: order.id }).first();
              throw new Error("Approval claim changed before completion.");
            }
          }

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

          if (subscription?.vpnKeyId && !subscription.vpnKeyId.startsWith("mock-")) {
            const owners = await db.public.Subscription.where({ vpnKeyId: subscription.vpnKeyId }).all();
            if (owners.length !== 1 || owners[0].id !== subscription.id) throw new Error("Ambiguous Outline ownership.");
          }
          assertOwned();
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
              await db.public.Order.where({ id: order.id, status: "PROCESSING", processingAt })
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
              // An earlier cancelled/rejected recovery can still have an
              // uncertain remote creation. Reconcile its stable identity before
              // granting this purchase rather than orphaning a second key.
              const checkpoints = await db.public.Order.where({ customerId: customer.id }).all();
              const sourceOrder = checkpoints.filter(row => row.startedAt && row.expiresAt)
                .sort((a, b) => a.id - b.id)[0] || order;
              accessKey = isReusableAccessKey(sourceOrder.vpnKeyId, sourceOrder.vpnKey)
                ? { id: sourceOrder.vpnKeyId, accessUrl: sourceOrder.vpnKey }
                : await createOrderAccessKey(sourceOrder);

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
                  status: "PROCESSING", processingAt,
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

            const keyOwners = await db.public.Subscription.where({ vpnKeyId: accessKey.id }).all();
            if (keyOwners.length) throw new Error("Outline key already has an owner.");
            assertOwned();
            await setAccessKeyDataLimit(accessKey.id, 0);
            assertOwned();

            console.log(
              "Outline key blocked until entitlement persistence."
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
                  dataUsedBytes: 0n,
                  dynamicDeliveryMode: "NEW",
                }
              );

            await writeEntitlementAllowance({
              load: () => db.public.Subscription.where({ id: subscription.id }).first(),
              write: setAccessKeyDataLimit, assertOwned,
            });

            // ---------------------------------
            // 13. Mark order PAID
            // ---------------------------------

            await completeApproval({
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

            subscription = await prepareDynamicSubscription(subscription);
            await subscriptionNotifications.deliver(subscription.id, "migrationNotice");

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
              await db.public.Order.where({ id: order.id, status: "PROCESSING", processingAt })
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
              assertOwned();
              await writeEntitlementAllowance({
                load: () => db.public.Subscription.where({ id: subscription.id }).first(),
                write: setAccessKeyDataLimit, assertOwned,
              });
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
              assertOwned();
              await setAccessKeyDataLimit(renewalAccessKey.id, 0);
              assertOwned();
            }

            console.log(
              "Existing Outline key verified before entitlement update."
            );

            // ---------------------------------
            // 17. Update subscription
            // ---------------------------------

            await db.public.Subscription
              .where({
                id: subscription.id,
              })
              .update({
                ...renewalNotificationReset(alreadyApplied),
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

            // Expiry recovery may have blocked this key while the order was
            // PROCESSING. Confirm the approved allowance after the DB extension.
            await writeEntitlementAllowance({
              load: () => db.public.Subscription.where({ id: subscription.id }).first(),
              write: setAccessKeyDataLimit, assertOwned,
            });

            // ---------------------------------
            // 18. Mark renewal order PAID
            // ---------------------------------

            await completeApproval({
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

            const renewedSubscription = await db.public.Subscription.where({ id: subscription.id }).first();
            const preparedRenewal = await prepareDynamicSubscription(renewedSubscription);
            await bot.telegram.sendMessage(
              customer.telegramId,
              formatActivation({ name: customerPlan(order.plan, order.totalDurationDays) }, newTotalDataGb, newExpiresAt, true),
              buildMyVpnKeyboard(preparedRenewal, true)
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
        });
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

        const transitioned = await db.public.Order
          .where({
            id: order.id, status: "PENDING_PAYMENT",
          })
          .updateAll({
            status:
              "PAYMENT_REJECTED",

            processingAt:
              null,
          });

        if (!transitioned.length) {
          const latest = await db.public.Order.where({ id: order.id }).first();
          return ctx.reply(`Order already processed. Status: ${latest?.status}`);
        }
        const customer =
          await db.public.Customer
            .where({
              id: order.customerId,
            })
            .first();

        if (customer) {
          await bot.telegram.sendMessage(
            customer.telegramId,

            `ဒီ slip ကို အတည်ပြုလို့မရသေးပါဘူး။\n\nမှာယူမှု: ${order.orderNumber}\nSupport မှာ မှန်ကန်တဲ့ slip ပုံကို ပြန်ပို့ပေးပါ။ ထပ်ငွေလွှဲဖို့ မလိုပါဘူး။`,
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
            "ဒီမှာယူမှုကို မတွေ့သေးပါဘူး။\nMy Orders မှာ ပြန်ကြည့်ပေးပါ။"
          );
        }

        if (
          order.status !==
          "PENDING_PAYMENT"
        ) {
          return await ctx.reply(
            "ဒီမှာယူမှုကို ပယ်ဖျက်လို့မရတော့ပါဘူး။\nMy Orders မှာ အခြေအနေကို ကြည့်ပေးပါ။"
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
            "ဒီမှာယူမှုကို ပယ်ဖျက်လို့မရပါဘူး။\nMy Orders မှာ ကိုယ့်မှာယူမှုကို ပြန်ရွေးပေးပါ။"
          );
        }

        const transitioned = await db.public.Order
          .where({
            id: orderId, customerId: customer.id, status: "PENDING_PAYMENT",
          })
          .updateAll({
            status: "CANCELLED",
          });

        if (!transitioned.length) {
          await db.public.Order.where({ id: orderId }).first();
          return ctx.reply("ဒီမှာယူမှုကို ပယ်ဖျက်လို့မရတော့ပါဘူး။ My Orders မှာ ပြန်ကြည့်ပေးပါ။");
        }
        pendingProofs.delete(
          String(ctx.from.id)
        );

        await ctx.reply(
          `မှာယူမှုကို ပယ်ဖျက်ပြီးပါပြီ။\n\nမှာယူမှု: ${order.orderNumber}\nငွေလွှဲပြီးသားဆိုရင် Support မှာ ဆက်သွယ်ပေးပါ။`,
          buildMainMenu(ctx)
        );
      } catch (error) {
        console.error("Cancel order failed.");

        await ctx.reply(
          "ပယ်ဖျက်ပြီးမပြီး အခုကြည့်လို့မရသေးပါဘူး။\nMy Orders မှာ ပြန်ကြည့်ပေးပါ။"
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
            "🗂️ My Orders\n\nဝယ်ထားတာ မရှိသေးပါဘူး။\nစသုံးချင်ရင် Buy VPN မှာ package ရွေးလို့ရပါတယ်။", buildMainMenu(ctx)
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
            "🗂️ My Orders\n\nဝယ်ထားတာ မရှိသေးပါဘူး။\nစသုံးချင်ရင် Buy VPN မှာ package ရွေးလို့ရပါတယ်။", buildMainMenu(ctx)
          );
        }

        let message =
          "🗂️ My Orders\n\nဝယ်ထားတာတွေကို ဒီမှာကြည့်လို့ရပါတယ်။\n\n";

        for (const order of orders) {
          message +=
            `🧾 ${order.orderNumber}\n` +
            `Package: ${customerPlanLabel(order.plan, order.totalDurationDays)}\n` +
            `📡 Data: ${
              order.totalDataGb ||
              0
            } GB\n` +
            `⏳ သက်တမ်း: ${order.totalDurationDays == null ? "မရသေးပါဘူး" : `${order.totalDurationDays} ရက်`}\n` +
            `🧾 ဈေးနှုန်း: ${formatMmk(order.price)} ကျပ်\n` +
            (order.status === "PAID" ? "" : `အခြေအနေ: ${formatOrderStatus(order.status, Boolean(order.paymentProof))}\n`);

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
          "ဝယ်ထားတာတွေကို အခုကြည့်လို့မရသေးပါဘူး။\nခဏနေရင် My Orders ကို ပြန်နှိပ်ပေးပါ။"
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

  if (lifecycle.stopping || !coordination.owned) return;
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
  if (lifecycle.stopping || !coordination.owned) return;
  startUsageSync();

  console.log("Bot handlers registered. Starting Telegram polling...");

  startupStage = "Telegram polling";
  void bot.launch({}, () => {
    botHealthy = !lifecycle.stopping && coordination.owned;
    if (botHealthy) singletonStartup.ready();
    else { try { bot.stop("Service restarting"); } catch {} }
  }).catch((error) => {
    if (lifecycle.stopping) return;
    logStartupFailure(error);
    void shutdownProcess("Telegram polling failure", 1);
  });
}

startBot().catch((error) => {
  logStartupFailure(error);
  if (shutdownProcess) void shutdownProcess("Startup failure", 1);
  else process.exit(1);
});
