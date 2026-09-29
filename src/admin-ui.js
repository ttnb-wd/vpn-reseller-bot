const crypto = require("crypto");
const { Temporal } = require("@js-temporal/polyfill");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function text(value) {
  return value === null || value === undefined || value === "" ? "-" : escapeHtml(value);
}

function formatNumber(value, digits = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString("en-US", { maximumFractionDigits: digits }) : "-";
}

function formatGb(value) {
  return value === null || value === undefined ? "-" : `${formatNumber(value, 2)} GB`;
}

function keyId(value) {
  return typeof value === "string" && value.trim() && !/^ss:\/\//i.test(value.trim())
    ? escapeHtml(value.trim()) : "-";
}

function isLegacyMockKeyId(value) {
  return typeof value === "string" && value.startsWith("mock-");
}

function legacyMockBadge(value) {
  return isLegacyMockKeyId(value) ? badge("Legacy mock · review required", "inactive") : "";
}

function formatDate(value) {
  if (!value) return "-";
  const milliseconds = value.epochMilliseconds !== undefined
    ? Number(value.epochMilliseconds) : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(milliseconds));
}

function subscriptionState(subscription, now = Temporal.Now.instant()) {
  if (!subscription) return { label: "No subscription", className: "muted" };
  if (subscription.revokedAt) return { label: "Revoked", className: "inactive" };
  if (subscription.status !== "ACTIVE") {
    return { label: `Inactive (${subscription.status})`, className: "inactive" };
  }
  if (!subscription.expiresAt) return { label: "Inactive", className: "inactive" };
  const expires = subscription.expiresAt.epochMilliseconds !== undefined
    ? Number(subscription.expiresAt.epochMilliseconds) : new Date(subscription.expiresAt).getTime();
  if (expires <= Number(now.epochMilliseconds)) return { label: "Expired", className: "expired" };
  return { label: "Active", className: "active" };
}

function badge(label, className = "muted") {
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}

function field(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function customerName(customer) {
  return customer?.username ? `@${customer.username}`
    : customer?.firstName || customer?.telegramId || "-";
}

function duration(months) {
  const count = Number(months);
  return Number.isInteger(count) && count > 0
    ? `${formatNumber(count)} month${count === 1 ? "" : "s"}` : "-";
}

function proofAvailable(order) {
  return typeof order.paymentProof === "string" && Boolean(order.paymentProof.trim());
}

function listUrl(path, options) {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.status && (options.status !== "all" || path === "/admin/payments")) {
    params.set("status", options.status);
  }
  if (options.page > 1) params.set("page", String(options.page));
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

function pager(path, data, status) {
  const options = { q: data.q, status, page: data.page - 1 };
  const previous = data.page > 1
    ? `<a href="${escapeHtml(listUrl(path, options))}">← Previous</a>` : "<span>← Previous</span>";
  const next = data.page < data.totalPages
    ? `<a href="${escapeHtml(listUrl(path, { ...options, page: data.page + 1 }))}">Next →</a>`
    : "<span>Next →</span>";
  return `<div class="pager">${previous}<span>Page ${formatNumber(data.page)} of ${formatNumber(data.totalPages)}</span>${next}</div>`;
}

function renderLayout(res, title, email, section, formToken, content) {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  return res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Metro Secure Admin</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #123551, #091827 55%); color: #e9f4ff; }
  a { color: #7cddfb; }
  .shell { width: min(100% - 2rem, 1200px); margin: auto; padding: 1.5rem 0 3rem; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .brand { color: #70d8f8; font-size: .82rem; letter-spacing: .12em; text-transform: uppercase; font-weight: 800; }
  .top h1 { margin: .3rem 0 0; font-size: clamp(1.45rem, 4vw, 2rem); }
  .account { display: flex; align-items: center; flex-wrap: wrap; gap: .8rem; color: #bdd4e4; font-size: .9rem; }
  .account span { overflow-wrap: anywhere; }
  button, .button { border: 0; border-radius: 9px; padding: .65rem .9rem; background: #35b9e8; color: #062034; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
  button:hover, .button:hover { background: #70d8f8; }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid #70d8f8; outline-offset: 2px; }
  select:focus-visible { outline: 3px solid #70d8f8; outline-offset: 2px; }
  nav { display: flex; flex-wrap: wrap; gap: .45rem; margin: 1.5rem 0 2rem; }
  nav a, nav span { display: inline-block; border: 1px solid #2b5670; border-radius: 9px; padding: .65rem .8rem; text-decoration: none; color: #aec5d6; }
  nav a:hover, nav .current { color: #e9f4ff; border-color: #35b9e8; background: #173c53; }
  nav .disabled { opacity: .55; }
  h2 { font-size: 1.45rem; margin: 0 0 .35rem; }
  h3 { margin: 0 0 .8rem; font-size: 1.05rem; }
  .intro { margin: 0 0 1.4rem; color: #aec5d6; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8rem; margin: 1.2rem 0 2rem; }
  .stat, .panel, .user-card { background: #10283c; border: 1px solid #2b5670; border-radius: 15px; box-shadow: 0 12px 32px #0003; }
  .stat { padding: 1.1rem; }
  .stat span { display: block; color: #aec5d6; font-size: .88rem; }
  .stat strong { display: block; margin-top: .45rem; font-size: 1.75rem; font-variant-numeric: tabular-nums; }
  .panel { padding: 1.2rem; margin: 1.2rem 0; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 650px; }
  th, td { padding: .78rem .55rem; border-bottom: 1px solid #29475b; text-align: left; vertical-align: top; }
  th { color: #a9c7da; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  td { font-size: .9rem; }
  tr:last-child td { border-bottom: 0; }
  .muted-text { color: #a9c2d3; }
  .badge { display: inline-block; border: 1px solid #49677a; border-radius: 999px; padding: .2rem .55rem; font-size: .8rem; white-space: nowrap; }
  .badge.active { color: #a9f2cc; border-color: #368968; }
  .badge.expired { color: #ffd49c; border-color: #ac7540; }
  .badge.inactive { color: #f6bec4; border-color: #98505a; }
  .toolbar { display: flex; gap: .6rem; flex-wrap: wrap; align-items: end; margin: 1.1rem 0; }
  .toolbar label { display: block; color: #bdd4e4; font-size: .85rem; margin-bottom: .3rem; }
  .toolbar input { width: min(100%, 340px); padding: .7rem; border: 1px solid #51829c; border-radius: 9px; background: #081d2e; color: #fff; font: inherit; }
  .filters, .pager { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; }
  .filters a, .pager a, .pager span { border: 1px solid #2b5670; border-radius: 8px; padding: .5rem .7rem; text-decoration: none; }
  .filters .selected { background: #173c53; border-color: #35b9e8; color: #fff; }
  .pager { justify-content: space-between; margin: 1.4rem 0; }
  .users { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: .85rem; margin-top: 1rem; }
  .user-card { padding: 1rem; min-width: 0; }
  .user-head { display: flex; justify-content: space-between; align-items: start; gap: .6rem; flex-wrap: wrap; }
  .user-head h3 { margin: 0; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem 1rem; margin: 1rem 0 0; }
  dt { color: #9cb8ca; font-size: .75rem; margin-bottom: .2rem; }
  dd { margin: 0; overflow-wrap: anywhere; font-size: .9rem; }
  .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: .85rem; }
  .empty { color: #aec5d6; padding: 1rem 0; }
  .proof-preview { display: block; max-width: 100%; max-height: 360px; width: auto; height: auto; margin: .8rem 0; border: 1px solid #2b5670; border-radius: 10px; object-fit: contain; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; margin-top: 1rem; }
  .edit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 1rem; }
  .edit-grid label { display: block; color: #bdd4e4; margin-bottom: .35rem; }
  .edit-grid input, .edit-grid select { width: 100%; padding: .7rem; border: 1px solid #51829c; border-radius: 9px; background: #081d2e; color: #fff; font: inherit; }
  .notice { border: 1px solid #368968; border-radius: 9px; padding: .8rem; color: #a9f2cc; }
  .errors { border: 1px solid #98505a; border-radius: 9px; padding: .8rem 1.4rem; color: #f6bec4; }
  .usage-progress { width: 100%; height: .7rem; accent-color: #35b9e8; }
  .checklist { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: .45rem 1.2rem; padding-left: 1.4rem; }
  @media (max-width: 600px) { .shell { width: min(100% - 1.2rem, 1200px); } .panel { padding: .9rem; } .account { width: 100%; justify-content: space-between; } }
</style></head><body><div class="shell">
  <header class="top"><div><div class="brand">Metro Secure</div><h1>Metro Secure Admin</h1></div>
    <div class="account"><span>Logged in as: ${escapeHtml(email)}</span><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeHtml(formToken)}"><button type="submit">Logout</button></form></div></header>
  <nav aria-label="Admin sections">
    <a href="/admin"${section === "dashboard" ? ' class="current" aria-current="page"' : ""}>Dashboard</a>
    <a href="/admin/users"${section === "users" ? ' class="current" aria-current="page"' : ""}>Users</a>
    <a href="/admin/orders"${section === "orders" ? ' class="current" aria-current="page"' : ""}>Orders</a>
    <a href="/admin/payments"${section === "payments" ? ' class="current" aria-current="page"' : ""}>Payments</a>
    <a href="/admin/vpn-keys"${section === "vpn-keys" ? ' class="current" aria-current="page"' : ""}>VPN Keys</a>
    <a href="/admin/packages"${section === "packages" ? ' class="current" aria-current="page"' : ""}>Packages</a>
    <a href="/admin/usage"${section === "usage" ? ' class="current" aria-current="page"' : ""}>Usage</a>
    <a href="/admin/settings"${section === "settings" ? ' class="current" aria-current="page"' : ""}>Settings</a>
  </nav>
  <main>${content}</main>
</div></body></html>`);
}

function renderDashboard(res, email, formToken, data) {
  const cards = [
    ["Total Customers", formatNumber(data.totalCustomers)],
    ["Active Subscriptions", formatNumber(data.activeSubscriptions)],
    ["Expired Subscriptions", formatNumber(data.expiredSubscriptions)],
    ["Pending Payments", formatNumber(data.pendingPayments)],
    ["Total Orders", formatNumber(data.totalOrders)],
    ["Active VPN Keys", formatNumber(data.activeVpnKeys)],
    ["Total Data Used", formatGb(data.totalDataUsedGb)],
  ];
  const rows = data.recentOrders.map((order) => {
    const customer = order.customer;
    const displayName = customer?.username ? `@${customer.username}`
      : customer?.firstName || customer?.telegramId || "-";
    return `<tr><td>${text(order.orderNumber)}</td><td>${text(displayName)}</td>
      <td>${text(order.package?.name || order.plan)}</td><td>${formatNumber(order.price)} MMK</td>
      <td>${badge(order.status)}</td><td>${formatDate(order.createdAt)}</td></tr>`;
  }).join("");
  return renderLayout(res, "Dashboard", email, "dashboard", formToken, `
    <h2>Dashboard</h2><p class="intro">Current customers, subscriptions, and orders.</p>
    <div class="stats">${cards.map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
    <section class="panel"><h3>Recent orders</h3>${rows ? `<div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Customer</th><th>Package</th><th>Price</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<p class="empty">No orders yet.</p>'}</section>`);
}

function usersUrl(q, status, page) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/users${query ? `?${query}` : ""}`;
}

function renderUsers(res, email, formToken, data) {
  const filters = [["all", "All"], ["active", "Active"], ["expired", "Expired"], ["inactive", "Revoked / inactive"]];
  const cards = data.customers.map((customer) => {
    const sub = customer.subscription;
    const state = subscriptionState(sub, data.now);
    return `<article class="user-card">
      <div class="user-head"><h3><a href="/admin/users/${customer.id}">${text(customer.firstName || customer.username || customer.telegramId)}</a></h3>${badge(state.label, state.className)}</div>
      <dl>
        ${field("Customer ID", text(customer.id))}${field("Telegram ID", text(customer.telegramId))}
        ${field("Username", customer.username ? text(`@${customer.username}`) : "-")}${field("First name", text(customer.firstName))}
        ${field("Current package", text(sub?.package?.name || sub?.plan))}${field("VPN key ID", keyId(sub?.vpnKeyId))}
        ${field("Data used", formatGb(sub?.dataUsedGb))}${field("Data limit", formatGb(sub?.dataLimitGb))}
        ${field("Started at", formatDate(sub?.startedAt))}${field("Expires at", formatDate(sub?.expiresAt))}
        ${field("Order count", formatNumber(customer.orders))}${field("Created at", formatDate(customer.createdAt))}
      </dl></article>`;
  }).join("");
  const prev = data.page > 1 ? `<a href="${escapeHtml(usersUrl(data.q, data.status, data.page - 1))}">← Previous</a>` : "<span>← Previous</span>";
  const next = data.page < data.totalPages ? `<a href="${escapeHtml(usersUrl(data.q, data.status, data.page + 1))}">Next →</a>` : "<span>Next →</span>";
  return renderLayout(res, "Users", email, "users", formToken, `
    <h2>Users</h2><p class="intro">${formatNumber(data.count)} customer${data.count === 1 ? "" : "s"}</p>
    <form class="toolbar" method="get" action="/admin/users"><div><label for="search">Telegram ID, username, or name</label>
      <input id="search" name="q" value="${escapeHtml(data.q)}" maxlength="100" placeholder="Search customers"></div>
      ${data.status !== "all" ? `<input type="hidden" name="status" value="${escapeHtml(data.status)}">` : ""}<button type="submit">Search</button></form>
    <div class="filters" aria-label="Subscription status">${filters.map(([status, label]) =>
      `<a href="${escapeHtml(usersUrl(data.q, status, 1))}"${data.status === status ? ' class="selected" aria-current="page"' : ""}>${label}</a>`).join("")}</div>
    <div class="users">${cards || '<p class="empty">No customers match this search.</p>'}</div>
    <div class="pager">${prev}<span>Page ${formatNumber(data.page)} of ${formatNumber(data.totalPages)}</span>${next}</div>`);
}

function renderUserDetail(res, email, formToken, customer) {
  const sub = customer.subscription;
  const state = subscriptionState(sub);
  const orderRows = customer.orders.map((order) => `<tr>
    <td>${text(order.orderNumber)}</td><td>${text(order.package?.name || order.plan)}</td>
    <td>${formatNumber(order.price)} MMK</td><td>${text(order.paymentMethod)}</td>
    <td>${badge(order.status)}</td><td>${formatDate(order.createdAt)}</td></tr>`).join("");
  return renderLayout(res, "User detail", email, "users", formToken, `
    <p><a href="/admin/users">← Back to users</a></p><h2>Customer ${text(customer.id)}</h2>
    <div class="detail-grid">
      <section class="panel"><h3>Customer</h3><dl>
        ${field("Customer ID", text(customer.id))}${field("Telegram ID", text(customer.telegramId))}
        ${field("Username", customer.username ? text(`@${customer.username}`) : "-")}
        ${field("First name", text(customer.firstName))}${field("Created at", formatDate(customer.createdAt))}
      </dl></section>
      <section class="panel"><h3>Subscription</h3><dl>
        ${field("Package", text(sub?.package?.name || sub?.plan))}${field("Status", badge(state.label, state.className))}
        ${field("VPN key ID", keyId(sub?.vpnKeyId))}${field("Data used", formatGb(sub?.dataUsedGb))}
        ${field("Data limit", formatGb(sub?.dataLimitGb))}${field("Started at", formatDate(sub?.startedAt))}
        ${field("Expires at", formatDate(sub?.expiresAt))}${field("Revoked at", formatDate(sub?.revokedAt))}
      </dl></section>
    </div>
    <section class="panel"><h3>Recent orders</h3>${orderRows ? `<div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Package</th><th>Price</th><th>Payment method</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>${orderRows}</tbody></table></div>` : '<p class="empty">No orders yet.</p>'}</section>`);
}

function renderOrders(res, email, formToken, data) {
  const filters = [
    ["all", "All"], ["PENDING_PAYMENT", "Pending"], ["PROCESSING", "Processing"],
    ["PAID", "Paid"], ["PAYMENT_REJECTED", "Rejected"], ["CANCELLED", "Cancelled"],
  ];
  const cards = data.orders.map((order) => `<article class="user-card">
    <div class="user-head"><h3><a href="/admin/orders/${order.id}">${text(order.orderNumber)}</a></h3>${badge(order.status)}${legacyMockBadge(order.vpnKeyId)}</div>
    <dl>
      ${field("Customer", text(customerName(order.customer)))}${field("Telegram ID", text(order.customer?.telegramId))}
      ${field("Package", text(order.package?.name || order.plan))}${field("Duration", duration(order.durationMonths))}
      ${field("Price", `${formatNumber(order.price)} MMK`)}${field("Payment method", text(order.paymentMethod))}
      ${field("Payment reference", text(order.paymentReference))}${field("Created at", formatDate(order.createdAt))}
      ${field("Paid at", formatDate(order.paidAt))}${field("Started at", formatDate(order.startedAt))}
      ${field("Expires at", formatDate(order.expiresAt))}
    </dl></article>`).join("");
  return renderLayout(res, "Orders", email, "orders", formToken, `
    <h2>Orders</h2><p class="intro">${formatNumber(data.count)} order${data.count === 1 ? "" : "s"}</p>
    <form class="toolbar" method="get" action="/admin/orders"><div><label for="order-search">Order number, Telegram ID, or username</label>
      <input id="order-search" name="q" value="${escapeHtml(data.q)}" maxlength="100" placeholder="Search orders"></div>
      ${data.status !== "all" ? `<input type="hidden" name="status" value="${escapeHtml(data.status)}">` : ""}<button type="submit">Search</button></form>
    <div class="filters" aria-label="Order status">${filters.map(([status, label]) =>
      `<a href="${escapeHtml(listUrl("/admin/orders", { q: data.q, status, page: 1 }))}"${data.status === status ? ' class="selected" aria-current="page"' : ""}>${label}</a>`).join("")}</div>
    <div class="users">${cards || '<p class="empty">No orders match this search.</p>'}</div>
    ${pager("/admin/orders", data, data.status)}`);
}

function renderOrderDetail(res, email, formToken, order) {
  const proofPath = `/admin/payment-proof/${order.id}`;
  const proof = proofAvailable(order)
    ? `<img class="proof-preview" src="${proofPath}" alt="Payment proof for order ${escapeHtml(order.orderNumber)}" loading="lazy">
       <div class="actions"><a class="button" href="${proofPath}" target="_blank" rel="noopener noreferrer">View Full Slip</a></div>`
    : '<p class="empty">No payment proof uploaded.</p>';
  return renderLayout(res, "Order detail", email, "orders", formToken, `
    <p><a href="/admin/orders">← Back to orders</a></p><h2>Order ${text(order.orderNumber)}</h2>
    <div class="detail-grid">
      <section class="panel"><h3>Customer</h3><dl>
        ${field("Telegram ID", text(order.customer?.telegramId))}
        ${field("Username", order.customer?.username ? text(`@${order.customer.username}`) : "-")}
        ${field("First name", text(order.customer?.firstName))}
      </dl></section>
      <section class="panel"><h3>Order</h3><dl>
        ${field("Order number", text(order.orderNumber))}${field("Package", text(order.package?.name || order.plan))}
        ${field("Duration", duration(order.durationMonths))}${field("Price", `${formatNumber(order.price)} MMK`)}
        ${field("Status", badge(order.status))}${field("Payment method", text(order.paymentMethod))}
        ${field("Payment reference", text(order.paymentReference))}${field("Created at", formatDate(order.createdAt))}
        ${field("Paid at", formatDate(order.paidAt))}${field("Started at", formatDate(order.startedAt))}
        ${field("Expires at", formatDate(order.expiresAt))}${field("VPN key ID", `${keyId(order.vpnKeyId)} ${legacyMockBadge(order.vpnKeyId)}`)}
      </dl></section>
    </div>
    <section class="panel"><h3>Payment Proof</h3>${proof}</section>`);
}

function renderPayments(res, email, formToken, data) {
  const filters = [["pending", "Pending"], ["paid", "Approved / Paid"], ["rejected", "Rejected"], ["all", "All"]];
  const cards = data.orders.map((order) => `<article class="user-card">
    <div class="user-head"><h3><a href="/admin/orders/${order.id}">${text(order.orderNumber)}</a></h3>${badge(order.status)}</div>
    <dl>
      ${field("Customer", text(customerName(order.customer)))}${field("Telegram ID", text(order.customer?.telegramId))}
      ${field("Package", text(order.package?.name || order.plan))}${field("Amount", `${formatNumber(order.price)} MMK`)}
      ${field("Payment method", text(order.paymentMethod))}${field("Payment reference", text(order.paymentReference))}
      ${field("Paid at", formatDate(order.paidAt))}${field("Proof available", proofAvailable(order) ? "Yes" : "No")}
    </dl><div class="actions"><a href="/admin/orders/${order.id}">View order</a>
      ${proofAvailable(order) ? `<a href="/admin/payment-proof/${order.id}" target="_blank" rel="noopener noreferrer">View slip</a>` : ""}</div>
  </article>`).join("");
  return renderLayout(res, "Payments", email, "payments", formToken, `
    <h2>Payments</h2><p class="intro">${formatNumber(data.count)} payment-related order${data.count === 1 ? "" : "s"}</p>
    <div class="filters" aria-label="Payment status">${filters.map(([status, label]) =>
      `<a href="${escapeHtml(listUrl("/admin/payments", { status, page: 1 }))}"${data.filter === status ? ' class="selected" aria-current="page"' : ""}>${label}</a>`).join("")}</div>
    <div class="users">${cards || '<p class="empty">No payments in this view.</p>'}</div>
    ${pager("/admin/payments", data, data.filter)}`);
}

function vpnKeyState(subscription, now) {
  if (isLegacyMockKeyId(subscription.vpnKeyId)) {
    return { label: "Legacy mock · review required", className: "inactive" };
  }
  if (subscription.revokedAt) return { label: "Revoked", className: "inactive" };
  if (!subscription.vpnKeyId) return { label: "Missing", className: "inactive" };
  return subscriptionState(subscription, now);
}

function renderVpnKeys(res, email, formToken, data) {
  const filters = [["all", "All"], ["active", "Active"], ["expired", "Expired"],
    ["revoked", "Revoked"], ["missing", "Missing"]];
  const cards = data.subscriptions.map((subscription) => {
    const customer = subscription.customer;
    const state = vpnKeyState(subscription, data.now);
    return `<article class="user-card"><div class="user-head"><h3>${keyId(subscription.vpnKeyId)}</h3>${badge(state.label, state.className)}</div>
      <dl>${field("Customer", text(customerName(customer)))}${field("Telegram ID", text(customer?.telegramId))}
        ${field("Username", customer?.username ? text(`@${customer.username}`) : "-")}
        ${field("First name", text(customer?.firstName))}
        ${field("Package", text(subscription.package?.name || subscription.plan))}
        ${field("Subscription status", badge(subscription.status))}
        ${isLegacyMockKeyId(subscription.vpnKeyId)
          ? field("Subscription entitlement", badge(subscriptionState(subscription, data.now).label,
            subscriptionState(subscription, data.now).className)) : ""}
        ${field("Data used", formatGb(subscription.dataUsedGb))}${field("Data limit", formatGb(subscription.dataLimitGb))}
        ${field("Started at", formatDate(subscription.startedAt))}${field("Expires at", formatDate(subscription.expiresAt))}
        ${field("Revoked at", formatDate(subscription.revokedAt))}
        ${field("Key created at", formatDate(subscription.vpnKeyCreatedAt))}
      </dl></article>`;
  }).join("");
  return renderLayout(res, "VPN Keys", email, "vpn-keys", formToken, `
    <h2>VPN Keys</h2><p class="intro">${formatNumber(data.count)} subscription${data.count === 1 ? "" : "s"} · Read-only database view</p>
    <form class="toolbar" method="get" action="/admin/vpn-keys"><div><label for="key-search">Key ID, Telegram ID, username, or first name</label>
      <input id="key-search" name="q" value="${escapeHtml(data.q)}" maxlength="100" placeholder="Search VPN keys"></div>
      ${data.status !== "all" ? `<input type="hidden" name="status" value="${escapeHtml(data.status)}">` : ""}<button type="submit">Search</button></form>
    <div class="filters" aria-label="VPN key status">${filters.map(([status, label]) =>
      `<a href="${escapeHtml(listUrl("/admin/vpn-keys", { q: data.q, status, page: 1 }))}"${data.status === status ? ' class="selected" aria-current="page"' : ""}>${label}</a>`).join("")}</div>
    <div class="users">${cards || '<p class="empty">No subscriptions match this search.</p>'}</div>
    ${pager("/admin/vpn-keys", data, data.status)}`);
}

function renderPackages(res, email, formToken, data, saved = false) {
  const cards = data.packages.map((pkg) => `<article class="user-card">
    <div class="user-head"><h3>${text(pkg.name)}</h3>${badge(pkg.active ? "Active" : "Inactive", pkg.active ? "active" : "inactive")}</div>
    <dl>${field("Package ID", text(pkg.id))}${field("Data limit", formatGb(pkg.dataLimitGb))}
      ${field("Duration", `${formatNumber(pkg.durationDays)} days`)}${field("Price", formatNumber(pkg.priceMmk, 2))}
      ${field("Sort order", formatNumber(pkg.sortOrder))}${field("Created at", formatDate(pkg.createdAt))}
      ${field("Updated at", formatDate(pkg.updatedAt))}
    </dl><div class="actions"><a href="/admin/packages/${pkg.id}/edit">Edit package</a></div></article>`).join("");
  return renderLayout(res, "Packages", email, "packages", formToken, `
    <h2>Packages</h2><p class="intro">${formatNumber(data.count)} package${data.count === 1 ? "" : "s"}</p>
    ${saved ? '<p class="notice" role="status">Package changes saved.</p>' : ""}
    <div class="users">${cards || '<p class="empty">No packages found.</p>'}</div>
    ${pager("/admin/packages", data, "all")}`);
}

function renderPackageEdit(res, email, formToken, pkg, errors = [], entered = pkg) {
  const input = (name) => escapeHtml(entered?.[name] ?? "");
  const active = String(entered?.active);
  return renderLayout(res, "Edit package", email, "packages", formToken, `
    <p><a href="/admin/packages">← Back to packages</a></p><h2>Edit package ${text(pkg.name)}</h2>
    <p class="intro">Changes to this package are used for future purchases. Existing order and subscription records are not rewritten.</p>
    ${errors.length ? `<ul class="errors" role="alert">${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
    <section class="panel"><form method="post" action="/admin/packages/${pkg.id}/edit">
      <input type="hidden" name="_csrf" value="${escapeHtml(formToken)}">
      <div class="edit-grid">
        <div><label for="name">Name</label><input id="name" name="name" value="${input("name")}" maxlength="100" required></div>
        <div><label for="dataLimitGb">Data limit (GB)</label><input id="dataLimitGb" name="dataLimitGb" value="${input("dataLimitGb")}" inputmode="decimal" required></div>
        <div><label for="durationDays">Duration (days)</label><input id="durationDays" name="durationDays" value="${input("durationDays")}" inputmode="numeric" required></div>
        <div><label for="priceMmk">Price</label><input id="priceMmk" name="priceMmk" value="${input("priceMmk")}" inputmode="decimal" required></div>
        <div><label for="sortOrder">Sort order</label><input id="sortOrder" name="sortOrder" value="${input("sortOrder")}" inputmode="numeric" required></div>
        <div><label for="active">Availability</label><select id="active" name="active" required>
          <option value="true"${active === "true" ? " selected" : ""}>Active</option>
          <option value="false"${active === "false" ? " selected" : ""}>Inactive</option>
        </select></div>
      </div><div class="actions"><button type="submit">Save Changes</button></div>
    </form></section>`);
}

function renderUsage(res, email, formToken, data, usageMetrics) {
  const summary = data.summary;
  const cards = [
    ["Total Data Used", formatGb(summary.totalDataUsedGb)],
    ["Total Data Limit", formatGb(summary.totalDataLimitGb)],
    ["Active Subscriptions", formatNumber(summary.activeSubscriptions)],
    ["Customers Above 50%", formatNumber(summary.above50)],
    ["Customers Above 80%", formatNumber(summary.above80)],
    ["Customers At / Above Limit", formatNumber(summary.atLimit)],
  ];
  const filters = [["all", "All"], ["active", "Active"], ["expired", "Expired"],
    ["above50", ">50%"], ["above80", ">80%"], ["atLimit", "At Limit"]];
  const rows = data.subscriptions.map((subscription) => {
    const metrics = usageMetrics(subscription);
    const percent = metrics.percentage === null ? "N/A" : metrics.percentage > 100
      ? `${formatNumber(metrics.percentage, 1)}% (100%+)`
      : `${formatNumber(metrics.percentage, 1)}%`;
    const barValue = metrics.percentage === null ? null : Math.min(100, metrics.percentage);
    const customer = subscription.customer;
    const usageState = isLegacyMockKeyId(subscription.vpnKeyId)
      ? "Legacy mock · sync skipped"
      : !subscription.vpnKeyId ? "No key" : "Stored snapshot · sync time not recorded";
    return `<article class="user-card"><div class="user-head"><h3>${text(customerName(customer))}</h3>${badge(subscriptionState(subscription, data.now).label,
      subscriptionState(subscription, data.now).className)}</div>
      <dl>${field("Telegram ID", text(customer?.telegramId))}
        ${field("Username", customer?.username ? text(`@${customer.username}`) : "-")}
        ${field("Package", text(subscription.package?.name || subscription.plan))}
        ${field("VPN key ID", `${keyId(subscription.vpnKeyId)} ${legacyMockBadge(subscription.vpnKeyId)}`)}
        ${field("Data used", formatGb(metrics.used))}${field("Data limit", formatGb(metrics.limit))}
        ${field("Usage", text(percent))}${field("Remaining data", formatGb(metrics.remaining))}
        ${field("Subscription status", badge(subscription.status))}${field("Expiry", formatDate(subscription.expiresAt))}
        ${field("Last known usage state", text(usageState))}
      </dl>${barValue === null ? "" : `<progress class="usage-progress" value="${barValue}" max="100" aria-label="Usage ${escapeHtml(percent)}"></progress>`}
    </article>`;
  }).join("");
  return renderLayout(res, "Usage", email, "usage", formToken, `
    <h2>Usage</h2><p class="intro">Stored subscription usage. Sync time is not recorded in the current schema.</p>
    <div class="stats">${cards.map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
    <form class="toolbar" method="get" action="/admin/usage"><div><label for="usage-search">Telegram ID, username, first name, or key ID</label>
      <input id="usage-search" name="q" value="${escapeHtml(data.q)}" maxlength="100" placeholder="Search usage"></div>
      ${data.filter !== "all" ? `<input type="hidden" name="status" value="${escapeHtml(data.filter)}">` : ""}<button type="submit">Search</button></form>
    <div class="filters" aria-label="Usage filters">${filters.map(([status, label]) =>
      `<a href="${escapeHtml(listUrl("/admin/usage", { q: data.q, status, page: 1 }))}"${data.filter === status ? ' class="selected" aria-current="page"' : ""}>${label}</a>`).join("")}</div>
    <p class="intro">${formatNumber(data.count)} matching subscription${data.count === 1 ? "" : "s"}</p>
    <div class="users">${rows || '<p class="empty">No usage records match this view.</p>'}</div>
    ${pager("/admin/usage", data, data.filter)}`);
}

function renderSettings(res, email, formToken, settings) {
  const indicator = (enabled, positive = "Configured", negative = "Missing") =>
    badge(enabled ? positive : negative, enabled ? "active" : "inactive");
  const rows = (items) => `<dl>${items.map(([label, value]) => field(label, value)).join("")}</dl>`;
  const checks = [
    ["Database connected", settings.databaseConnected, "Connected", "Unavailable"],
    ["Outline connection configured", settings.outlineConfigured && settings.fingerprintConfigured],
    ["Telegram bot configured", settings.telegramConfigured],
    ["Admin authentication configured", settings.adminAuthConfigured],
    ["Usage worker enabled", settings.usageWorkerEnabled, "Enabled", "Disabled"],
    ["Public base URL configured", Boolean(settings.publicHostname)],
    ["Required production env vars present", settings.requiredEnvPresent],
  ];
  const cleanup = [
    "Remove test customers", "Remove test orders", "Review legacy mock-* records",
    "Review orphan Outline keys", "Rotate previously exposed secrets",
    "Verify only one Telegram polling instance", "Verify production DB backup",
    "Verify package prices", "Verify admin access", "Verify payment slip access",
    "Verify Outline key creation", "Verify renewal", "Verify expiry and revocation",
    "Verify usage sync", "Verify Render environment", "Verify .env is not committed",
    "Run final launch smoke test",
  ];
  return renderLayout(res, "Settings", email, "settings", formToken, `
    <h2>Settings</h2><p class="intro">Read-only configuration and operational status. Secret values are never shown.</p>
    <div class="detail-grid">
      <section class="panel"><h3>Application</h3>${rows([
        ["Environment", text(settings.environment)], ["Node environment", text(settings.nodeEnvironment)],
        ["Public hostname", text(settings.publicHostname)],
        ["Render deployment", indicator(settings.renderDeployment, "Detected", "Not detected")],
      ])}</section>
      <section class="panel"><h3>Telegram</h3>${rows([
        ["Bot", indicator(settings.telegramConfigured)], ["Telegram admin ID", indicator(settings.telegramAdminConfigured)],
      ])}</section>
      <section class="panel"><h3>Outline</h3>${rows([
        ["API", indicator(settings.outlineConfigured)], ["Certificate fingerprint", indicator(settings.fingerprintConfigured)],
        ["Mode", "Real Outline only"], ["Last connection status", "Not tracked"],
      ])}</section>
      <section class="panel"><h3>Database</h3>${rows([
        ["Configuration", indicator(settings.databaseConfigured)],
        ["Connection", indicator(settings.databaseConnected, "Connected", "Unavailable")],
      ])}</section>
      <section class="panel"><h3>Workers</h3>${rows([
        ["Usage sync interval", `${formatNumber(settings.usageIntervalMinutes)} minutes`],
        ["Usage worker", indicator(settings.usageWorkerEnabled, "Enabled", "Disabled")],
        ["Usage sync now", indicator(settings.usageSyncRunning, "Running", "Idle")],
        ["PROCESSING recovery timeout", `${formatNumber(settings.processingRecoveryMinutes)} minutes`],
      ])}</section>
      <section class="panel"><h3>Admin</h3>${rows([
        ["Email", text(settings.adminEmail)], ["Session timeout", `${formatNumber(settings.sessionTimeoutMinutes)} minutes`],
        ["Authentication", indicator(settings.adminAuthConfigured, "Enabled", "Disabled")],
      ])}</section>
    </div>
    <section class="panel"><h3>Production health</h3>${rows(checks.map(([label, ok, yes, no]) =>
      [label, indicator(ok, yes || "Configured", no || "Missing")]))}</section>
    <section class="panel"><h3>Final cleanup checklist for later</h3><p class="intro">Review these before launch. This page performs no cleanup.</p>
      <ul class="checklist">${cleanup.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`);
}

module.exports = {
  renderDashboard, renderUsers, renderUserDetail,
  renderOrders, renderOrderDetail, renderPayments,
  renderVpnKeys, renderPackages, renderPackageEdit,
  renderUsage, renderSettings,
};
