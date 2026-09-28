const axios = require("axios");
const https = require("https");
const crypto = require("crypto");

const OUTLINE_MODE =
  process.env.OUTLINE_MODE || "mock";

const OUTLINE_API_URL =
  process.env.OUTLINE_API_URL || "";

const OUTLINE_API_CERT_SHA256 =
  process.env.OUTLINE_API_CERT_SHA256 || "";

/**
 * Create HTTPS agent for Outline Management API.
 *
 * Outline uses a self-signed certificate.
 * We verify the certificate using its SHA-256 fingerprint.
 */
function createOutlineHttpsAgent() {
  if (!OUTLINE_API_CERT_SHA256) {
    throw new Error(
      "OUTLINE_API_CERT_SHA256 is not configured."
    );
  }

  const expectedFingerprint =
    OUTLINE_API_CERT_SHA256
      .replace(/:/g, "")
      .replace(/\s/g, "")
      .toUpperCase();

  return new https.Agent({
    rejectUnauthorized: false,

    checkServerIdentity: (hostname, cert) => {
      const actualFingerprint = crypto
        .createHash("sha256")
        .update(cert.raw)
        .digest("hex")
        .toUpperCase();

      if (actualFingerprint !== expectedFingerprint) {
        throw new Error(
          [
            "Outline API certificate fingerprint mismatch.",
            `Expected: ${expectedFingerprint}`,
            `Actual:   ${actualFingerprint}`,
          ].join("\n")
        );
      }

      return undefined;
    },
  });
}

/**
 * Create Axios client for Outline Management API.
 */
function getOutlineClient() {
  if (!OUTLINE_API_URL) {
    throw new Error(
      "OUTLINE_API_URL is not configured."
    );
  }

  return axios.create({
    baseURL: OUTLINE_API_URL,
    timeout: 10000,
    httpsAgent: createOutlineHttpsAgent(),
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Test connection to Outline Server.
 *
 * GET /server
 */
async function testOutlineConnection() {
  const client = getOutlineClient();

  const response = await client.get("/server");

  return response.data;
}

/**
 * Create a mock VPN key.
 */
function createMockAccessKey(order) {
  const keyId = `mock-${order.id}-${Date.now()}`;

  const accessKey =
    `ss://mock-outline-key-${order.id}-${Date.now()}`;

  console.log(
    `Mock Outline key created: ${keyId}`
  );

  return {
    id: keyId,
    accessUrl: accessKey,
  };
}

/**
 * Create a real Outline VPN access key.
 *
 * POST /access-keys
 */
async function createRealAccessKey(order) {
  const client = getOutlineClient();

  const response = await client.post(
    "/access-keys"
  );

  const accessKey = response.data;

  console.log(
    `Real Outline key created: ${accessKey.id}`
  );

  return {
    id: accessKey.id,
    accessUrl: accessKey.accessUrl,
  };
}

/**
 * Set data limit for a real Outline VPN key.
 *
 * Outline expects:
 *
 * {
 *   "limit": {
 *     "bytes": 123456789
 *   }
 * }
 *
 * PUT /access-keys/:id/data-limit
 */
async function setRealAccessKeyDataLimit(
  keyId,
  limitBytes
) {
  try {
    const client = getOutlineClient();

    if (!Number.isFinite(limitBytes)) {
      throw new Error("limitBytes must be a valid number.");
    }

    if (!Number.isInteger(limitBytes)) {
      throw new Error("limitBytes must be an integer.");
    }

    if (limitBytes < 0) {
      throw new Error("limitBytes must be non-negative.");
    }

    const response = await client.put(
      `/access-keys/${encodeURIComponent(keyId)}/data-limit`,
      {
        limit: {
          bytes: limitBytes,
        },
      }
    );

    console.log("Outline data limit updated successfully.");
    return response.data;
  } catch (error) {
    const safeText = (value) => {
      if (typeof value !== "string" && typeof value !== "number") {
        return undefined;
      }

      return String(value)
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
        .replace(/ss:\/\/[^\s"'<>]+/gi, "[redacted-key]")
        .slice(0, 300);
    };

    const providerData = error.response?.data;
    const keyIdExists = keyId !== undefined && keyId !== null && String(keyId).length > 0;

    console.error("Outline data-limit update failed:", {
      status: error.response?.status,
      code: safeText(providerData?.code),
      message: safeText(providerData?.message),
      keyIdExists,
      keyType: keyIdExists
        ? String(keyId).startsWith("mock-")
          ? "mock"
          : "real"
        : "missing",
    });

    throw error;
  }
}

/**
 * Set data limit for a mock VPN key.
 */
async function setMockAccessKeyDataLimit(
  keyId,
  limitBytes
) {
  console.log(
    `Mock data limit set for ${keyId}: ${limitBytes} bytes`
  );

  return {
    keyId,
    limit: {
      bytes: limitBytes,
    },
  };
}

/**
 * Set data limit.
 */
async function setAccessKeyDataLimit(
  keyId,
  limitBytes
) {
  if (OUTLINE_MODE === "real") {
    return setRealAccessKeyDataLimit(
      keyId,
      limitBytes
    );
  }

  return setMockAccessKeyDataLimit(
    keyId,
    limitBytes
  );
}

/**
 * Delete a mock VPN key.
 */
async function deleteMockAccessKey(keyId) {
  console.log(
    `Mock Outline key revoked: ${keyId}`
  );
}

/**
 * Delete a real Outline VPN access key.
 *
 * DELETE /access-keys/:id
 */
async function deleteRealAccessKey(keyId) {
  const client = getOutlineClient();

  await client.delete(
    `/access-keys/${encodeURIComponent(keyId)}`
  );

  console.log(
    `Real Outline key revoked: ${keyId}`
  );
}

/**
 * Create VPN access key.
 */
async function createAccessKey(order) {
  if (OUTLINE_MODE === "real") {
    return createRealAccessKey(order);
  }

  return createMockAccessKey(order);
}

/**
 * Delete VPN access key.
 */
async function deleteAccessKey(keyId) {
  if (OUTLINE_MODE === "real") {
    return deleteRealAccessKey(keyId);
  }

  return deleteMockAccessKey(keyId);
}

function isRealOutlineMode() {
  return OUTLINE_MODE === "real";
}

module.exports = {
  testOutlineConnection,
  createAccessKey,
  setAccessKeyDataLimit,
  deleteAccessKey,
  isRealOutlineMode,
};
