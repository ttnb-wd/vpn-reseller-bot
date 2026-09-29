(() => {
  const tg = window.Telegram?.WebApp;
  const $ = (id) => document.getElementById(id);
  const message = (text, error = false) => { $("message").textContent = text; $("message").classList.toggle("error", error); };
  const initData = tg?.initData || "";
  const state = { account: null, packages: [] };

  if (tg) { tg.ready(); tg.expand(); }
  async function api(endpoint, extra = {}) {
    const response = await fetch(`api/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, ...extra }), cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Please try again.");
    return data;
  }
  function date(value) {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(parsed);
  }
  function number(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Number(value)) : "0"; }
  function render() {
    const a = state.account || {};
    const active = a.status === "ACTIVE";
    $("status-pill").textContent = active ? "● Active" : a.status === "EXPIRED" ? "Expired" : "No active plan";
    $("status-pill").classList.toggle("active", active);
    $("region").textContent = a.region || "Global Network";
    $("plan-name").textContent = a.plan || "No plan yet";
    $("vpn-plan").textContent = a.plan || "No plan yet";
    $("vpn-status").textContent = active ? "Active" : a.status === "EXPIRED" ? "Expired" : "Unavailable";
    $("expiry").textContent = date(a.expiresAt);
    $("vpn-expiry").textContent = date(a.expiresAt);
    const used = Math.max(0, Number(a.dataUsedGb) || 0);
    const limit = Math.max(0, Number(a.dataLimitGb) || 0);
    $("usage").textContent = `${number(used)} GB / ${number(limit)} GB`;
    const percentage = limit ? Math.min(100, Math.round(used / limit * 100)) : 0;
    $("progress-fill").style.width = `${percentage}%`;
    $("progress").setAttribute("aria-valuenow", String(percentage));
    $("connect-button").disabled = $("vpn-connect-button").disabled = !a.canConnect;
    $("renew-button").disabled = !a.hasSubscription;
    const list = $("package-list");
    list.replaceChildren();
    if (!state.packages.length) { const p = document.createElement("p"); p.className = "package-empty"; p.textContent = "No packages are available right now."; list.append(p); }
    for (const pkg of state.packages) {
      const card = document.createElement("article"); card.className = "package-card";
      const title = document.createElement("h3"); title.textContent = pkg.name;
      const details = document.createElement("p"); details.textContent = `${number(pkg.dataLimitGb)} GB · ${number(pkg.durationDays)} days`;
      const price = document.createElement("div"); price.className = "package-price"; price.textContent = `${new Intl.NumberFormat("en-US").format(Number(pkg.priceMmk))} MMK`;
      const button = document.createElement("button"); button.type = "button"; button.textContent = a.hasSubscription ? "Renew with this plan →" : "Choose package →";
      button.addEventListener("click", () => openFlow(a.hasSubscription ? "renew" : "packages", pkg.id));
      card.append(title, details, price, button); list.append(card);
    }
  }
  async function connect() {
    message("Opening secure setup…");
    try {
      const { url } = await api("connect");
      message("");
      if (tg?.openLink) tg.openLink(url, { try_instant_view: false });
      else window.location.assign(url);
    } catch (error) { message(error.message, true); }
  }
  async function openFlow(flow, packageId) {
    message("Opening checkout in the bot…");
    try {
      await api("flow", { flow, packageId });
      message("Continue in your Telegram chat with Metro Secure.");
      if (tg?.close) setTimeout(() => tg.close(), 900);
    } catch (error) { message(error.message, true); }
  }
  $("connect-button").addEventListener("click", connect);
  $("vpn-connect-button").addEventListener("click", connect);
  $("renew-button").addEventListener("click", () => openFlow("renew"));
  for (const button of document.querySelectorAll(".nav-button")) button.addEventListener("click", () => {
    for (const tab of ["home", "vpn", "packages"]) $(tab + "-panel").classList.toggle("hidden", button.dataset.tab !== tab);
    for (const nav of document.querySelectorAll(".nav-button")) nav.classList.toggle("active", nav === button);
    window.scrollTo(0, 0);
  });
  if (!initData) { message("Open Metro from the Telegram bot to see your account.", true); return; }
  api("overview").then(({ account, packages }) => { state.account = account; state.packages = packages; render(); message(""); })
    .catch((error) => message(error.message, true));
})();
