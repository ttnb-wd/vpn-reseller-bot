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

function createMiniAppRouter({ botToken, getAccount, getPackages, getConnectUrl, sendBotFlow }) {
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
  router.post("/api/overview", async (req, res) => {
    try {
      const [account, packages] = await Promise.all([
        getAccount(req.telegramUser.id), getPackages(),
      ]);
      res.json({ account, packages });
    } catch {
      res.status(503).json({ error: "Account details are temporarily unavailable." });
    }
  });
  router.post("/api/connect", async (req, res) => {
    try {
      const url = await getConnectUrl(req.telegramUser.id);
      if (!url) return res.status(409).json({ error: "Your VPN is not ready to connect." });
      res.json({ url });
    } catch {
      res.status(503).json({ error: "VPN setup is temporarily unavailable." });
    }
  });
  router.post("/api/flow", async (req, res) => {
    const { flow, packageId } = req.body || {};
    if (!["renew", "packages", "support"].includes(flow) ||
        (packageId !== undefined && (!Number.isSafeInteger(packageId) || packageId <= 0))) {
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
