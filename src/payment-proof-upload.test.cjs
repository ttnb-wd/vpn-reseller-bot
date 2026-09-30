const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const express = require("express");
const { createMiniAppRouter } = require("./mini-app");
const { isValidImage, parseMultipartProof, MAX_IMAGE_BYTES } = require("./payment-proof-upload");

const botToken = "123456:synthetic-telegram-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6xkAAAAASUVORK5CYII=", "base64");
function signedData(id = 42, authDate = Math.floor(Date.now() / 1000)) {
  const fields = new URLSearchParams({ auth_date: String(authDate),
    user: JSON.stringify({ id, first_name: "Test" }) });
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const check = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  fields.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return fields.toString();
}
function form(initData, bytes = png, mimeType = "image/png", filename = "proof.png") {
  const data = new FormData();
  data.append("initData", initData);
  data.append("orderNumber", "VPN-Itest123");
  data.append("proof", new Blob([bytes], { type: mimeType }), filename);
  return data;
}

test("multipart parser enforces image structure and bounded fields", async () => {
  assert.equal(isValidImage(png, "image/png"), true);
  assert.equal(isValidImage(Buffer.from("not an image"), "image/png"), false);
  assert.equal(isValidImage(png, "application/octet-stream"), false);
  assert.equal(isValidImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), "image/png"), false);
  const good = form(signedData());
  const request = new Request("https://example.test/upload", { method: "POST", body: good });
  const body = Buffer.from(await request.arrayBuffer());
  const parsed = await parseMultipartProof(body, request.headers.get("content-type"));
  assert.equal(parsed.orderNumber, "VPN-Itest123");
  assert.equal(parsed.image.equals(png), true);
  assert.equal(JSON.stringify(parsed).includes("proof.png"), false);
});

test("Mini App upload validates identity, ownership, type, size, idempotency and response privacy", async () => {
  let storedProof = null;
  let sends = 0;
  const order = { orderNumber: "VPN-Itest123", plan: "Basic", price: 3200,
    totalDataGb: 50, totalDurationDays: 30, createdAt: new Date("2026-09-30T00:00:00Z"),
    paymentMethod: "mobile_wallet", status: "PENDING_PAYMENT", paymentProof: null,
    customerId: 9, id: 4, vpnKey: "ss://private" };
  const app = express();
  app.use("/app", createMiniAppRouter({ botToken,
    async getAccount(id) { return { customerExists: id === 42 || id === 77 }; },
    async getPackages() { return []; }, async getPackage() { return null; },
    async createOrder() { return null; },
    async getOrder(id) { return id === 42 ? order : null; },
    async getOrders() { return []; }, async getPaymentMethods() { return []; },
    async selectPaymentMethod() { return null; }, async handoffProof() { return false; },
    async getConnectUrl() { return null; }, async sendBotFlow() {},
    async uploadProof(id, number, bytes, mimeType) {
      if (id !== 42 || number !== order.orderNumber) return null;
      if (storedProof) return { already: true, order };
      assert.equal(bytes.equals(png), true);
      assert.equal(mimeType, "image/png");
      sends++;
      storedProof = "private-telegram-file-id";
      order.paymentProof = storedProof;
      return { order };
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/app/api`;
  const upload = (body) => fetch(`${base}/order/payment-proof-upload`, { method: "POST", body });
  try {
    assert.equal((await upload(form("invalid"))).status, 401);
    assert.equal((await upload(form(signedData(42, Math.floor(Date.now() / 1000) - 3601)))).status, 401);
    assert.equal((await upload(form(signedData(77)))).status, 404);
    assert.equal((await upload(form(signedData(), png, "application/pdf", "evil.pdf"))).status, 400);
    assert.equal((await upload(form(signedData(), Buffer.from("not really a PNG"), "image/png"))).status, 400);
    assert.equal((await upload(form(signedData(), Buffer.alloc(MAX_IMAGE_BYTES + 1),
      "image/png"))).status, 413);
    assert.equal((await fetch(`${base}/order/payment-proof-upload`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signedData(), url: "https://evil.test/proof.png" }) })).status, 415);
    const accepted = await upload(form(signedData(), png, "image/png", "../../private.png"));
    assert.equal(accepted.status, 200);
    const data = await accepted.json();
    assert.equal(data.order.status, "PAYMENT_SUBMITTED");
    assert.equal(data.order.proofSubmitted, true);
    assert.equal(order.status, "PENDING_PAYMENT");
    for (const secret of ["private-telegram-file-id", "ss://private", "customerId", '"id":4', "private.png"])
      assert.equal(JSON.stringify(data).includes(secret), false);
    const status = await fetch(`${base}/order/status`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signedData(), orderNumber: order.orderNumber }) });
    assert.equal((await status.json()).order.status, "PAYMENT_SUBMITTED");
    for (let i = 0; i < 4; i++) {
      const duplicate = await upload(form(signedData()));
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json()).error, "Slip ရပြီးပါပြီ။ ထပ်တင်ဖို့ မလိုပါဘူး။");
    }
    assert.equal(sends, 1);
    assert.equal((await upload(form(signedData()))).status, 429);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
