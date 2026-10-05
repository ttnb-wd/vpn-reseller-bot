const { describeHandlerFailure } = require("./safe-diagnostics");

function configuredPublicOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.origin : undefined;
  } catch { return undefined; }
}

function securityHeaders(_req, res, next) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  next();
}

function safeHttpError(error, req, res, _next) {
  // Never log request URLs, headers, bodies, parser bodies, or stacks.
  console.error("HTTP request failed.", describeHandlerFailure("http", error));
  if (res.headersSent || res.destroyed) return res.destroy();
  const status = error?.type === "entity.too.large" ? 413 :
    ["entity.parse.failed", "encoding.unsupported", "request.aborted", "request.size.invalid"].includes(error?.type) ||
    error instanceof URIError ? 400 : 500;
  res.set("Cache-Control", "private, no-store, max-age=0");
  const message = status === 413 ? "Request is too large." : status === 400 ? "Invalid request." : "Service is temporarily unavailable.";
  return req.path.includes("/api/") ? res.status(status).json({ error: message }) : res.status(status).type("text").send(message);
}

module.exports = { securityHeaders, safeHttpError, configuredPublicOrigin };
