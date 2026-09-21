const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

/**
 * Returns the 32-byte encryption key as a Buffer.
 * Reads from WEBHOOK_ENCRYPTION_KEY env var (must be a 64-char hex string).
 * Throws if missing or malformed.
 */
function getEncryptionKey() {
  const hex = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'WEBHOOK_ENCRYPTION_KEY environment variable is required. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'WEBHOOK_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Current value has incorrect format or length.'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a string in the format: <ivHex>:<authTagHex>:<ciphertextHex>
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt: plaintext must be a non-empty string');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string previously produced by encrypt().
 * Throws on wrong key, tampered ciphertext, or bad format.
 *
 * Signing secrets are always stored encrypted (iv:authTag:ciphertext).
 * A value that cannot be decrypted is a hard error — it is never
 * treated as a plaintext secret.
 *
 * @param {string} stored  Format: <ivHex>:<authTagHex>:<ciphertextHex>
 * @returns {string} plaintext
 */
function decrypt(stored) {
  if (typeof stored !== 'string') {
    throw new Error('decrypt: stored value must be a string');
  }

  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'decrypt: stored value does not match expected format iv:authTag:ciphertext'
    );
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  let iv, authTag, ciphertext;
  try {
    iv = Buffer.from(ivHex, 'hex');
    authTag = Buffer.from(authTagHex, 'hex');
    ciphertext = Buffer.from(ciphertextHex, 'hex');
  } catch {
    throw new Error('decrypt: stored value contains invalid hex data');
  }

  if (iv.length !== IV_LENGTH) {
    throw new Error(`decrypt: IV must be ${IV_LENGTH} bytes`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`decrypt: auth tag must be ${AUTH_TAG_LENGTH} bytes`);
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      'decrypt: authentication failed — ciphertext may be tampered or wrong encryption key'
    );
  }
}

module.exports = { encrypt, decrypt };
