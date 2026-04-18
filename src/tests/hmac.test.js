const { generateSignature, verifySignature } = require('../utils/hmac')

describe('HMAC Signature Utility', () => {

  const payload = { orderId: 'ORD-123', amount: 4999 }
  const secret = 'test-secret-key'

  describe('generateSignature', () => {
    it('generates a non-empty hex string', () => {
      const sig = generateSignature(payload, secret)
      expect(typeof sig).toBe('string')
      expect(sig.length).toBeGreaterThan(0)
      // SHA-256 hex output is always 64 chars
      expect(sig).toHaveLength(64)
    })

    it('generates the same signature for the same payload and secret', () => {
      const sig1 = generateSignature(payload, secret)
      const sig2 = generateSignature(payload, secret)
      expect(sig1).toBe(sig2)
    })

    it('generates different signatures for different secrets', () => {
      const sig1 = generateSignature(payload, 'secret-one')
      const sig2 = generateSignature(payload, 'secret-two')
      expect(sig1).not.toBe(sig2)
    })

    it('generates different signatures for different payloads', () => {
      const sig1 = generateSignature({ amount: 100 }, secret)
      const sig2 = generateSignature({ amount: 200 }, secret)
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('verifySignature', () => {
    it('returns true for a valid signature', () => {
      const sig = generateSignature(payload, secret)
      expect(verifySignature(payload, secret, sig)).toBe(true)
    })

    it('returns false when payload has been tampered with', () => {
      const sig = generateSignature(payload, secret)
      const tamperedPayload = { ...payload, amount: 1 }   // attacker changed amount
      expect(verifySignature(tamperedPayload, secret, sig)).toBe(false)
    })

    it('returns false when wrong secret is used', () => {
      const sig = generateSignature(payload, secret)
      expect(verifySignature(payload, 'wrong-secret', sig)).toBe(false)
    })

    it('returns false for a completely invalid signature', () => {
      expect(verifySignature(payload, secret, 'not-a-real-signature')).toBe(false)
    })
  })
})
