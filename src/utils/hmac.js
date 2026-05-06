const crypto = require("crypto");

const generateSignature = (payload, secret) => {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload));

  return crypto.createHmac("sha256", secret).update(body).digest("hex");
};
const verifySignature = (payload, secret, receivedSignature) => {
  const expectedSignature = generateSignature(payload, secret);

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
