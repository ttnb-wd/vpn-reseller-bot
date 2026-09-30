const crypto = require("node:crypto");
const express = require("express");
const path = require("node:path");

const MAX_INIT_AGE_SECONDS = 60 * 60;

function verifyTelegramInitData(initData, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof initData !== "string" || initData.length > 8192 || !botToken) return null;
  const fields = new URLSearchParams(initData);
  const hash = fields.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || fields.getAll("hash").length !== 1) return null;
  const authDate = Number(fields.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 60 ||
      nowSeconds - authDate > MAX_INIT_AGE_SECONDS) return null;
  const entries = [...fields.entries()].filter(([key]) => key !== "hash");
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
  const checkString = entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(checkString).digest();
  const supplied = Buffer.from(hash, "hex");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const user = JSON.parse(fields.get("user") || "null");
    return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}

const ACCOUNT_FIELDS = ["hasSubscription", "status", "displayName", "plan", "serverLabel",
  "dataUsedGb", "dataLimitGb", "startedAt", "expiresAt", "usageSyncedAt", "canConnect"];
function customerAccount(account) {
  return Object.fromEntries(ACCOUNT_FIELDS.map((field) => [field, account?.[field] ?? null]));
}

function sealToken(payload, userId, botToken) {
  const key = crypto.createHash("sha256").update(botToken).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(userId)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function openToken(token, userId, botToken) {
  if (typeof token !== "string" || token.length > 512) return null;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length < 29) return null;
    const key = crypto.createHash("sha256").update(botToken).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(String(userId)));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    if (!Number.isSafeInteger(value.id) || value.id <= 0 ||
        !Number.isSafeInteger(value.at) || value.at > Date.now() + 60000 ||
        Date.now() - value.at > 15 * 60000) return null;
    return value;
  } catch { return null; }
}

function publicPackage(pkg, userId, botToken, changed = false) {
  return { name: pkg.name, dataLimitGb: pkg.dataLimitGb, durationDays: pkg.durationDays,
    priceMmk: pkg.priceMmk, changed,
    selectionToken: sealToken({ kind: "selection", id: pkg.id, version: pkg.version,
      at: Date.now() }, userId, botToken) };
}

function publicOrder(order) {
  if (!order) return null;
  const status = order.status === "PENDING_PAYMENT" && order.paymentProof
    ? "PAYMENT_SUBMITTED" : order.status;
  return { orderNumber: order.orderNumber, plan: order.plan,
    amountMmk: Number(order.price), dataLimitGb: order.totalDataGb ?? null,
    durationDays: order.totalDurationDays ?? null,
    createdAt: order.createdAt?.toString() || null,
    paymentMethod: order.paymentMethod || null, status };
}
const validOrderNumber = (value) => typeof value === "string" && /^VPN-[A-Za-z0-9-]{1,80}$/.test(value);

function createMiniAppRouter({ botToken, getAccount, getPackages, getPackage,
  createOrder, getOrder, getOrders, getPaymentMethods, selectPaymentMethod,
  handoffProof, getConnectUrl, sendBotFlow }) {
  const router = express.Router();
  const publicDir = path.join(__dirname, "mini-app");
  router.use((req, res, next) => {
    // Telegram Web may embed Mini Apps in a frame; the main server's DENY
    // header is appropriate for the admin and setup pages, but not here.
    res.removeHeader("X-Frame-Options");
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org; object-src 'none'",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  router.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  router.get("/app.css", (_req, res) => res.sendFile(path.join(publicDir, "app.css")));
  router.get("/app.js", (_req, res) => res.sendFile(path.join(publicDir, "app.js")));
  router.get("/metro-secure-icon.png", (_req, res) => res.sendFile(path.join(publicDir, "metro-secure-icon.png")));
  router.use("/api", express.json({ limit: "12kb", strict: true }));
  router.use("/api", (req, res, next) => {
    const user = verifyTelegramInitData(req.body?.initData, botToken);
    if (!user) return res.status(401).json({ error: "Open Metro from Telegram to continue." });
    req.telegramUser = user;
    next();
  });
  router.use("/api", async (req, res, next) => {
    try {
      const account = await getAccount(req.telegramUser.id, req.telegramUser);
      if (!account?.customerExists) return res.status(403).json({ error: "Open Metro from the Telegram bot to continue." });
      req.account = account;
      next();
    } catch {
      console.error("Mini App customer lookup failed.");
      res.status(503).json({ error: "We couldn't load your account." });
    }
  });
  router.post("/api/overview", async (req, res) => {
    try {
      const packages = await getPackages();
      res.json({ account: customerAccount(req.account),
        packages: packages.map((pkg) => publicPackage(pkg, req.telegramUser.id, botToken)) });
    } catch {
      console.error("Mini App account lookup failed.");
      res.status(503).json({ error: "We couldn't load your account." });
    }
  });
  router.post("/api/packages", async (req, res) => {
    try {
      const packages = await getPackages();
      res.json({ packages: packages.map((pkg) => publicPackage(pkg, req.telegramUser.id, botToken)) });
    } catch {
      console.error("Mini App package lookup failed.");
      res.status(503).json({ error: "We couldn't load packages." });
    }
  });
  router.post("/api/package/detail", async (req, res) => {
    const selected = openToken(req.body?.selectionToken, req.telegramUser.id, botToken);
    if (selected?.kind !== "selection") return res.status(400).json({ error: "Select a package again." });
    try {
      const pkg = await getPackage(selected.id);
      if (!pkg) return res.status(404).json({ error: "This package is no longer available." });
      res.json({ package: publicPackage(pkg, req.telegramUser.id, botToken,
        selected.version !== pkg.version),
        confirmationToken: sealToken({ kind: "confirmation", id: pkg.id, version: pkg.version, at: Date.now() },
          req.telegramUser.id, botToken) });
    } catch {
      console.error("Mini App package detail failed.");
      res.status(503).json({ error: "We couldn't load this package." });
    }
  });
  router.post("/api/order/create", async (req, res) => {
    const selected = openToken(req.body?.confirmationToken, req.telegramUser.id, botToken);
    if (selected?.kind !== "confirmation" || typeof selected.version !== "string")
      return res.status(400).json({ error: "Review the package again." });
    try {
      const pkg = await getPackage(selected.id);
      if (!pkg) return res.status(404).json({ error: "This package is no longer available." });
      if (selected.version !== pkg.version) return res.status(409).json({
        error: "Package details changed. Please review the current values.",
        package: publicPackage(pkg, req.telegramUser.id, botToken, true),
        confirmationToken: sealToken({ kind: "confirmation", id: pkg.id, version: pkg.version, at: Date.now() },
          req.telegramUser.id, botToken),
      });
      const result = await createOrder(req.telegramUser, req.account, pkg.id, selected.version);
      if (result?.changed) {
        const current = await getPackage(selected.id);
        if (!current) return res.status(404).json({ error: "This package is no longer available." });
        return res.status(409).json({ error: "Package details changed. Please review again.",
          package: publicPackage(current, req.telegramUser.id, botToken, true),
          confirmationToken: sealToken({ kind: "confirmation", id: current.id, version: current.version, at: Date.now() },
            req.telegramUser.id, botToken) });
      }
      if (!result?.order) return res.status(409).json({ error: "We couldn't create your order. Try again." });
      res.json({ order: publicOrder(result.order), inProgress: Boolean(result.inProgress) });
    } catch {
      console.error("Mini App order creation failed.");
      res.status(503).json({ error: "We couldn't create your order." });
    }
  });
  router.post("/api/orders", async (req, res) => {
    try { res.json({ orders: (await getOrders(req.telegramUser.id)).map(publicOrder) }); }
    catch { console.error("Mini App order history failed."); res.status(503).json({ error: "We couldn't load orders." }); }
  });
  router.post("/api/order/status", async (req, res) => {
    if (!validOrderNumber(req.body?.orderNumber))
      return res.status(400).json({ error: "Invalid order." });
    try {
      const order = await getOrder(req.telegramUser.id, req.body.orderNumber);
      if (!order) return res.status(404).json({ error: "Order not found." });
      res.json({ order: publicOrder(order) });
    } catch { console.error("Mini App order status failed."); res.status(503).json({ error: "We couldn't load this order." }); }
  });
  router.post("/api/payment-methods", async (req, res) => {
    try { res.json({ methods: await getPaymentMethods() }); }
    catch { console.error("Mini App payment methods failed."); res.status(503).json({ error: "Payment methods are unavailable." }); }
  });
  router.post("/api/order/payment-method", async (req, res) => {
    const { orderNumber, method } = req.body || {};
    if (!validOrderNumber(orderNumber) || typeof method !== "string" || method.length > 40)
      return res.status(400).json({ error: "Invalid payment selection." });
    try {
      const order = await selectPaymentMethod(req.telegramUser.id, orderNumber, method);
      if (!order) return res.status(409).json({ error: "This order cannot accept payment." });
      res.json({ order: publicOrder(order) });
    } catch { console.error("Mini App payment selection failed."); res.status(503).json({ error: "We couldn't select payment." }); }
  });
  router.post("/api/order/payment-proof-handoff", async (req, res) => {
    const { orderNumber } = req.body || {};
    if (!validOrderNumber(orderNumber)) return res.status(400).json({ error: "Invalid order." });
    try {
      const ok = await handoffProof(req.telegramUser.id, orderNumber);
      if (!ok) return res.status(409).json({ error: "This order cannot accept proof." });
      res.json({ ok: true });
    } catch { console.error("Mini App payment proof handoff failed."); res.status(503).json({ error: "We couldn't open payment proof." }); }
  });
  router.post("/api/connect", async (req, res) => {
    try {
      const url = await getConnectUrl(req.telegramUser.id);
      if (!url) return res.status(409).json({ error: "Your VPN is not ready to connect." });
      res.json({ url });
    } catch {
      console.error("Mini App connect failed.");
      res.status(503).json({ error: "VPN setup is temporarily unavailable." });
    }
  });
  router.post("/api/flow", async (req, res) => {
    const { flow, packageToken: selectionToken } = req.body || {};
    const selected = selectionToken === undefined ? undefined :
      openToken(selectionToken, req.telegramUser.id, botToken);
    const packageId = selected?.id;
    if (!["renew", "packages", "support"].includes(flow) ||
        (selectionToken !== undefined && selected?.kind !== "selection")) {
      return res.status(400).json({ error: "Invalid selection." });
    }
    try {
      await sendBotFlow(req.telegramUser.id, flow, packageId);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: "Could not open the bot checkout. Try again." });
    }
  });
  return router;
}

module.exports = { verifyTelegramInitData, createMiniAppRouter };
