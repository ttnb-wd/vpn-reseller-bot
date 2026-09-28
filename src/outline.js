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

// Validate before either the HTTP health server or Telegram polling starts.
const outlineConfig = validateOutlineConfig();

function createOutlineHttpsAgent() {
  const agent = new https.Agent({ maxCachedSessions: 0 });

  // Outline normally uses a self-signed certificate. Node does not call
  // checkServerIdentity for a certificate that fails CA validation, so hold
  // the socket until its certificate has matched the configured fingerprint.
  agent.createConnection = (options, callback) => {
    const servername = options.servername ??
      (net.isIP(outlineConfig.hostname) ? "" : outlineConfig.hostname);
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
        finish(new Error("Outline API certificate is unavailable."));
        return;
      }

      const actualFingerprint = crypto
        .createHash("sha256")
        .update(certificate.raw)
        .digest("hex")
        .toUpperCase();

      if (actualFingerprint !== outlineConfig.fingerprint) {
        finish(new Error("Outline API certificate fingerprint mismatch."));
        return;
      }

      finish();
    });
    socket.once("error", finish);
  };

  return agent;
}

function getOutlineClient() {
  return axios.create({
    baseURL: outlineConfig.apiUrl,
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

async function setAccessKeyDataLimit(keyId, limitBytes) {
  assertRealKeyId(keyId);
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new Error("limitBytes must be a non-negative safe integer.");
  }

  try {
    const response = await getOutlineClient().put(
      `/access-keys/${encodeURIComponent(keyId)}/data-limit`,
      { limit: { bytes: limitBytes } }
    );
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

module.exports = {
  testOutlineConnection,
  createAccessKey,
  setAccessKeyDataLimit,
  deleteAccessKey,
  isAccessKeyNotFoundError,
};
