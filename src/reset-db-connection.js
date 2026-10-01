function databaseConnection(databaseUrl, source) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error("DATABASE_URL is invalid."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
      !url.username || !url.pathname || url.pathname === "/") {
    throw new Error("DATABASE_URL must be a PostgreSQL URL with a host, user, and database.");
  }
  const sslMode = url.searchParams.get("sslmode") || "verify-full";
  const internal = /^dpg-[a-z0-9]+-a(?:\.render\.internal)?$/.test(url.hostname);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!internal && !local && (sslMode === "disable" || sslMode === "prefer" ||
      (sslMode !== "verify-full" && url.searchParams.get("uselibpqcompat") === "true"))) {
    throw new Error("External database requires verified TLS.");
  }
  if (!["disable", "prefer", "require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error("DATABASE_URL has an unsupported sslmode.");
  }
  const config = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectionTimeoutMillis: 10000,
    ssl: sslMode === "disable" && local ? false : { rejectUnauthorized: !internal },
  };
  const options = url.searchParams.get("options");
  if (options) config.options = options;
  const diagnostics = {
    source,
    hostname: url.hostname,
    database: config.database,
    usernamePresent: Boolean(config.user),
    sslEnabled: config.ssl !== false,
    localhost: ["localhost", "127.0.0.1", "::1"].includes(url.hostname),
    renderHost: /(?:^|\.)render\.com$|(?:^|\.)render\.internal$/.test(url.hostname),
  };
  return { config, diagnostics };
}

function safeConnectionFailure(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (/no pg_hba\.conf entry/i.test(message)) return "access rule rejected connection";
  if (/password authentication failed/i.test(message)) return "password rejected";
  if (/role .* does not exist/i.test(message)) return "database role unavailable";
  if (/database .* does not exist/i.test(message)) return "database unavailable";
  if (/client certificate/i.test(message)) return "client certificate required";
  if (/SSL.*(?:required|off)/i.test(message)) return "SSL policy mismatch";
  if (/endpoint.*(?:missing|not specified|unknown|invalid)/i.test(message)) return "endpoint routing rejected";
  return "authentication or access rejected";
}

module.exports = { databaseConnection, safeConnectionFailure };
