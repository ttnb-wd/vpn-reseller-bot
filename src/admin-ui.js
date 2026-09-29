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
  @media (max-width: 600px) { .shell { width: min(100% - 1.2rem, 1200px); } .panel { padding: .9rem; } .account { width: 100%; justify-content: space-between; } }
</style></head><body><div class="shell">
  <header class="top"><div><div class="brand">Metro Secure</div><h1>Metro Secure Admin</h1></div>
    <div class="account"><span>Logged in as: ${escapeHtml(email)}</span><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeHtml(formToken)}"><button type="submit">Logout</button></form></div></header>
  <nav aria-label="Admin sections">
    <a href="/admin"${section === "dashboard" ? ' class="current" aria-current="page"' : ""}>Dashboard</a>
    <a href="/admin/users"${section === "users" ? ' class="current" aria-current="page"' : ""}>Users</a>
    <span class="disabled">Orders</span><span class="disabled">Payments</span><span class="disabled">VPN Keys</span>
    <span class="disabled">Packages</span><span class="disabled">Usage</span><span class="disabled">Settings</span>
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

module.exports = { renderDashboard, renderUsers, renderUserDetail };
