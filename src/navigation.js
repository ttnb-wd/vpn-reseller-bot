const crypto = require("node:crypto");

function createNavigation() {
  const states = new Map();
  const key = (ctx) => ctx.chat?.type === "private" && ctx.chat?.id != null &&
    ctx.from?.id != null ? `${ctx.chat.id}:${ctx.from.id}` : null;
  const token = () => crypto.randomBytes(6).toString("base64url");
  const fresh = () => ({ current: "main", history: [], token: token(), touched: Date.now() });
  function state(ctx) {
    const id = key(ctx);
    if (!id) return null;
    let value = states.get(id);
    if (!value || Date.now() - value.touched > 30 * 60 * 1000) {
      value = fresh();
      states.set(id, value);
      if (states.size > 10000) {
        for (const [savedId, saved] of states) {
          if (Date.now() - saved.touched > 30 * 60 * 1000) states.delete(savedId);
        }
        if (states.size > 10000) states.delete(states.keys().next().value);
      }
    }
    value.touched = Date.now();
    return value;
  }
  function reset(ctx) {
    const value = state(ctx);
    if (value) Object.assign(value, fresh());
  }
  function enter(ctx, screen) {
    const value = state(ctx);
    if (!value) return null;
    if (value.current !== screen) {
      if (screen.startsWith("ta_edit_") && value.current.startsWith("ta_package_")) {
        value.current = value.history.pop() || "main";
      }
      if (/^(?:renew_)?duration_\d+_(?:1|3|6)$/.test(screen) &&
          /^(?:renew_)?package_\d+$/.test(value.current)) {
        value.current = value.history.pop() || "main";
      }
      value.history.push(value.current);
      if (value.history.length > 20) value.history.shift();
      value.current = screen;
    }
    value.token = token();
    return value.token;
  }
  function back(ctx, expectedToken) {
    const value = state(ctx);
    if (!value || value.token !== expectedToken || value.current === "main") return null;
    const leaving = value.current;
    value.current = value.history.pop() || "main";
    value.token = token();
    return { screen: value.current, leaving, token: value.token };
  }
  function currentToken(ctx) { return state(ctx)?.token || null; }
  return { reset, enter, back, currentToken };
}

module.exports = { createNavigation };
