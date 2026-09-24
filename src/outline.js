const axios = require("axios");

const OUTLINE_MODE =
  process.env.OUTLINE_MODE || "mock";

const OUTLINE_API_URL =
  process.env.OUTLINE_API_URL || "";


// ============================================
// MOCK OUTLINE
// ============================================

function createMockAccessKey(order) {
  const keyId =
    `mock-${order.id}-${Date.now()}`;

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


function deleteAccessKey(keyId) {
  console.log(
    `Mock Outline key revoked: ${keyId}`
  );
}


// ============================================
// REAL OUTLINE
// ============================================

async function createRealAccessKey(order) {
  if (!OUTLINE_API_URL) {
    throw new Error(
      "OUTLINE_API_URL is not configured."
    );
  }

  const response =
    await axios.post(
      `${OUTLINE_API_URL}/access-keys`
    );

  const accessKey =
    response.data;

  console.log(
    `Real Outline key created: ${accessKey.id}`
  );

  return {
    id: accessKey.id,
    accessUrl: accessKey.accessUrl,
  };
}


async function deleteRealAccessKey(keyId) {
  if (!OUTLINE_API_URL) {
    throw new Error(
      "OUTLINE_API_URL is not configured."
    );
  }

  await axios.delete(
    `${OUTLINE_API_URL}/access-keys/${keyId}`
  );

  console.log(
    `Real Outline key revoked: ${keyId}`
  );
}


// ============================================
// PUBLIC FUNCTIONS
// ============================================

async function createAccessKey(order) {
  if (OUTLINE_MODE === "real") {
    return createRealAccessKey(order);
  }

  return createMockAccessKey(order);
}


async function deleteAccessKey(keyId) {
  if (OUTLINE_MODE === "real") {
    return deleteRealAccessKey(keyId);
  }

  return deleteMockAccessKey(keyId);
}


module.exports = {
  createAccessKey,
  deleteAccessKey,
};