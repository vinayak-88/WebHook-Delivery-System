const crypto = require('crypto')
const { generateSignature, verifySignature } = require('../utils/hmac')

// Derive a signing key exactly as Subscriber.js pre-save does.
// Tests must mirror the production key derivation path — using a raw
// plaintext string as both the signing key and the verification key
// masked the bug where the worker was signing with secretHash (a bcrypt
// hash) instead of the HKDF-derived signingKey.
const deriveSigningKey = (plaintext) =>
  crypto.hkdfSync(
    'sha256',
    Buffer.from(plaintext),
    Buffer.alloc(0),
    Buffer.from('webhook-signing-v1'),
    32
  ).toString('hex')

describe('HMAC Signature Utility', () => {

  const payload = { orderId: 'ORD-123', amount: 4999 }
  const secret = 'a-sufficiently-long-secret-for-testing-hmac-flows'
  const signingKey = deriveSigningKey(secret)

  describe('generateSignature', () => {
    it('generates a non-empty hex string', () => {
      const sig = generateSignature(payload, signingKey)
      expect(typeof sig).toBe('string')
      expect(sig.length).toBeGreaterThan(0)
      // SHA-256 hex output is always 64 chars
      expect(sig).toHaveLength(64)
    })

    it('generates the same signature for the same payload and signingKey', () => {
      const sig1 = generateSignature(payload, signingKey)
      const sig2 = generateSignature(payload, signingKey)
      expect(sig1).toBe(sig2)
    })

    it('generates different signatures for different secrets', () => {
      const key1 = deriveSigningKey('secret-one-long-enough-to-pass-minimum-length')
      const key2 = deriveSigningKey('secret-two-long-enough-to-pass-minimum-length')
      const sig1 = generateSignature(payload, key1)
      const sig2 = generateSignature(payload, key2)
      expect(sig1).not.toBe(sig2)
    })

    it('generates different signatures for different payloads', () => {
      const sig1 = generateSignature({ amount: 100 }, signingKey)
      const sig2 = generateSignature({ amount: 200 }, signingKey)
      expect(sig1).not.toBe(sig2)
    })

    it('produces a different key than the raw plaintext — HKDF isolation confirmed', () => {
      // The signingKey must be cryptographically distinct from the secret.
      // If they were equal, signing with secretHash (bcrypt) would appear
      // to work when the secret happened to be a hex string of the right length.
      expect(signingKey).not.toBe(secret)
      expect(signingKey).toHaveLength(64) // 32 bytes as hex
    })
  })

  describe('verifySignature', () => {
    it('returns true for a valid signature when verifying with the derived signingKey', () => {
      const sig = generateSignature(payload, signingKey)
      expect(verifySignature(payload, signingKey, sig)).toBe(true)
    })

    it('returns false when verifying with the raw plaintext instead of the signingKey', () => {
      // This is the core regression test for the original bug:
      // the worker was signing with signingKey but the test was verifying
      // with the raw secret, which would have caught the mismatch.
      const sig = generateSignature(payload, signingKey)
      expect(verifySignature(payload, secret, sig)).toBe(false)
    })

    it('returns false when payload has been tampered with', () => {
      const sig = generateSignature(payload, signingKey)
      const tamperedPayload = { ...payload, amount: 1 }
      expect(verifySignature(tamperedPayload, signingKey, sig)).toBe(false)
    })

    it('returns false when wrong secret is used', () => {
      const sig = generateSignature(payload, signingKey)
      const wrongKey = deriveSigningKey('wrong-secret-long-enough-to-pass-validation')
      expect(verifySignature(payload, wrongKey, sig)).toBe(false)
    })

    it('returns false for a completely invalid signature', () => {
      expect(verifySignature(payload, signingKey, 'not-a-real-signature')).toBe(false)
    })
  })
})