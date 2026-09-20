const { generateSignature, verifySignature } = require('../utils/hmac');

describe('HMAC Signature Utility', () => {
  const payload = { orderId: 'ORD-123', amount: 4999 };
  const secret = 'a-sufficiently-long-secret-for-testing-hmac-flows-min-32-chars';
  const timestamp = Date.now();

  describe('generateSignature', () => {
    it('generates a non-empty 64-char hex string', () => {
      const sig = generateSignature(payload, secret, timestamp);
      expect(typeof sig).toBe('string');
      expect(sig).toHaveLength(64);
    });

    it('generates the same signature for the same payload, secret, and timestamp', () => {
      const sig1 = generateSignature(payload, secret, timestamp);
      const sig2 = generateSignature(payload, secret, timestamp);
      expect(sig1).toBe(sig2);
    });

    it('generates different signatures for different secrets', () => {
      const sig1 = generateSignature(payload, secret, timestamp);
      const sig2 = generateSignature(payload, 'another-secret-that-is-at-least-32-characters-long', timestamp);
      expect(sig1).not.toBe(sig2);
    });

    it('generates different signatures for different payloads', () => {
      const sig1 = generateSignature({ amount: 100 }, secret, timestamp);
      const sig2 = generateSignature({ amount: 200 }, secret, timestamp);
      expect(sig1).not.toBe(sig2);
    });

    it('generates different signatures for different timestamps', () => {
      const sig1 = generateSignature(payload, secret, timestamp);
      const sig2 = generateSignature(payload, secret, timestamp + 1000);
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('verifySignature', () => {
    it('returns true for a valid signature with fresh timestamp', () => {
      const now = Date.now();
      const sig = generateSignature(payload, secret, now);
      expect(verifySignature(payload, secret, now, sig)).toBe(true);
    });

    it('returns false when timestamp is older than 5 minutes (replay attack)', () => {
      const oldTimestamp = Date.now() - (6 * 60 * 1000); // 6 mins ago
      const sig = generateSignature(payload, secret, oldTimestamp);
      expect(verifySignature(payload, secret, oldTimestamp, sig)).toBe(false);
    });

    it('returns false when payload has been tampered with', () => {
      const now = Date.now();
      const sig = generateSignature(payload, secret, now);
      const tampered = { ...payload, amount: 1 };
      expect(verifySignature(tampered, secret, now, sig)).toBe(false);
    });

    it('returns false when wrong secret is used', () => {
      const now = Date.now();
      const sig = generateSignature(payload, secret, now);
      expect(verifySignature(payload, 'wrong-secret-that-is-at-least-32-characters-long', now, sig)).toBe(false);
    });

    it('returns false for an invalid/malformed signature string', () => {
      const now = Date.now();
      expect(verifySignature(payload, secret, now, 'not-a-valid-hex-signature')).toBe(false);
    });

    it('returns false for mismatched signature length without throwing timingSafeEqual error', () => {
      const now = Date.now();
      expect(verifySignature(payload, secret, now, 'deadbeef')).toBe(false);
    });
  });
});