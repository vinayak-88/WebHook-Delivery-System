const crypto = require('crypto')

/**
 * Generates an HMAC-SHA256 signature for a given payload and secret.
 * Used to sign every outgoing webhook delivery so subscribers can
 * verify the request actually came from this server.
 *
 * @param {object} payload - The event payload to sign
 * @param {string} secret  - The subscriber's shared secret
 * @returns {string}       - Hex-encoded HMAC signature
 */
const generateSignature = (payload, secret) => {
  const body = JSON.stringify(payload)
  return crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex')
}

/**
 * Verifies an incoming signature against the expected one.
 *
 * Uses timingSafeEqual instead of === to prevent timing attacks —
 * where an attacker could guess the correct signature byte-by-byte
 * by measuring how long the comparison takes.
 *
 * @param {object} payload           - The received payload
 * @param {string} secret            - The subscriber's shared secret
 * @param {string} receivedSignature - Signature from X-Webhook-Signature header
 * @returns {boolean}
 */
const verifySignature = (payload, secret, receivedSignature) => {
  const expectedSignature = generateSignature(payload, secret)

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(receivedSignature, 'hex')
    )
  } catch {
    // Buffer lengths differ — signature is invalid
    return false
  }
}

module.exports = { generateSignature, verifySignature }