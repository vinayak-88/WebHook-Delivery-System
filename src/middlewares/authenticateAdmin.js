const crypto = require('crypto');

/**
 * Admin authentication middleware.
 *
 * Reads the X-Admin-Api-Key header, SHA-256 hashes it, and compares
 * using constant-time comparison against the hash of ADMIN_API_KEY.
 *
 * This prevents timing attacks on the key comparison.
 *
 * ADMIN_API_KEY is expected to be set as a plaintext value in the
 * environment. Only its SHA-256 hash is ever compared.
 */

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const authenticateAdmin = (req, res, next) => {
  const providedKey = req.headers['x-admin-api-key'];

  if (!providedKey) {
    return res.status(401).json({ error: 'Admin API key required (X-Admin-Api-Key header)' });
  }

  // Read env per-request so tests and runtime config reloads are honoured
  // (avoids stale module-load caching when ADMIN_API_KEY changes).
  const configuredAdminKey = process.env.ADMIN_API_KEY || '';
  if (!configuredAdminKey) {
    // ADMIN_API_KEY not configured — deny all access
    return res.status(503).json({
      error: 'Admin authentication is not configured on this server',
    });
  }

  const providedHash = hashKey(providedKey);
  const configuredHash = hashKey(configuredAdminKey);

  // Constant-time comparison to prevent timing attacks
  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(
      Buffer.from(providedHash, 'hex'),
      Buffer.from(configuredHash, 'hex')
    );
  } catch {
    isValid = false;
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid admin API key' });
  }

  next();
};

module.exports = authenticateAdmin;
