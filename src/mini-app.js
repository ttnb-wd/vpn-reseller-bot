const crypto = require("node:crypto");
const express = require("express");
const path = require("node:path");
const { createWindowLimiter } = require("./abuse-limits");
const { MAX_REQUEST_BYTES, parseMultipartProof } = require("./payment-proof-upload");

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
    paymentMethod: order.paymentMethod || null,
    proofSubmitted: Boolean(order.paymentProof), status };
}
const validOrderNumber = (value) => typeof value === "string" && /^VPN-[A-Za-z0-9-]{1,80}$/.test(value);

function createMiniAppRouter({ botToken, getAccount, getPackages, getPackage,
  createOrder, getOrder, getOrders, getPaymentMethods, selectPaymentMethod,
  uploadProof, getConnectUrl, getSupportService, supportEvents }) {
  const router = express.Router();
  const publicDir = path.join(__dirname, "mini-app");
  const allowUploadIp = createWindowLimiter({ windowMs: 10 * 60000, max: 30 });
  const allowUploadCustomer = createWindowLimiter({ windowMs: 10 * 60000, max: 5 });
  const allowSupportRead = createWindowLimiter({ windowMs: 60000, max: 15 });
  const allowSupportSession = createWindowLimiter({ windowMs: 60000, max: 20 });
  router.use((req, res, next) => {
    // Telegram Web may embed Mini Apps in a frame; the main server's DENY
    // header is appropriate for the admin and setup pages, but not here.
    res.removeHeader("X-Frame-Options");
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org; object-src 'none'",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  router.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  router.get("/app.css", (_req, res) => res.sendFile(path.join(publicDir, "app.css")));
  router.get("/app.js", (_req, res) => res.sendFile(path.join(publicDir, "app.js")));
  router.get("/metro-secure-icon.png", (_req, res) => res.sendFile(path.join(publicDir, "metro-secure-icon.png")));
  router.get("/api/support/events", (req, res) => {
    const customerId = supportEvents?.consume(req.query.session);
    if (customerId == null) return res.status(401).json({ error: "Support session expired. Reconnect from the Mini App." });
    res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(": connected\n\n");
    supportEvents.subscribe(customerId, res);
  });
  const authenticateTelegram = (req, res, next) => {
    const user = verifyTelegramInitData(req.body?.initData, botToken);
    if (!user) return res.status(401).json({ error: "Open Metro from Telegram to continue." });
    req.telegramUser = user;
    next();
  };
  const resolveCustomer = async (req, res, next) => {
    try {
      const account = await getAccount(req.telegramUser.id, req.telegramUser);
      if (!account?.customerExists) return res.status(403).json({ error: "Your Metro Secure account is unavailable." });
      req.account = account;
      next();
    } catch {
      console.error("Mini App customer lookup failed.");
      res.status(503).json({ error: "We couldn't load your account." });
    }
  };
  router.post("/api/order/payment-proof-upload", (req, res, next) => {
    if (!allowUploadIp(req.ip)) return res.status(429).json({ error: "Please wait before trying another upload." });
    if (!/^multipart\/form-data(?:;|$)/i.test(req.headers["content-type"] || ""))
      return res.status(415).json({ error: "Please choose a JPG or PNG image." });
    const timer = setTimeout(() => req.destroy(), 20000);
    res.once("close", () => clearTimeout(timer));
    express.raw({ type: "multipart/form-data", limit: MAX_REQUEST_BYTES, inflate: false })(req, res, (error) => {
      clearTimeout(timer);
      if (error) return res.status(error.type === "entity.too.large" ? 413 : 400).json({
        error: error.type === "entity.too.large" ?
          "Image is too large. Please choose an image under 5 MB." : "Invalid upload." });
      next();
    });
  }, async (req, res, next) => {
    try {
      const upload = await parseMultipartProof(req.body, req.headers["content-type"]);
      req.body = { initData: upload.initData, orderNumber: upload.orderNumber };
      req.upload = upload;
      next();
    } catch (error) { res.status(error.status || 400).json({ error: error.message || "Invalid upload." }); }
  }, authenticateTelegram, resolveCustomer, async (req, res) => {
    if (!allowUploadCustomer(req.telegramUser.id))
      return res.status(429).json({ error: "Please wait before trying another upload." });
    if (!validOrderNumber(req.body.orderNumber))
      return res.status(400).json({ error: "This order is not available." });
    try {
      const result = await uploadProof(req.telegramUser.id, req.body.orderNumber,
        req.upload.image, req.upload.mimeType);
      if (result?.already) return res.status(409).json({
        error: "Payment proof has already been submitted.",
        order: publicOrder(result.order) });
      if (result?.busy) return res.status(409).json({
        error: "An upload is already in progress. Check Order History or contact Support if it does not finish." });
      if (!result?.order) return res.status(404).json({ error: "This order is not available." });
      res.json({ proofSubmitted: true, order: publicOrder(result.order) });
    } catch {
      console.error("Mini App payment proof upload failed.");
      res.status(503).json({ error: "We couldn't upload your payment proof. Please try again." });
    }
  });
  router.use("/api", express.json({ limit: "12kb", strict: true }));
  router.use("/api", authenticateTelegram);
  router.use("/api", resolveCustomer);
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
  router.post("/api/support/open", async (req, res) => {
    if (!allowSupportRead(req.telegramUser.id))
      return res.status(429).json({ error: "Please wait before refreshing Support." });
    try {
      const service = getSupportService();
      const target = await service.openOrResumeTicket(req.telegramUser.id);
      if (!target) return res.status(403).json({ error: "Your account is unavailable." });
      res.json(await service.listMessages(req.telegramUser.id));
    } catch { console.error("Mini App support opening failed.");
      res.status(503).json({ error: "Support is temporarily unavailable." }); }
  });
  router.post("/api/support/messages", async (req, res) => {
    if (!allowSupportRead(req.telegramUser.id))
      return res.status(429).json({ error: "Please wait before refreshing Support." });
    try { res.json(await getSupportService().listMessages(req.telegramUser.id)); }
    catch { console.error("Mini App support messages failed.");
      res.status(503).json({ error: "We couldn't load Support messages." }); }
  });
  router.post("/api/support/session", async (req, res) => {
    if (!supportEvents || !allowSupportSession(req.telegramUser.id))
      return res.status(429).json({ error: "Please wait before reconnecting Support." });
    try {
      const target = await getSupportService().openOrResumeTicket(req.telegramUser.id);
      if (!target) return res.status(403).json({ error: "Your account is unavailable." });
      res.json({ session: supportEvents.issue(target.customer.id) });
    } catch { console.error("Mini App support session failed.");
      res.status(503).json({ error: "Support is temporarily unavailable." }); }
  });
  router.post("/api/support/send", async (req, res) => {
    try {
      const result = await getSupportService().sendCustomerMessage(req.telegramUser.id, req.body?.text);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ ok: true, message: result.message });
    } catch { console.error("Mini App support send failed.");
      res.status(503).json({ error: "We couldn't send your message. Please try again." }); }
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
  return router;
}

module.exports = { verifyTelegramInitData, createMiniAppRouter };
