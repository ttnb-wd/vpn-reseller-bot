const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function createNode(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const node = { tagName: tag, children: [], dataset: {}, style: {}, value: "", textContent: "",
    disabled: false, scrollHeight: 100, clientHeight: 100, scrollTop: 0,
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); } },
    addEventListener(name, fn) { listeners.set(name, fn); },
    fire(name, event = {}) { return listeners.get(name)?.(event); },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = [...items]; },
    remove() {},
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      return this.children.filter((item) => item.className?.split(" ").includes(selector.slice(1)));
    },
    insertBefore(item, later) { this.children.splice(this.children.indexOf(later), 0, item); },
    scrollTo({ top }) { this.scrollTop = top; },
    setAttribute() {},
    requestSubmit() { return this.fire("submit", { preventDefault() {} }); },
  };
  return node;
}

test("Support client appends, deduplicates, recovers, polls only when unhealthy, and sends by Enter", async () => {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, createNode()); return nodes.get(id); };
  const documentListeners = new Map();
  const nav = createNode("button"); nav.dataset.tab = "support";
  const document = { hidden: false, getElementById: get, createElement: createNode,
    querySelectorAll(selector) { return selector === ".nav-button" ? [nav] : []; },
    addEventListener(name, fn) { documentListeners.set(name, fn); } };
  const timers = new Map(); let nextTimer = 1;
  const intervals = new Map();
  const setTimeoutFake = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; };
  const clearTimeoutFake = (id) => timers.delete(id);
  const setIntervalFake = (fn, ms) => { const id = nextTimer++; intervals.set(id, { fn, ms }); return id; };
  const clearIntervalFake = (id) => intervals.delete(id);
  const runTimeout = async (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `expected ${ms}ms timer`);
    timers.delete(entry[0]); entry[1].fn(); await flush();
  };
  const messages = [];
  const requests = [];
  let session = 0;
  const fetch = async (url, options) => {
    const endpoint = String(url).split("api/")[1];
    requests.push(endpoint);
    let data = {};
    if (endpoint === "overview") throw new Error("No overview fixture");
    if (endpoint === "support/open" || endpoint === "support/messages") data = { messages: [...messages] };
    if (endpoint === "support/session") data = { session: `session${++session}` };
    if (endpoint === "support/send") {
      const text = JSON.parse(options.body).text;
      const message = { key: `own${messages.length}`, sender: "customer", text,
        createdAt: "2026-09-30T00:00:02Z" };
      messages.push(message); data = { ok: true, message };
    }
    return { ok: true, async json() { return data; } };
  };
  const sources = [];
  class EventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; sources.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(message) { this.listeners.get("message")({ data: JSON.stringify(message) }); }
    close() { this.closed = true; }
  }
  const window = { Telegram: { WebApp: { initData: "signed", ready() {}, expand() {} } },
    scrollTo() {}, location: { assign() {} } };
  const source = readFileSync(path.join(__dirname, "mini-app", "app.js"), "utf8");
  vm.runInNewContext(source, { document, window, fetch, EventSource,
    setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
    setInterval: setIntervalFake, clearInterval: clearIntervalFake,
    URL, Intl, Date, console });
  await flush();
  nav.fire("click");
  await flush();
  assert.equal(sources.length, 1);
  assert.match(sources[0].url, /support\/events\?session=session1/);
  sources[0].onopen(); await flush();
  assert.equal(intervals.size, 0);
  const incoming = { key: "opaque1", sender: "support", text: "Hello", createdAt: "2026-09-30T00:00:01Z" };
  sources[0].emit(incoming);
  sources[0].emit(incoming);
  const conversation = get("support-conversation");
  assert.equal(conversation.querySelectorAll(".support-message").length, 1);
  assert.equal(get("support-input").value, "");
  get("support-input").value = "My draft";
  sources[0].emit({ key: "opaque2", sender: "support", text: "More", createdAt: "2026-09-30T00:00:02Z" });
  assert.equal(get("support-input").value, "My draft");
  const keydown = get("support-input");
  let prevented = false;
  keydown.fire("keydown", { key: "Enter", shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  keydown.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.equal(messages.at(-1).text, "My draft");
  assert.equal(conversation.querySelectorAll(".support-message").length, 3);
  sources[0].emit(messages.at(-1));
  assert.equal(conversation.querySelectorAll(".support-message").length, 3);
  conversation.scrollHeight = 500; conversation.clientHeight = 100; conversation.scrollTop = 100;
  sources[0].emit({ key: "older", sender: "support", text: "Read later",
    createdAt: "2026-09-30T00:00:02.500Z" });
  assert.equal(get("support-new-messages").classList.contains("hidden"), false);
  get("support-new-messages").fire("click");
  assert.equal(conversation.scrollTop, 500);
  assert.equal(get("support-new-messages").classList.contains("hidden"), true);
  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  assert.equal(intervals.size, 0);
  await runTimeout(3000);
  assert.equal([...intervals.values()][0].ms, 7000);
  const beforeFallback = requests.filter((value) => value === "support/messages").length;
  [...intervals.values()][0].fn(); await flush();
  assert.equal(requests.filter((value) => value === "support/messages").length, beforeFallback + 1);
  messages.push({ key: "missed", sender: "support", text: "While offline", createdAt: "2026-09-30T00:00:03Z" });
  await runTimeout(1000);
  assert.equal(sources.length, 2);
  sources[1].onopen(); await flush();
  assert.equal(intervals.size, 0);
  assert.equal(conversation.querySelectorAll(".support-message").length, 5);
  assert.equal(conversation.children.at(-1).children[1].textContent, "While offline");
  assert.equal(requests.filter((value) => value === "support/messages").length >= 2, true);
});

async function flush() { await new Promise((resolve) => setImmediate(resolve)); }
