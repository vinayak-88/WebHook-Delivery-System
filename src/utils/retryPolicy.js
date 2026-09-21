/**
 * Delivery failure classification: transient (retry) vs permanent (fail fast).
 *
 * Rule (no giant status list):
 *   - no HTTP response (network error, DNS failure, refused/reset, timeout) → retry
 *   - 408 Request Timeout → retry
 *   - 429 Too Many Requests → retry
 *   - 5xx → retry
 *   - any other 4xx → permanent failure (do not waste 5 attempts on a
 *     request the subscriber will never accept)
 *
 * @param {Error} err Axios-style error (may carry `err.response.status`)
 * @returns {boolean} true if the delivery should be retried
 */
function isRetryableError(err) {
  const status = err && err.response ? err.response.status : null;

  // No response received: network/DNS/connection/timeout failure → transient
  if (status === null || status === undefined) {
    return true;
  }

  if (status === 408 || status === 429) {
    return true;
  }

  if (status >= 500 && status <= 599) {
    return true;
  }

  return false;
}

module.exports = { isRetryableError };
