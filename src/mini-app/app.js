function dashboardView(account, now = Date.now()) {
  const a = account || {};
  const hasSubscription = Boolean(a.hasSubscription);
  const limit = Number.isFinite(a.dataLimitGb) && a.dataLimitGb > 0 ? a.dataLimitGb : null;
  const used = Number.isFinite(a.dataUsedGb) && a.dataUsedGb >= 0 ? a.dataUsedGb : null;
  const percent = limit !== null && used !== null ? Math.max(0, Math.round(used / limit * 100)) : null;
  const remaining = limit !== null && used !== null ? Math.max(0, limit - used) : null;
  const expiry = a.expiresAt ? new Date(a.expiresAt).getTime() : NaN;
  const days = Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 86400000)) : null;
  const status = !hasSubscription ? "NONE" : a.status === "REVOKED" ? "REVOKED" :
    a.status === "EXPIRED" || Number.isFinite(expiry) && expiry <= now ? "EXPIRED" :
    a.status === "ACTIVE" ? "ACTIVE" : "INACTIVE";
  const warning = percent === null || percent < 80 ? "" :
    percent >= 100 ? "Data limit reached" :
    percent >= 95 ? "Very little data remains. Renew your VPN to keep browsing." :
      "You're getting close to your data limit.";
  return { status, limit, used, percent, remaining, days, warning };
}
if (typeof module !== "undefined") module.exports = { dashboardView };

if (typeof document !== "undefined") (() => {
  const tg = window.Telegram?.WebApp;
  const initData = tg?.initData || "";
  const $ = (id) => document.getElementById(id);
  const state = { account: null, packages: [], tab: "home", lastLoad: 0, loading: false };
  const show = (id, visible) => $(id).classList.toggle("hidden", !visible);
  const set = (id, value) => { $(id).textContent = value; };
  const notice = (value, error = false) => {
    set("message", value);
    $("message").classList.toggle("error", error);
  };
  const gb = (value) => value === null ? "Unavailable" :
    `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)} GB`;
  const date = (value) => {
    const parsed = value ? new Date(value) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ?
      new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(parsed) : "Unavailable";
  };
  const sync = (value) => value ? date(value) : "Sync time unavailable";
  const days = (value) => value === null ? "Unavailable" : `${value} ${value === 1 ? "day" : "days"}`;
  const statusLabel = { ACTIVE: "🟢 Active", EXPIRED: "⛔ Expired", REVOKED: "⛔ VPN Unavailable",
    INACTIVE: "VPN Unavailable", NONE: "No Active VPN" };
  if (tg) { tg.ready(); tg.expand(); }
  async function api(endpoint, extra = {}) {
    const response = await fetch(`api/${endpoint}`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, ...extra }), cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Please try again.");
    return data;
  }
  function progress(id, percent) {
    const value = percent === null ? 0 : Math.min(100, percent);
    $(id).querySelector("span").style.width = `${value}%`;
    $(id).setAttribute("aria-valuenow", String(value));
    $(id).setAttribute("aria-valuetext", percent === null ? "Usage unavailable" : `${percent}% used`);
  }
  function navigate(tab) {
    state.tab = tab;
    for (const name of ["home", "vpn", "usage", "packages"]) show(`${name}-panel`, tab === name);
    for (const button of document.querySelectorAll(".nav-button"))
      button.classList.toggle("active", button.dataset.tab === tab ||
        tab === "usage" && button.dataset.tab === "vpn");
    window.scrollTo(0, 0);
  }
  function empty(id, view) {
    const target = $(id);
    target.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = view.status === "REVOKED" ? "VPN Unavailable" :
      view.status === "EXPIRED" ? "VPN Expired" : "No active VPN yet";
    const detail = document.createElement("p");
    detail.textContent = view.status === "REVOKED" ? "Please contact Support for help with this VPN." :
      view.status === "EXPIRED" ? `Expired on ${date(state.account.expiresAt)}` :
        "Choose a package to get started.";
    const button = document.createElement("button");
    button.type = "button"; button.className = "primary-button";
    button.textContent = view.status === "REVOKED" ? "🎧 Support" :
      view.status === "EXPIRED" ? "♻️ Renew VPN" : "View Packages";
    button.addEventListener("click", () => view.status === "REVOKED" ? openFlow("support") :
      view.status === "EXPIRED" ? openFlow("renew") : navigate("packages"));
    target.append(title, detail, button);
  }
  function renderPackages() {
    const list = $("package-list");
    list.replaceChildren();
    if (!state.packages.length) {
      const p = document.createElement("p"); p.className = "muted";
      p.textContent = "No packages are available right now."; list.append(p);
    }
    for (const pkg of state.packages) {
      const card = document.createElement("article"); card.className = "card package-card";
      const title = document.createElement("h3"); title.textContent = pkg.name;
      const detail = document.createElement("p"); detail.textContent = `${gb(pkg.dataLimitGb)} · ${pkg.durationDays} days`;
      const price = document.createElement("strong"); price.textContent =
        `${new Intl.NumberFormat("en-US").format(Number(pkg.priceMmk))} MMK`;
      const button = document.createElement("button"); button.type = "button";
      button.className = "secondary-button";
      button.textContent = state.account?.hasSubscription ? "Renew with this plan" : "Choose package";
      button.addEventListener("click", () => openFlow(state.account?.hasSubscription ? "renew" : "packages", pkg.selectionToken));
      card.append(title, detail, price, button); list.append(card);
    }
  }
  function render() {
    const a = state.account;
    const v = dashboardView(a);
    set("greeting", a.displayName ? `Welcome, ${a.displayName}` : "Your private network");
    set("home-status", statusLabel[v.status]);
    $("home-status").dataset.status = v.status;
    set("home-status-detail", v.status === "EXPIRED" ? `Expired on ${date(a.expiresAt)}` :
      v.status === "REVOKED" ? "Contact Support for help with this VPN." :
      v.status === "NONE" ? "Choose a package to get started." :
        v.status === "ACTIVE" && v.days !== null && v.days <= 7 ? "⚠️ Expiring Soon" : "");
    const normal = v.status === "ACTIVE";
    show("home-empty", v.status === "NONE");
    show("home-subscription", a.hasSubscription && v.status !== "REVOKED");
    show("home-actions", a.hasSubscription && v.status !== "REVOKED");
    if (a.hasSubscription && v.status !== "REVOKED") {
      set("home-plan", a.plan || "Current plan");
      set("home-server", a.serverLabel || "VPN server");
      set("home-usage", `${v.percent === null ? "Usage unavailable" : v.percent + "% used"} · ${gb(v.limit)} allowance`);
      progress("home-progress", v.percent);
      set("home-remaining", gb(v.remaining)); set("home-used", gb(v.used));
      set("home-expiry", date(a.expiresAt)); set("home-days", days(v.days));
      set("home-sync", sync(a.usageSyncedAt));
    }
    $("connect-button").disabled = $("vpn-connect-button").disabled = !normal || !a.canConnect;
    show("vpn-empty", !a.hasSubscription || v.status === "REVOKED");
    show("vpn-details", a.hasSubscription && v.status !== "REVOKED");
    show("vpn-actions", a.hasSubscription && v.status !== "REVOKED");
    if (!a.hasSubscription || v.status === "REVOKED") empty("vpn-empty", v);
    if (a.hasSubscription && v.status !== "REVOKED") {
      set("vpn-status", statusLabel[v.status]); $("vpn-status").dataset.status = v.status;
      set("vpn-plan", a.plan || "Unavailable"); set("vpn-server", a.serverLabel || "VPN server");
      set("vpn-limit", gb(v.limit)); set("vpn-used", gb(v.used));
      set("vpn-remaining", gb(v.remaining)); set("vpn-percent", v.percent === null ? "Unavailable" : `${v.percent}%`);
      set("vpn-start", date(a.startedAt)); set("vpn-expiry", date(a.expiresAt));
      set("vpn-days", days(v.days)); set("vpn-subscription-status", statusLabel[v.status]);
    }
    show("usage-empty", !a.hasSubscription || v.status === "REVOKED");
    show("usage-details", a.hasSubscription && v.status !== "REVOKED");
    if (!a.hasSubscription || v.status === "REVOKED") empty("usage-empty", v);
    if (a.hasSubscription && v.status !== "REVOKED") {
      set("usage-used", gb(v.used)); set("usage-percentage", v.percent === null ? "Usage unavailable" : `${v.percent}% used`);
      progress("usage-progress", v.percent); set("usage-limit", gb(v.limit));
      set("usage-remaining", gb(v.remaining)); set("usage-sync", sync(a.usageSyncedAt));
      set("usage-expiry", date(a.expiresAt));
      set("usage-warning", v.warning); show("usage-warning", Boolean(v.warning));
    }
    show("usage-renew-button", v.status === "EXPIRED" || v.percent !== null && v.percent >= 100);
    renderPackages();
  }
  async function load(force = false) {
    if (state.loading || !force && Date.now() - state.lastLoad < 30000) return;
    state.loading = true; $("refresh-button").disabled = true;
    show("error-panel", false);
    if (!state.account) { show("loading", true); show("content", false); }
    try {
      if (!initData) throw new Error("Missing Telegram session");
      const { account, packages } = await api("overview");
      state.account = account; state.packages = packages; state.lastLoad = Date.now();
      render(); show("content", true); show("loading", false); notice("");
    } catch {
      show("loading", false); show("content", false); show("error-panel", true);
      notice("");
    } finally { state.loading = false; $("refresh-button").disabled = false; }
  }
  async function connect() {
    notice("Opening secure setup…");
    try {
      const { url } = await api("connect");
      notice("");
      if (tg?.openLink) tg.openLink(url, { try_instant_view: false });
      else window.location.assign(url);
    } catch { notice("We couldn't open VPN setup. Try again.", true); }
  }
  async function openFlow(flow, packageToken) {
    notice(flow === "support" ? "Opening Support in the bot…" : "Opening packages in the bot…");
    try {
      await api("flow", { flow, packageToken });
      notice("Continue in your Telegram chat with Metro Secure.");
      if (tg?.close) setTimeout(() => tg.close(), 900);
    } catch { notice("We couldn't open the bot flow. Try again.", true); }
  }
  for (const id of ["connect-button", "vpn-connect-button"]) $(id).addEventListener("click", connect);
  for (const id of ["renew-button", "vpn-renew-button", "usage-renew-button"])
    $(id).addEventListener("click", () => openFlow("renew"));
  $("support-button").addEventListener("click", () => openFlow("support"));
  for (const id of ["view-usage-button", "vpn-usage-button"])
    $(id).addEventListener("click", () => navigate("usage"));
  $("view-packages-button").addEventListener("click", () => navigate("packages"));
  $("usage-back-button").addEventListener("click", () => navigate("vpn"));
  $("refresh-button").addEventListener("click", () => load());
  $("retry-button").addEventListener("click", () => load(true));
  for (const button of document.querySelectorAll(".nav-button"))
    button.addEventListener("click", () => navigate(button.dataset.tab));
  load(true);
})();
