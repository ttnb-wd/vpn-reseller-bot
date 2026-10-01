const MAX_CUSTOMER_NAME_LENGTH = 64;

function cleanCustomerName(value) {
  if (typeof value !== "string") return "";
  // Remove controls, invisible formatting, line separators and malformed UTF-16.
  // Count Unicode code points so truncation never leaves half a surrogate pair.
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}@]/gu, "").trim();
  return Array.from(clean).slice(0, MAX_CUSTOMER_NAME_LENGTH).join("").trim();
}

function outlineProfileName(customer = {}) {
  const name = cleanCustomerName(customer?.username) ||
    cleanCustomerName(customer?.firstName) || "Customer";
  return `Metro Secure | ${name}`;
}

module.exports = { outlineProfileName, MAX_CUSTOMER_NAME_LENGTH };
