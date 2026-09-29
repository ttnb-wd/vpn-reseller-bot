const axios = require("axios");
const https = require("https");
const tls = require("tls");
const net = require("net");
const crypto = require("crypto");

function validateOutlineConfig() {
  const apiUrl = process.env.OUTLINE_API_URL;
  const rawFingerprint = process.env.OUTLINE_API_CERT_SHA256;

  if (!apiUrl) {
    throw new Error("OUTLINE_API_URL is required in production.");
  }
  if (!rawFingerprint) {
    throw new Error("OUTLINE_API_CERT_SHA256 is required in production.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error("OUTLINE_API_URL must be a valid HTTPS URL.");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error("OUTLINE_API_URL must use HTTPS.");
  }

  const fingerprint = rawFingerprint.replace(/[:\s]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(fingerprint)) {
    throw new Error("OUTLINE_API_CERT_SHA256 must be a SHA-256 fingerprint.");
  }

  return { apiUrl, hostname: parsedUrl.hostname.replace(/^\[|\]$/g, ""), fingerprint };
}

let outlineConfig;

function getOutlineConfig() {
  if (!outlineConfig) outlineConfig = validateOutlineConfig();
  return outlineConfig;
}

function certificateError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createOutlineHttpsAgent() {
  const config = getOutlineConfig();
  const agent = new https.Agent({ maxCachedSessions: 0 });

  // Outline normally uses a self-signed certificate. Node does not call
  // checkServerIdentity for a certificate that fails CA validation, so hold
  // the socket until its certificate has matched the configured fingerprint.
  agent.createConnection = (options, callback) => {
    const servername = options.servername ??
      (net.isIP(config.hostname) ? "" : config.hostname);
    const socket = tls.connect({
      ...options,
      servername,
      rejectUnauthorized: false,
    });
    let completed = false;

    const finish = (error) => {
      if (completed) return;
      completed = true;
      if (error) {
        socket.destroy();
        callback(error);
      } else {
        callback(null, socket);
      }
    };

    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      if (!certificate?.raw) {
        finish(certificateError(
          "Outline API certificate is unavailable.",
          "OUTLINE_CERT_UNAVAILABLE"
        ));
        return;
      }

      const actualFingerprint = crypto
        .createHash("sha256")
        .update(certificate.raw)
        .digest("hex")
        .toUpperCase();

      if (actualFingerprint !== config.fingerprint) {
        finish(certificateError(
          "Outline API certificate fingerprint mismatch.",
          "OUTLINE_CERT_MISMATCH"
        ));
        return;
      }

      finish();
    });
    socket.once("error", finish);
  };

  return agent;
}

function getOutlineClient() {
  const config = getOutlineConfig();
  return axios.create({
    baseURL: config.apiUrl,
    timeout: 10000,
    maxRedirects: 0,
    httpsAgent: createOutlineHttpsAgent(),
    headers: { "Content-Type": "application/json" },
  });
}

function assertRealKeyId(keyId) {
  if (!keyId || String(keyId).startsWith("mock-")) {
    throw new Error("A real Outline access key ID is required.");
  }
}

function isAccessKeyNotFoundError(error) {
  const status = error?.response?.status;
  const code = error?.response?.data?.code;
  const message = error?.response?.data?.message;

  return status === 404 &&
    (code === "NotFound" || code === "NotFoundError") &&
    typeof message === "string" &&
    /(?:no access key found|access key.*(?:not found|does not exist))/i.test(message);
}

async function testOutlineConnection() {
  const response = await getOutlineClient().get("/server");
  return response.data;
}

async function getAllAccessKeyUsage() {
  // The management API exposes one transfer snapshot for all access keys.
  const response = await getOutlineClient().get("/metrics/transfer");
  const usage = response.data?.bytesTransferredByUserId;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new Error("Outline API returned invalid transfer metrics.");
  }
  return usage;
}

async function getExistingAccessKeyIds() {
  // A key with no traffic can be absent from the metrics map. Check that it
  // still exists before recording zero usage. Never return or log access URLs.
  const response = await getOutlineClient().get("/access-keys");
  const keys = response.data?.accessKeys;
  if (!Array.isArray(keys)) {
    throw new Error("Outline API returned an invalid access key list.");
  }
  return new Set(keys.filter((key) => typeof key?.id === "string").map((key) => key.id));
}

function summarizeAccessKeyAudit(keys, usage, candidateIds, storedAccessUrls) {
  if (!Array.isArray(keys) || !usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new Error("Outline audit data is invalid.");
  }
  const storedUrls = Array.isArray(storedAccessUrls)
    ? storedAccessUrls.filter((url) => typeof url === "string" && url.startsWith("ss://")) : [];
  return candidateIds.map((id) => {
    const key = keys.find((entry) => entry?.id === id);
    if (!key) return { id, exists: false };
    const limit = key.dataLimit?.bytes;
    const usageBytes = Object.hasOwn(usage, id) ? usage[id] : null;
    return {
      id,
      exists: true,
      name: typeof key.name === "string" && !key.name.includes("ss://")
        ? key.name.slice(0, 120) : null,
      dataLimitBytes: Number.isSafeInteger(limit) && limit >= 0 ? limit : null,
      usageBytes: Number.isSafeInteger(usageBytes) && usageBytes >= 0 ? usageBytes : null,
      usageReported: Object.hasOwn(usage, id),
      createdAt: typeof key.createdAt === "string" ? key.createdAt : null,
      storedAccessUrlMatches: typeof key.accessUrl === "string" &&
        storedUrls.some((url) => url === key.accessUrl),
    };
  });
}

async function getAccessKeyAuditMetadata(candidateIds, storedAccessUrls = []) {
  const [keysResponse, usage] = await Promise.all([
    getOutlineClient().get("/access-keys"),
    getAllAccessKeyUsage(),
  ]);
  return summarizeAccessKeyAudit(
    keysResponse.data?.accessKeys, usage, candidateIds, storedAccessUrls,
  );
}

async function createAccessKey() {
  const response = await getOutlineClient().post("/access-keys");
  const accessKey = response.data;

  if (!accessKey?.id || !accessKey?.accessUrl ||
      !String(accessKey.accessUrl).startsWith("ss://")) {
    throw new Error("Outline API returned an invalid access key.");
  }

  console.log("Real Outline access key created.");
  return { id: accessKey.id, accessUrl: accessKey.accessUrl };
}

function provisioningKeyId(order) {
  if (!Number.isSafeInteger(order?.id) || order.id <= 0 ||
      typeof order.orderNumber !== "string" || !/^VPN-[A-Za-z0-9_-]{8,100}$/.test(order.orderNumber)) {
    throw new Error("Order has no stable provisioning identity.");
  }
  return `ms-o-${crypto.createHash("sha256").update(`${order.id}:${order.orderNumber}`).digest("hex").slice(0, 40)}`;
}

async function getAccessKeyById(keyId, client = getOutlineClient()) {
  if (typeof keyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) {
    throw new Error("Invalid Outline key ID.");
  }
  let response;
  try {
    response = await client.get(`/access-keys/${encodeURIComponent(keyId)}`);
  } catch (error) {
    if (isAccessKeyNotFoundError(error)) return null;
    throw error;
  }
  const key = response.data;
  if (key?.id !== keyId || typeof key.accessUrl !== "string" ||
      !key.accessUrl.startsWith("ss://")) {
    throw new Error("Outline returned an invalid access key.");
  }
  return key;
}

async function createOrderAccessKey(order, options = {}) {
  const id = provisioningKeyId(order);
  const client = options.client || getOutlineClient();
  async function readExpected() {
    const key = await getAccessKeyById(id, client);
    if (key && key.name !== id) throw new Error("Outline provisioning ID is already in use.");
    return key;
  }
  let key = await readExpected();
  if (key) return { id, accessUrl: key.accessUrl };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The deployed server supports fixed-ID PUT. Never use random POST here.
      await client.put(`/access-keys/${encodeURIComponent(id)}`, { name: id });
    } catch (error) {
      // Only a transport failure has an uncertain result. HTTP failures,
      // certificate errors and malformed replies require operator review.
      const uncertain = !error?.response &&
        ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"].includes(error?.code);
      if (!uncertain) throw error;
      // A lost response can follow successful server-side creation. Reconcile
      // before repeating the same fixed-ID request.
      key = await readExpected();
      if (key) return { id, accessUrl: key.accessUrl };
      if (attempt === 1) throw error;
      continue;
    }
    key = await readExpected();
    if (!key) throw new Error("Outline creation was not confirmed.");
    return { id, accessUrl: key.accessUrl };
  }
  throw new Error("Outline creation was not confirmed.");
}

async function setAccessKeyDataLimit(keyId, limitBytes, options = {}) {
  assertRealKeyId(keyId);
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new Error("limitBytes must be a non-negative safe integer.");
  }

  try {
    const client = options.client || getOutlineClient();
    const before = await getAccessKeyById(String(keyId), client);
    if (before?.dataLimit?.bytes === limitBytes) return;
    const response = await client.put(
      `/access-keys/${encodeURIComponent(keyId)}/data-limit`,
      { limit: { bytes: limitBytes } }
    );
    const after = await getAccessKeyById(String(keyId), client);
    if (after?.dataLimit?.bytes !== limitBytes) {
      throw new Error("Outline data limit could not be verified.");
    }
    console.log("Outline data limit updated successfully.");
    return response.data;
  } catch (error) {
    const rawCode = error?.response?.data?.code;
    const code = typeof rawCode === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawCode)
      ? rawCode
      : undefined;
    console.error("Outline data-limit update failed:", {
      status: error?.response?.status,
      code,
      keyIdExists: Boolean(keyId),
      keyType: "real",
    });
    throw error;
  }
}

async function deleteAccessKey(keyId) {
  assertRealKeyId(keyId);
  await getOutlineClient().delete(`/access-keys/${encodeURIComponent(keyId)}`);
  console.log("Real Outline access key deleted.");
}

// Reset tooling receives only metadata; never return or persist accessUrl.
async function listResetAccessKeys() {
  const response = await getOutlineClient().get("/access-keys");
  const keys = response.data?.accessKeys;
  if (!Array.isArray(keys)) throw new Error("Outline access key list is invalid.");
  const seen = new Set();
  return keys.map((key) => {
    const id = key?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || seen.has(id)) {
      throw new Error("Outline access key ID is invalid or duplicated.");
    }
    seen.add(id);
    return { id,
      name: typeof key.name === "string" && !/ss:\/\//i.test(key.name)
        ? key.name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) : null,
      dataLimitBytes: Number.isSafeInteger(key.dataLimit?.bytes) && key.dataLimit.bytes >= 0
        ? key.dataLimit.bytes : null };
  });
}

async function deleteResetAccessKey(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Invalid Outline access key ID.");
  }
  await getOutlineClient().delete(`/access-keys/${encodeURIComponent(id)}`);
}

module.exports = {
  validateOutlineConfig,
  testOutlineConnection,
  getAllAccessKeyUsage,
  getExistingAccessKeyIds,
  getAccessKeyAuditMetadata,
  summarizeAccessKeyAudit,
  createAccessKey,
  provisioningKeyId,
  getAccessKeyById,
  createOrderAccessKey,
  setAccessKeyDataLimit,
  deleteAccessKey,
  listResetAccessKeys,
  deleteResetAccessKey,
  isAccessKeyNotFoundError,
};
