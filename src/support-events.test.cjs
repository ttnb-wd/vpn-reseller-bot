const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const express = require("express");
const { createSupportEvents } = require("./support-events");
const { createMiniAppRouter } = require("./mini-app");
const { createSupportService } = require("./support");
const { EventEmitter } = require("node:events");

function response(blocked = false) {
  const res = new EventEmitter();
  res.ended = false;
  res.write = () => !blocked;
  res.end = () => { res.ended = true; res.emit('close'); };
  res.destroy = res.end;
  return res;
}
test('SSE caps, backpressure, lifetime, dead clients and shutdown release every subscriber', async () => {
  const events = createSupportEvents('synthetic', { perCustomerMax: 1, globalMax: 2,
    lifetimeMs: 30, heartbeatMs: 1000 });
  const a = response(), b = response(), extra = response(), globalExtra = response();
  events.subscribe(1, a); events.subscribe(1, extra);
  assert.equal(extra.ended, true); assert.equal(events.subscriberCount(1), 1);
  events.subscribe(2, b); events.subscribe(3, globalExtra);
  assert.equal(globalExtra.ended, true);
  a.emit('close'); assert.equal(events.subscriberCount(1), 0);
  const slow = response(true); events.subscribe(1, slow); events.publish(1, { text: 'synthetic' });
  assert.equal(slow.ended, true); assert.equal(events.subscriberCount(1), 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(b.ended, true); assert.equal(events.subscriberCount(2), 0);
  const live = response(); events.subscribe(1, live); events.closeAll(); events.closeAll();
  assert.equal(live.ended, true); assert.equal(events.subscriberCount(1), 0);
  assert.equal(live.listenerCount('close'), 0); assert.equal(live.listenerCount('error'), 0);
  const late = response(); events.subscribe(1, late); assert.equal(late.ended, true);
});

const botToken = "123456:synthetic-telegram-token";
function signedData(id) {
  const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id }) });
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const check = [...fields.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  fields.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return fields.toString();
}

test("SSE handshake is authenticated, one-use, expiring, and isolated by customer", async () => {
  let clock = 1000;
  const events = createSupportEvents(botToken, { now: () => clock, heartbeatMs: 15 });
  const app = express();
  app.use("/app", createMiniAppRouter({ botToken, supportEvents: events,
    async getAccount(id) { return { customerExists: id === 42 || id === 77 }; },
    getSupportService() { return {
      async openOrResumeTicket(id) { return { customer: { id: id === 42 ? 1 : 2 } }; },
      async listMessages() { return { messages: [] }; },
    }; },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/app/api/support`;
  const post = (id, initData = signedData(id), extra = {}) => fetch(`${base}/session`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ initData, ...extra }) });
  const abortA = new AbortController();
  const abortB = new AbortController();
  try {
    assert.equal((await post(42, "bad")).status, 401);
    assert.equal((await post(88)).status, 403);
    assert.equal((await fetch(`${base}/events?session=invalid`)).status, 401);
    const expired = (await (await post(42)).json()).session;
    clock += 60_001;
    assert.equal((await fetch(`${base}/events?session=${expired}`)).status, 401);
    const tokenA = (await (await post(42, signedData(42), { customerId: 2, telegramId: 77 })).json()).session;
    const tokenB = (await (await post(77)).json()).session;
    assert.match(tokenA, /^[A-Za-z0-9_-]{43}$/);
    const a = await fetch(`${base}/events?session=${tokenA}`, { signal: abortA.signal });
    const b = await fetch(`${base}/events?session=${tokenB}`, { signal: abortB.signal });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.match(a.headers.get("content-type"), /text\/event-stream/);
    assert.equal((await fetch(`${base}/events?session=${tokenA}`)).status, 401);
    assert.equal(events.subscriberCount(1), 1);
    assert.equal(events.subscriberCount(2), 1);
    const readerA = a.body.getReader();
    const readerB = b.body.getReader();
    await readerA.read(); await readerB.read(); // connected comments
    const message = { key: events.messageId(101), sender: "support", text: "For A", createdAt: "2026-09-30T00:00:00Z" };
    events.publish(1, message);
    const chunk = new TextDecoder().decode((await readerA.read()).value);
    assert.match(chunk, /event: message/);
    assert.match(chunk, /For A/);
    assert.equal(chunk.includes('"id"'), false);
    // B receives only a content-free heartbeat while A's message is published.
    const heartbeat = new TextDecoder().decode((await readerB.read()).value);
    assert.match(heartbeat, /^: heartbeat\n\n$/);
    assert.doesNotMatch(heartbeat, /For A|42|77|customer|telegram|secret/i);
    abortA.abort(); abortB.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.subscriberCount(1), 0);
    assert.equal(events.subscriberCount(2), 0);
  } finally {
    abortA.abort(); abortB.abort();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("admin and bot messages publish immediately after save to the owning customer", async () => {
  const published = [];
  const events = createSupportEvents(botToken);
  const publish = events.publish;
  events.publish = (customerId, message) => { published.push({ customerId, message }); publish(customerId, message); };
  const tickets = [
    { id: 10, customerId: 1, status: "OPEN", adminReplySelected: true,
      adminReplySelectedAt: { toString: () => new Date().toISOString() }, customerInputActive: true },
    { id: 20, customerId: 2, status: "OPEN", adminReplySelected: false, customerInputActive: true },
  ];
  const customers = [{ id: 1, telegramId: "42" }, { id: 2, telegramId: "77" }];
  const rows = [];
  const db = { public: {
    Customer: { where(filter) { return { async first() {
      return customers.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
    } }; } },
    SupportTicket: { where(filter) { return {
      where() { return this; },
      async updateAll() { return []; },
      async first() { return tickets.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)); },
      async update(values) {
        const row = tickets.find((item) => Object.entries(filter).every(([key, value]) => item[key] === value));
        if (row) Object.assign(row, values);
        return row;
      },
    }; } },
    SupportMessage: { async create(values) {
      const row = { ...values, id: rows.length + 1 }; rows.push(row); return row;
    } },
  } };
  const sent = [];
  const bot = { telegram: { async sendMessage(...args) { sent.push(args); } } };
  const service = createSupportService({ db, bot, adminTelegramId: "999",
    isAdmin: (ctx) => ctx.from.id === 999, helpKeyboard: () => ({}), supportEvents: events });
  const admin = { from: { id: 999 }, message: { text: "Admin answer" }, async reply() {} };
  assert.equal(await service.handleText(admin), true);
  assert.equal(rows.length, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].customerId, 1);
  assert.equal(published[0].message.text, "Admin answer");
  assert.equal(published[0].message.sender, "support");
  assert.equal(Object.hasOwn(published[0].message, "id"), false);
  assert.equal(sent[0][0], "42");
  const botCustomer = { from: { id: 77 }, message: { text: "Bot question" }, async reply() {} };
  assert.equal(await service.handleText(botCustomer), true);
  assert.equal(published.length, 2);
  assert.equal(published[1].customerId, 2);
  assert.equal(published[1].message.text, "Bot question");
  assert.notEqual(published[0].message.key, published[1].message.key);
});
