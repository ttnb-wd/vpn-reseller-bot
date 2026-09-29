function safeDiagnosticCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? value : undefined;
}

function sanitizeDiagnosticMessage(value) {
  if (typeof value !== "string") return undefined;
  let message = value;
  const secrets = [process.env.OUTLINE_API_URL, process.env.OUTLINE_API_CERT_SHA256,
    process.env.BOT_TOKEN, process.env.DATABASE_URL, process.env.CONNECT_TOKEN_SECRET,
    process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD_HASH,
    process.env.ADMIN_SESSION_SECRET];
  try {
    const managementPath = new URL(process.env.OUTLINE_API_URL).pathname;
    if (managementPath.length > 1) secrets.push(managementPath);
  } catch {
    // Malformed configuration is reported by startup validation.
  }
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/(?:https?|ss|postgres(?:ql)?):\/\/[^\s"'<>)]*/gi, "[redacted URL]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/(?:password|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function diagnosticCategory(error) {
  const code = safeDiagnosticCode(error?.code) || safeDiagnosticCode(error?.cause?.code);
  if (code?.startsWith("CONTRACT.")) return "contract";
  if (code?.startsWith("ORM.") || code?.startsWith("RUNTIME.") ||
      code?.startsWith("DRIVER.") || /^[0-9A-Z]{5}$/.test(code || "")) return "database";
  if (code === "EACCES" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return "network";
  if (error?.name === "TelegramError") return "telegram";
  return "application";
}

function describeHandlerFailure(handler, error) {
  const cause = error?.cause;
  return {
    handler,
    category: diagnosticCategory(error),
    name: safeDiagnosticCode(error?.name),
    code: safeDiagnosticCode(error?.code) || safeDiagnosticCode(error?.cause?.code),
    message: sanitizeDiagnosticMessage(error?.message),
    cause: cause ? {
      name: safeDiagnosticCode(cause.name),
      code: safeDiagnosticCode(cause.code),
      message: sanitizeDiagnosticMessage(cause.message),
    } : undefined,
  };
}

function logHandlerFailure(handler, error) {
  console.error("Telegram handler failed:", describeHandlerFailure(handler, error));
}

module.exports = { safeDiagnosticCode, sanitizeDiagnosticMessage,
  describeHandlerFailure, logHandlerFailure };
