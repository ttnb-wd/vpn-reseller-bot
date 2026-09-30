function milliseconds(value) {
  if (value == null) return NaN;
  if (value.epochMilliseconds !== undefined) return Number(value.epochMilliseconds);
  return new Date(value).getTime();
}

function effectiveSubscriptionState(subscription, now = Date.now()) {
  if (!subscription) return "REVOKED";
  if (subscription.revokedAt) return "REVOKED";
  const expiry = milliseconds(subscription.expiresAt);
  if (Number.isFinite(expiry) && expiry <= milliseconds(now)) return "EXPIRED";
  if (subscription.status === "DATA_LIMIT_REACHED") return "DATA_LIMIT_REACHED";
  if (subscription.status !== "ACTIVE" || !Number.isFinite(expiry)) return "REVOKED";
  const used = Number(subscription.dataUsedGb);
  const limit = Number(subscription.dataLimitGb);
  if (subscription.dataUsedGb != null && subscription.dataLimitGb != null &&
      Number.isFinite(used) && Number.isFinite(limit) && limit > 0 && used >= limit) {
    return "DATA_LIMIT_REACHED";
  }
  return "ACTIVE";
}

module.exports = { effectiveSubscriptionState };
