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
  const state = { account: null, packages: [], tab: "home", lastLoad: 0, loading: false,
    checkout: null, order: null, methods: [], uploadFile: null, previewUrl: null,
    uploading: false, uploadPercent: 0 };
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
  const money = (value) => `${new Intl.NumberFormat("en-US").format(Number(value))} MMK`;
  const orderStatus = { PENDING_PAYMENT: "Pending Payment", PAYMENT_SUBMITTED: "Payment Submitted",
    PROCESSING: "Processing", PAID: "Activated", PAYMENT_REJECTED: "Rejected",
    CANCELLED: "Cancelled", EXPIRED: "Expired" };
  const statusLabel = { ACTIVE: "🟢 Active", EXPIRED: "⛔ Expired", REVOKED: "⛔ VPN Unavailable",
    INACTIVE: "VPN Unavailable", NONE: "No Active VPN" };
  if (tg) { tg.ready(); tg.expand(); }
  async function api(endpoint, extra = {}) {
    const response = await fetch(`api/${endpoint}`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, ...extra }), cache: "no-store" });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "Please try again.");
      error.data = data;
      throw error;
    }
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
    for (const name of ["home", "vpn", "usage", "packages", "checkout", "history"])
      show(`${name}-panel`, tab === name);
    for (const button of document.querySelectorAll(".nav-button"))
      button.classList.toggle("active", button.dataset.tab === tab ||
        tab === "usage" && button.dataset.tab === "vpn" ||
        ["checkout", "history"].includes(tab) && button.dataset.tab === "packages");
    window.scrollTo(0, 0);
    if (tab === "packages") void refreshPackages();
    if (tab === "history") void refreshHistory();
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
    button.addEventListener("click", () => view.status === "REVOKED" ? openFlow("support") : navigate("packages"));
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
      button.textContent = dashboardView(state.account).status === "ACTIVE" ? "Renew" : "Buy";
      button.addEventListener("click", () => selectPackage(pkg.selectionToken));
      card.append(title, detail, price, button); list.append(card);
    }
  }
  function line(label, value) {
    const row = document.createElement("div"); row.className = "detail-row";
    const left = document.createElement("span"); left.textContent = label;
    const right = document.createElement("strong"); right.textContent = value;
    row.append(left, right); return row;
  }
  function action(label, handler, primary = false) {
    const button = document.createElement("button"); button.type = "button";
    button.className = primary ? "primary-button" : "secondary-button";
    button.textContent = label; button.addEventListener("click", handler); return button;
  }
  function paragraph(value, className = "note") {
    const p = document.createElement("p"); p.className = className; p.textContent = value; return p;
  }
  function card(...children) {
    const article = document.createElement("article"); article.className = "card";
    article.append(...children); return article;
  }
  function title(value) {
    const h = document.createElement("h3"); h.textContent = value; return h;
  }
  async function refreshPackages() {
    const list = $("package-list");
    list.replaceChildren(card(paragraph("Loading packages…")));
    try {
      const { packages } = await api("packages");
      state.packages = packages; renderPackages();
    } catch {
      list.replaceChildren(card(paragraph("We couldn't load packages."),
        action("Try Again", refreshPackages)));
    }
  }
  function renderCheckout() {
    const flow = state.checkout;
    const body = $("checkout-body"); const actions = $("checkout-actions");
    body.replaceChildren(); actions.replaceChildren();
    if (!flow) return;
    const pkg = flow.package;
    const order = state.order;
    const step = flow.step;
    set("checkout-title", { detail: flow.renew ? "Renew VPN" : "Buy VPN",
      methods: "Payment Method", instructions: "Payment Instructions",
      upload: "Upload Payment Proof", submitted: "Payment Submitted",
      progress: "Order in Progress", status: "Order Status" }[step] || "Checkout");
    set("checkout-subtitle", step === "detail" ? "Review the current package before continuing." :
      step === "methods" ? "Choose where to send your payment." :
      step === "instructions" ? "Pay the exact amount, then upload or send your proof." :
      step === "upload" ? "Choose a clear screenshot of your payment." :
      step === "submitted" ? "Your payment proof is waiting for review." :
      "You can check this order again in Order History.");
    if (step === "detail" && pkg) {
      body.append(card(title(pkg.name), line("Data allowance", gb(pkg.dataLimitGb)),
        line("Duration", `${pkg.durationDays} days`), line("Price", money(pkg.priceMmk)),
        line("Action", flow.renew ? "Renew" : "Buy"),
        line("Current VPN", statusLabel[dashboardView(state.account).status]),
        ...(pkg.changed ? [paragraph("Package details changed. Please review these current values before continuing.", "usage-warning")] : [])));
      actions.append(action("Continue", confirmPackage, true), action("Back to Packages", () => navigate("packages")));
    } else if (step === "methods" && order) {
      body.append(card(title(order.plan), line("Amount", money(order.amountMmk)),
        line("Order number", order.orderNumber),
        paragraph("Your VPN activates after payment proof is reviewed and approved.")));
      if (!state.methods.length) body.append(card(paragraph("Payment methods are unavailable right now."),
        action("Try Again", loadMethods)));
      for (const method of state.methods) body.append(card(title(method.name),
        line("Account name", method.accountName), line("Destination", method.accountNumber),
        action(`Pay with ${method.name}`, () => chooseMethod(method), true)));
      actions.append(action("View Order", () => showOrder(order.orderNumber)));
    } else if (step === "instructions" && order) {
      const method = state.methods.find((item) => item.code === order.paymentMethod);
      body.append(card(title(method?.name || "Payment"), line("Pay", money(order.amountMmk)),
        line("Account name", method?.accountName || "Unavailable"),
        line("Destination", method?.accountNumber || "Unavailable"),
        line("Order reference", order.orderNumber),
        paragraph("Transfer the exact amount to this account. Upload a screenshot here or send it as a photo in the bot. Activation follows admin approval.")));
      actions.append(action("Upload Payment Proof", () => { state.checkout.step = "upload"; renderCheckout(); }, true),
        action("Send Payment Proof in Bot", proofHandoff),
        action("Change Payment Method", loadMethods), action("View Order", () => showOrder(order.orderNumber)));
    } else if (step === "upload" && order) {
      const input = document.createElement("input"); input.type = "file";
      input.id = "payment-proof-file"; input.accept = "image/jpeg,image/png";
      input.className = "proof-input"; input.disabled = state.uploading;
      input.addEventListener("change", () => chooseProofFile(input.files?.[0]));
      const label = document.createElement("label"); label.className = "secondary-button proof-picker";
      label.htmlFor = input.id; label.textContent = state.uploadFile ? "Choose Another Image" : "Choose JPG or PNG";
      body.append(card(title("Payment screenshot"), line("Order", order.orderNumber),
        paragraph("JPG or PNG, up to 5 MB."), input, label));
      if (state.uploadFile) {
        const preview = document.createElement("img"); preview.className = "proof-preview";
        preview.src = state.previewUrl; preview.alt = "Selected payment proof preview";
        body.append(card(preview, line("File", state.uploadFile.name),
          line("Size", `${(state.uploadFile.size / 1024 / 1024).toFixed(1)} MB`)));
        if (!state.uploading) actions.append(action("Remove Image", () => { clearProofFile(); renderCheckout(); }));
      }
      if (state.uploading) {
        const progressText = paragraph(`Uploading… ${state.uploadPercent}%`, "upload-progress-text");
        const bar = document.createElement("progress"); bar.className = "upload-progress";
        bar.max = 100; bar.value = state.uploadPercent;
        body.append(card(progressText, bar));
      }
      if (state.uploadFile) {
        const submit = action(state.uploading ? "Uploading…" : "Submit Payment Proof", submitProof, true);
        submit.disabled = state.uploading; actions.append(submit);
      }
      if (!state.uploading) actions.append(action("Back to Instructions", () => {
        state.checkout.step = "instructions"; renderCheckout();
      }), action("Contact Support", () => openFlow("support")));
    } else if (step === "submitted" && order) {
      body.append(card(title("Payment Submitted"), line("Order number", order.orderNumber),
        line("Package", order.plan), line("Amount", money(order.amountMmk)),
        line("Payment method", state.methods.find((item) => item.code === order.paymentMethod)?.name || "Selected"),
        line("Status", orderStatus[order.status] || "Payment Submitted"),
        paragraph("Your payment proof has been received and is waiting for review.")));
      actions.append(action("View Order", () => showOrder(order.orderNumber), true),
        action("Back to Packages", () => navigate("packages")));
    } else if (step === "progress" && order) {
      body.append(card(title("You already have an order in progress."),
        line("Order number", order.orderNumber), line("Package", order.plan),
        line("Status", orderStatus[order.status] || "In progress")));
      actions.append(action("View Order", () => showOrder(order.orderNumber), true),
        action("Back", () => navigate("packages")));
    } else if (step === "status" && order) {
      body.append(card(title(orderStatus[order.status] || "Order in progress"),
        line("Order number", order.orderNumber), line("Package", order.plan),
        line("Amount", money(order.amountMmk)), line("Created", date(order.createdAt)),
        line("Payment method", state.methods.find((item) => item.code === order.paymentMethod)?.name ||
          (order.paymentMethod ? "Selected" : "Not selected")),
        line("Status", orderStatus[order.status] || "In progress"),
        paragraph(order.status === "PAYMENT_SUBMITTED" ? "Your payment proof has been received and is waiting for review." :
          order.status === "PAID" ? "Your VPN is activated. Open My VPN to connect." :
          "Activation follows payment proof review and approval.")));
      if (order.status === "PENDING_PAYMENT" && order.paymentMethod)
        actions.append(action("Upload Payment Proof", () => {
          state.checkout.step = "upload"; renderCheckout();
        }, true), action("Send Payment Proof in Bot", proofHandoff));
      else if (order.status === "PENDING_PAYMENT")
        actions.append(action("Choose Payment Method", loadMethods, true));
      actions.append(action("Refresh Status", () => showOrder(order.orderNumber)),
        action("Back to Packages", () => navigate("packages")));
    }
  }
  async function selectPackage(selectionToken) {
    notice(""); navigate("checkout");
    $("checkout-body").replaceChildren(card(paragraph("Loading package…")));
    try {
      const result = await api("package/detail", { selectionToken });
      state.checkout = { step: "detail", package: result.package,
        confirmationToken: result.confirmationToken,
        renew: dashboardView(state.account).status === "ACTIVE" };
      state.order = null; renderCheckout();
    } catch { notice("We couldn't load this package. Try again.", true); navigate("packages"); }
  }
  async function confirmPackage() {
    const token = state.checkout.confirmationToken;
    $("checkout-actions").replaceChildren();
    notice("Creating your order…");
    try {
      const result = await api("order/create", { confirmationToken: token });
      state.order = result.order;
      state.checkout.step = result.inProgress ? "progress" : "methods";
      notice("");
      if (result.inProgress) renderCheckout();
      else await loadMethods();
    } catch (error) {
      // A changed package is returned by the server with its current values.
      if (error.data?.package && error.data?.confirmationToken) {
        state.checkout.package = error.data.package;
        state.checkout.confirmationToken = error.data.confirmationToken;
        state.checkout.step = "detail";
        notice(""); renderCheckout();
      } else { notice(error.message || "We couldn't create your order.", true); renderCheckout(); }
    }
  }
  async function loadMethods() {
    state.checkout.step = "methods"; state.methods = []; renderCheckout();
    try {
      state.methods = (await api("payment-methods")).methods;
      renderCheckout();
    } catch { renderCheckout(); }
  }
  async function chooseMethod(method) {
    notice("Saving payment method…");
    try {
      const { order } = await api("order/payment-method",
        { orderNumber: state.order.orderNumber, method: method.code });
      state.order = order; state.checkout.step = "instructions";
      notice(""); renderCheckout();
    } catch { notice("We couldn't select that payment method. Try again.", true); }
  }
  function clearProofFile() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null; state.uploadFile = null; state.uploadPercent = 0;
  }
  function chooseProofFile(file) {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      notice("Please upload a JPG or PNG image.", true); return;
    }
    if (file.size > 5 * 1024 * 1024) {
      notice("Image is too large. Please choose an image under 5 MB.", true); return;
    }
    if (file.size < 24) {
      notice("Please choose a valid payment image.", true); return;
    }
    clearProofFile();
    state.uploadFile = file;
    state.previewUrl = URL.createObjectURL(file);
    notice(""); renderCheckout();
  }
  function uploadRequest(file, orderNumber) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("initData", initData);
      form.append("orderNumber", orderNumber);
      form.append("proof", file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "api/order/payment-proof-upload");
      xhr.timeout = 60000;
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        state.uploadPercent = Math.min(99, Math.round(event.loaded / event.total * 100));
        const bar = document.querySelector(".upload-progress");
        const label = document.querySelector(".upload-progress-text");
        if (bar) bar.value = state.uploadPercent;
        if (label) label.textContent = `Uploading… ${state.uploadPercent}%`;
      };
      xhr.onload = () => {
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          const error = new Error(data.error || "We couldn't upload your payment proof. Please try again.");
          error.data = data; error.status = xhr.status; reject(error);
        }
      };
      xhr.onerror = xhr.ontimeout = () => reject(new Error(
        "We couldn't upload your payment proof. Please try again."));
      xhr.send(form);
    });
  }
  async function submitProof() {
    if (!state.uploadFile || state.uploading || !state.order) return;
    state.uploading = true; state.uploadPercent = 0;
    notice(""); renderCheckout();
    try {
      const result = await uploadRequest(state.uploadFile, state.order.orderNumber);
      state.order = result.order;
      clearProofFile();
      state.checkout.step = "submitted";
      notice(""); renderCheckout();
    } catch (error) {
      if (error.status === 409 && error.data?.order?.proofSubmitted) {
        state.order = error.data.order;
        clearProofFile();
        state.checkout.step = "submitted";
        notice(""); renderCheckout();
      } else {
        notice(error.message || "We couldn't upload your payment proof. Please try again.", true);
        renderCheckout();
      }
    } finally { state.uploading = false; if (state.checkout.step === "upload") renderCheckout(); }
  }
  async function proofHandoff() {
    notice("Opening the bot for payment proof…");
    try {
      await api("order/payment-proof-handoff", { orderNumber: state.order.orderNumber });
      notice("Send your payment screenshot as a photo in the Metro Secure chat.");
      if (tg?.close) tg.close();
    } catch { notice("We couldn't open payment proof. Try again.", true); }
  }
  async function showOrder(orderNumber) {
    notice("");
    navigate("checkout");
    $("checkout-body").replaceChildren(card(paragraph("Loading order…")));
    try {
      state.order = (await api("order/status", { orderNumber })).order;
      state.checkout = { step: "status" }; renderCheckout();
    } catch { notice("We couldn't load this order. Try again.", true); }
  }
  async function refreshHistory() {
    const list = $("history-list");
    list.replaceChildren(card(paragraph("Loading orders…")));
    try {
      const { orders } = await api("orders");
      list.replaceChildren();
      if (!orders.length) { list.append(card(paragraph("No orders yet."))); return; }
      for (const order of orders) {
        list.append(card(title(order.plan), line("Order", order.orderNumber),
          line("Amount", money(order.amountMmk)), line("Date", date(order.createdAt)),
          line("Status", orderStatus[order.status] || "In progress"),
          action("View Order", () => showOrder(order.orderNumber))));
      }
    } catch { list.replaceChildren(card(paragraph("We couldn't load orders."),
      action("Try Again", refreshHistory))); }
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
    $(id).addEventListener("click", () => navigate("packages"));
  $("support-button").addEventListener("click", () => openFlow("support"));
  for (const id of ["view-usage-button", "vpn-usage-button"])
    $(id).addEventListener("click", () => navigate("usage"));
  $("view-packages-button").addEventListener("click", () => navigate("packages"));
  $("usage-back-button").addEventListener("click", () => navigate("vpn"));
  $("history-button").addEventListener("click", () => navigate("history"));
  $("history-back-button").addEventListener("click", () => navigate("packages"));
  $("checkout-back-button").addEventListener("click", () => {
    const step = state.checkout?.step;
    if (state.uploading) return;
    if (step === "upload") { state.checkout.step = "instructions"; renderCheckout(); }
    else if (step === "submitted") showOrder(state.order.orderNumber);
    else if (step === "instructions") loadMethods();
    else if (step === "methods" || step === "progress") showOrder(state.order.orderNumber);
    else navigate("packages");
  });
  $("refresh-button").addEventListener("click", () => load());
  $("retry-button").addEventListener("click", () => load(true));
  for (const button of document.querySelectorAll(".nav-button"))
    button.addEventListener("click", () => navigate(button.dataset.tab));
  load(true);
})();
