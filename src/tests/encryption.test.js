const {
  encrypt,
  decrypt,
  isEncrypted,
  decryptSigningKey,
} = require('../utils/encryption');

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

  it('encrypts and decrypts a plaintext secret successfully (round-trip)', () => {
    const plaintext = 'super-secret-signing-key-for-webhook-deliveries!';
    const ciphertext = encrypt(plaintext);

    expect(typeof ciphertext).toBe('string');
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.split(':')).toHaveLength(3); // iv:authTag:ciphertext

    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IVs)', () => {
    const plaintext = 'identical-secret-test';
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
  });

  it('fails decryption when using the wrong key', () => {
    const plaintext = 'sensitive-subscriber-key';
    const ciphertext = encrypt(plaintext);

    process.env.WEBHOOK_ENCRYPTION_KEY = alternateKey;
    expect(() => decrypt(ciphertext)).toThrow();
    process.env.WEBHOOK_ENCRYPTION_KEY = validKey;
  });

  it('fails decryption when ciphertext is tampered with', () => {
    const plaintext = 'tamper-proof-secret';
    const ciphertext = encrypt(plaintext);
    const parts = ciphertext.split(':');

    // Tamper with ciphertext payload
    const tamperedHex = parts[2].slice(0, -2) + (parts[2].endsWith('a') ? 'b' : 'a');
    const tamperedCiphertext = `${parts[0]}:${parts[1]}:${tamperedHex}`;

    expect(() => decrypt(tamperedCiphertext)).toThrow(/authentication failed/);
  });

  it('fails decryption when auth tag is tampered with', () => {
    const plaintext = 'tamper-tag-secret';
    const ciphertext = encrypt(plaintext);
    const parts = ciphertext.split(':');

    const tamperedTag = '0'.repeat(32);
    const tamperedCiphertext = `${parts[0]}:${tamperedTag}:${parts[2]}`;

    expect(() => decrypt(tamperedCiphertext)).toThrow(/authentication failed/);
  });

  it('correctly identifies encrypted vs plaintext strings', () => {
    const encrypted = encrypt('some-secret');
    expect(isEncrypted(encrypted)).toBe(true);
    expect(isEncrypted('raw-plaintext-secret')).toBe(false);
    expect(isEncrypted('not:enough:parts:here')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it('decryptSigningKey handles both encrypted and legacy plaintext values safely', () => {
    const secret = 'legacy-or-encrypted-secret';
    const encrypted = encrypt(secret);

    // Encrypted string decrypts cleanly
    expect(decryptSigningKey(encrypted, 'sub-1')).toBe(secret);

    // In development/test mode, plaintext passes through
    process.env.NODE_ENV = 'development';
    expect(decryptSigningKey('raw-legacy-secret', 'sub-2')).toBe('raw-legacy-secret');

    // In production mode, plaintext throws
    process.env.NODE_ENV = 'production';
    expect(() => decryptSigningKey('raw-legacy-secret', 'sub-3')).toThrow(/plaintext signingKey in production/);
    process.env.NODE_ENV = 'test';
  });
});
