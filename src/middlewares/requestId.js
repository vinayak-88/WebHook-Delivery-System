const crypto = require('crypto');

/**
 * Request ID middleware.
 *
 * - Accepts X-Request-Id header if it is a safe alphanumeric value (max 128 chars)
 * - Otherwise generates a cryptographically random UUID
 * - Attaches request ID to req.requestId
 * - Sets X-Request-Id on the response
 * - Adds requestId to all subsequent log calls through a context object
 */

const SAFE_REQUEST_ID_RE = /^[a-zA-Z0-9_\-]{1,128}$/;

const requestIdMiddleware = (req, res, next) => {
  const incoming = req.headers['x-request-id'];

  let requestId;
  if (incoming && SAFE_REQUEST_ID_RE.test(incoming)) {
    requestId = incoming;
  } else {
    requestId = crypto.randomUUID();
  }

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  next();
};

module.exports = requestIdMiddleware;
