const MAX_PROOF_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20 * 1000;

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
    throw new Error("Telegram bot token is unavailable.");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const infoResponse = await fetchImpl(`https://api.telegram.org/bot${token}/getFile`, {
    method: "POST", body: new URLSearchParams({ file_id: fileId }),
    redirect: "error", signal,
  });
  if (infoResponse.status === 400 || infoResponse.status === 404) return null;
  if (!infoResponse.ok) throw new Error("Telegram file lookup failed.");
  const file = (await infoResponse.json()).result;
  const contentType = imageType(file?.file_path);
  if (!contentType || (file.file_size !== undefined && file.file_size > MAX_PROOF_BYTES)) {
    throw new Error("Telegram payment image is unavailable.");
  }

  const imageResponse = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    redirect: "error", signal,
  });
  if (imageResponse.status === 404) return null;
  if (!imageResponse.ok || !imageResponse.body) throw new Error("Telegram image download failed.");
  const declaredSize = Number(imageResponse.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PROOF_BYTES) {
    throw new Error("Telegram payment image exceeds the size limit.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of imageResponse.body) {
    size += chunk.byteLength;
    if (size > MAX_PROOF_BYTES) throw new Error("Telegram payment image exceeds the size limit.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!hasImageSignature(bytes, contentType)) throw new Error("Telegram payment image is invalid.");
  return { bytes, contentType };
}

module.exports = { loadTelegramPaymentProof };
