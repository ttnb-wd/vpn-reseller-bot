require("dotenv").config();
const axios = require("axios");
const https = require("https");

async function createTestKey() {
  try {
    const apiUrl = process.env.OUTLINE_API_URL;

    if (!apiUrl || apiUrl === "mock") {
      throw new Error("OUTLINE_API_URL is not configured");
    }

    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });

    console.log("Creating test Outline access key...");

    const response = await axios.post(
      `${apiUrl}access-keys`,
      {},
      {
        httpsAgent,
      }
    );

    const key = response.data;

    console.log("✅ Access key created!");
    console.log("Key ID:", key.id);
    console.log("Name:", key.name || "Unnamed");
    console.log("Access URL:", key.accessUrl);
  } catch (error) {
    console.error("❌ Failed to create access key.");

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Response:", error.response.data);
    } else {
      console.error("Error:", error.message);
    }
  }
}

createTestKey();