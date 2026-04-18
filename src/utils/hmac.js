const crypto = require('crypto')

/**
 * Generates an HMAC-SHA256 signature for a given payload and secret.
 * Used to sign every outgoing webhook delivery so subscribers can
 * verify the request actually came from this server.
 *
 * Accepts either a Buffer (preferred — raw request bytes, avoids
 * JSON property-order instability) or a plain object (falls back to
 * JSON.stringify). Always pass raw body bytes when available.
 *
 * @param {Buffer|object} payload - Raw body buffer or event payload object
 * @param {string} secret         - The subscriber's shared secret
 * @returns {string}              - Hex-encoded HMAC signature
 */
const generateSignature = (payload, secret) => {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload))

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
 * @param {Buffer|object} payload    - Raw body buffer or received payload object
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