const MAX_PROOF_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const PROOF_ERROR_CODES = new Set([
  "TOKEN_UNAVAILABLE", "GET_FILE_FAILED", "GET_FILE_INVALID", "GET_FILE_TOO_LARGE",
  "INVALID_FILE_PATH", "PROOF_TOO_LARGE", "DOWNLOAD_FAILED", "UNSUPPORTED_CONTENT_TYPE",
  "INVALID_IMAGE", "PROOF_FETCH_FAILED",
]);

function proofError(code) {
  const error = new Error("Payment proof is unavailable.");
  error.proofCode = code;
  return error;
}

async function readBounded(response, limit, code) {
  if (!response.body) throw proofError(code);
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw proofError(code);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function imageType(filePath) {
  if (typeof filePath !== "string") return null;
  const segments = filePath.split("/");
  if (segments.length < 2 || segments[0] !== "photos" || segments.slice(1).some((part) =>
    part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) return null;
  const filename = segments.at(-1);
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return null;
}

function hasImageSignature(bytes, contentType) {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
}

async function loadTelegramPaymentProof(fileId, options = {}) {
  if (typeof fileId !== "string" || !fileId || fileId.length > 1024) return null;
  const token = options.token ?? process.env.BOT_TOKEN;
  if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw proofError("TOKEN_UNAVAILABLE");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const diagnostic = options.onDiagnostic || (() => {});
  try {
    const infoResponse = await fetchImpl(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST", body: new URLSearchParams({ file_id: fileId }),
      redirect: "error", signal,
    });
    diagnostic({ stage: "get_file", status: infoResponse.status });
    if (infoResponse.status === 400 || infoResponse.status === 404) return null;
    if (!infoResponse.ok) throw proofError("GET_FILE_FAILED");
    const infoBytes = await readBounded(infoResponse, 8192, "GET_FILE_TOO_LARGE");
    let file;
    try {
      const info = JSON.parse(infoBytes.toString("utf8"));
      if (info.ok !== true || !info.result || typeof info.result !== "object") {
        throw proofError("GET_FILE_INVALID");
      }
      file = info.result;
    } catch { throw proofError("GET_FILE_INVALID"); }
    const contentType = imageType(file?.file_path);
    if (!contentType) throw proofError("INVALID_FILE_PATH");
    if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) ||
        file.file_size <= 0 || file.file_size > MAX_PROOF_BYTES)) {
      throw proofError("PROOF_TOO_LARGE");
    }

    const imageResponse = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      redirect: "error", signal,
    });
    diagnostic({ stage: "download", status: imageResponse.status });
    if (imageResponse.status === 404) return null;
    if (!imageResponse.ok || !imageResponse.body) throw proofError("DOWNLOAD_FAILED");
    const remoteType = (imageResponse.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    // Telegram's file endpoint also serves photos as generic binary. Only permit
    // that transport type when the trusted path and actual image signature agree.
    if (remoteType !== contentType && remoteType !== "application/octet-stream") {
      await imageResponse.body.cancel().catch(() => {});
      throw proofError("UNSUPPORTED_CONTENT_TYPE");
    }
    const declaredSize = Number(imageResponse.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PROOF_BYTES) {
      await imageResponse.body.cancel().catch(() => {});
      throw proofError("PROOF_TOO_LARGE");
    }
    const bytes = await readBounded(imageResponse, MAX_PROOF_BYTES, "PROOF_TOO_LARGE");
    if (!hasImageSignature(bytes, contentType)) throw proofError("INVALID_IMAGE");
    return { bytes, contentType };
  } catch (error) {
    throw PROOF_ERROR_CODES.has(error.proofCode) ? error : proofError("PROOF_FETCH_FAILED");
  }
}

module.exports = { loadTelegramPaymentProof, PROOF_ERROR_CODES };
