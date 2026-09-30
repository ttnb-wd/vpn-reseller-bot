const Busboy = require("busboy");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 32 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function isValidImage(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !ALLOWED_TYPES.has(mimeType)) return false;
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(bytes.length - 12) === 0 &&
    bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND";
}

function parseMultipartProof(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_REQUEST_BYTES)
    return Promise.reject(new UploadError("Image is too large. Please choose an image under 5 MB.", 413));
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: { "content-type": contentType },
        limits: { files: 2, fields: 3, parts: 4, fieldSize: 8192,
          fileSize: MAX_IMAGE_BYTES, headerPairs: 20 } });
    } catch {
      reject(new UploadError("Please choose a JPG or PNG image."));
      return;
    }
    const fields = {};
    const chunks = [];
    let mimeType;
    let fileCount = 0;
    let problem = null;
    const invalid = () => { problem ||= new UploadError("Please choose a JPG or PNG image."); };
    parser.on("field", (name, value, info) => {
      if (!["initData", "orderNumber"].includes(name) || Object.hasOwn(fields, name) || info.valueTruncated)
        invalid();
      else fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      fileCount++;
      if (name !== "proof" || fileCount !== 1 || !ALLOWED_TYPES.has(info.mimeType)) invalid();
      mimeType = info.mimeType;
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { problem = new UploadError(
        "Image is too large. Please choose an image under 5 MB.", 413); });
      stream.resume();
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"]) parser.on(event, invalid);
    parser.on("error", () => reject(new UploadError("Please choose a JPG or PNG image.")));
    parser.on("finish", () => {
      if (problem) return reject(problem);
      if (fileCount !== 1 || !fields.initData || !fields.orderNumber)
        return reject(new UploadError("Please choose a JPG or PNG image."));
      const image = Buffer.concat(chunks);
      if (!isValidImage(image, mimeType))
        return reject(new UploadError("Please choose a JPG or PNG image."));
      resolve({ initData: fields.initData, orderNumber: fields.orderNumber,
        image, mimeType });
    });
    parser.end(bytes);
  });
}

module.exports = { MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, parseMultipartProof,
  isValidImage, UploadError };
