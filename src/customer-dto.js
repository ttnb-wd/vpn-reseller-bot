// Only scalar, explicitly approved fields may cross the customer boundary.
function scalarFields(value, fields) {
  return Object.fromEntries(fields.map(field => {
    const item = value?.[field];
    return [field, typeof item === "string" || typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) ? item : null];
  }));
}

function redactConnectionText(value) {
  return String(value || "").replace(/(?:ss|ssconf):\/\/[^\s]+/gi, "[VPN key hidden]")
    .replace(/\/vpn\/config\/[^\s]+/gi, "/vpn/config/[hidden]");
}

function supportMessage(message) {
  if (!message) return null;
  const result = scalarFields(message, ["key", "sender", "text", "createdAt"]);
  result.text = redactConnectionText(result.text);
  return result;
}

function supportConversation(result) {
  return { messages: Array.isArray(result?.messages) ? result.messages.slice(-100).map(supportMessage) : [] };
}

function paymentMethods(methods) {
  return Array.isArray(methods) ? methods.map(method => scalarFields(method,
    ["code", "name", "accountName", "accountNumber"])) : [];
}

module.exports = { scalarFields, redactConnectionText, supportMessage, supportConversation, paymentMethods };
