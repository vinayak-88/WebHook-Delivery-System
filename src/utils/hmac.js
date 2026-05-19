const crypto = require("crypto");

const generateSignature = (payload, secret, timestamp) => {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload));

  const tsString = String(timestamp);

  return crypto
    .createHmac("sha256", secret)
    .update(`${tsString}.`)
    .update(body)
    .digest("hex");
};
const verifySignature = (payload, secret, timestamp, receivedSignature) => {
  const TOLERANCE_MS = 5 * 60 * 1000;
  const now = Date.now();
  const ts = Number(timestamp);

   if (isNaN(ts) || Math.abs(now - ts) > TOLERANCE_MS) {
    return false; // Timestamp is too old or invalid
  }

  const expectedSignature = generateSignature(payload, secret, timestamp);

  //avoided === to avoid timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "hex"),
      Buffer.from(receivedSignature, "hex"),
    );
  } catch {
    // Buffer lengths differ — signature is invalid
    return false;
  }
};

module.exports = { generateSignature, verifySignature };
