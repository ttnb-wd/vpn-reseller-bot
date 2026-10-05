function safeDiagnosticCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? value : undefined;
}

function safeErrorCode(value) {
  if (typeof value !== "string") return undefined;
  const fixed = new Set(["EACCES", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
    "ERR_BAD_RESPONSE", "ERR_BAD_REQUEST", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "OUTLINE_CERT_UNAVAILABLE", "OUTLINE_CERT_MISMATCH"]);
  return fixed.has(value) || /^[0-9A-Z]{5}$/.test(value) ||
    /^(?:CONTRACT|ORM|RUNTIME|DRIVER)\.[A-Z][A-Z0-9_.]{0,47}$/.test(value) ? value : undefined;
}

function safeErrorName(value) {
  return ["Error", "TypeError", "RangeError", "URIError", "TelegramError", "AxiosError", "SyntaxError", "StructuredError"].includes(value) ? value : "Error";
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
    .replace(/(?:https?|ssconf|ss|postgres(?:ql)?):\/\/[^\s"'<>)]*/gi, "[redacted URL]")
    .replace(/\/vpn\/config\/[^\s"'<>)]*/gi, "/vpn/config/[redacted]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/(?:password|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[redacted credential]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function diagnosticCategory(error) {
  const code = safeErrorCode(error?.code) || safeErrorCode(error?.cause?.code);
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
    name: safeErrorName(error?.name),
    code: safeErrorCode(error?.code) || safeErrorCode(error?.cause?.code),
    // Free-form provider/parser messages can contain unlabelled customer
    // secrets, SQL values and request bodies. Log codes and categories only.
    cause: cause ? {
      name: safeErrorName(cause.name),
      code: safeErrorCode(cause.code),
    } : undefined,
  };
}

function logHandlerFailure(handler, error) {
  console.error("Telegram handler failed:", describeHandlerFailure(handler, error));
}

module.exports = { safeDiagnosticCode, safeErrorCode, safeErrorName, sanitizeDiagnosticMessage,
  describeHandlerFailure, logHandlerFailure };
