const { encrypt, decrypt } = require('../utils/encryption');

describe('AES-256-GCM Encryption Utility', () => {
  const originalKey = process.env.WEBHOOK_ENCRYPTION_KEY;
  const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const alternateKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  beforeAll(() => {
    process.env.WEBHOOK_ENCRYPTION_KEY = validKey;
  });

  afterAll(() => {
    process.env.WEBHOOK_ENCRYPTION_KEY = originalKey;
  });

  it('encrypts and decrypts a secret successfully (round-trip)', () => {
    const secret = 'super-secret-signing-key-for-webhook-deliveries!';
    const ciphertext = encrypt(secret);

    expect(typeof ciphertext).toBe('string');
    expect(ciphertext).not.toBe(secret);
    expect(ciphertext.split(':')).toHaveLength(3); // iv:authTag:ciphertext

    expect(decrypt(ciphertext)).toBe(secret);
  });

  it('produces different ciphertexts for the same secret (random IVs)', () => {
    const secret = 'identical-secret-test';
    const c1 = encrypt(secret);
    const c2 = encrypt(secret);
    expect(c1).not.toBe(c2);
  });

  it('fails decryption when using the wrong key', () => {
    const secret = 'sensitive-subscriber-key';
    const ciphertext = encrypt(secret);

    process.env.WEBHOOK_ENCRYPTION_KEY = alternateKey;
    expect(() => decrypt(ciphertext)).toThrow();
    process.env.WEBHOOK_ENCRYPTION_KEY = validKey;
  });

  it('fails decryption when ciphertext is tampered with', () => {
    const secret = 'tamper-proof-secret';
    const ciphertext = encrypt(secret);
    const parts = ciphertext.split(':');

    // Tamper with ciphertext payload
    const tamperedHex = parts[2].slice(0, -2) + (parts[2].endsWith('a') ? 'b' : 'a');
    const tamperedCiphertext = `${parts[0]}:${parts[1]}:${tamperedHex}`;

    expect(() => decrypt(tamperedCiphertext)).toThrow(/authentication failed/);
  });

  it('fails decryption when auth tag is tampered with', () => {
    const secret = 'tamper-tag-secret';
    const ciphertext = encrypt(secret);
    const parts = ciphertext.split(':');

    const tamperedTag = '0'.repeat(32);
    const tamperedCiphertext = `${parts[0]}:${tamperedTag}:${parts[2]}`;

    expect(() => decrypt(tamperedCiphertext)).toThrow(/authentication failed/);
  });

  it('fails decryption for values that were never encrypted', () => {
    expect(() => decrypt('raw-plaintext-secret')).toThrow();
    expect(() => decrypt('not:enough:parts:here')).toThrow();
    expect(() => decrypt(null)).toThrow();
  });
});
