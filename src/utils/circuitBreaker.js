/**
 * Per-subscriber circuit breaker backed by Redis.
 *
 * State machine:
 *   closed → (consecutive failures >= threshold) → open
 *   open   → (cooldown elapsed) → half-open (probe)
 *   half-open → (success) → closed
 *   half-open → (failure) → open
 *
 * Redis keys (per subscriberId):
 *   cb:<id>:failures   Integer — consecutive failure count
 *   cb:<id>:state      String — 'closed' | 'open'
 *   cb:<id>:openedAt   Integer — Unix ms when circuit opened
 *
 * IMPORTANT: When a circuit is open, the job is NOT dropped.
 * The caller should move the job to a delayed state so delivery
 * is retried after the cooldown period.
 */

const redisConnection = require('../config/redis');
const logger = require('../config/logger');

const FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD) || 5;
const COOLDOWN_MS = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS) || 60_000;

const KEY_FAILURES = (id) => `cb:${id}:failures`;
const KEY_STATE = (id) => `cb:${id}:state`;
const KEY_OPENED_AT = (id) => `cb:${id}:openedAt`;

const STATE_CLOSED = 'closed';
const STATE_OPEN = 'open';

/**
 * Get the current circuit state for a subscriber.
 *
 * @param {string} subscriberId
 * @returns {Promise<{ state: 'closed'|'open'|'half-open', remainingCooldownMs: number }>}
 */
async function getCircuitState(subscriberId) {
  const [state, openedAtStr] = await redisConnection.mget(
    KEY_STATE(subscriberId),
    KEY_OPENED_AT(subscriberId)
  );

  if (!state || state === STATE_CLOSED) {
    return { state: STATE_CLOSED, remainingCooldownMs: 0 };
  }

  if (state === STATE_OPEN) {
    const openedAt = Number(openedAtStr) || 0;
    const elapsed = Date.now() - openedAt;

    if (elapsed >= COOLDOWN_MS) {
      // Cooldown elapsed — transition to half-open for a probe attempt
      return { state: 'half-open', remainingCooldownMs: 0 };
    }

    return { state: STATE_OPEN, remainingCooldownMs: COOLDOWN_MS - elapsed };
  }

  // Unexpected state — default to closed
  return { state: STATE_CLOSED, remainingCooldownMs: 0 };
}

/**
 * Record a delivery failure for a subscriber.
 * Opens the circuit if the failure threshold is reached.
 *
 * @param {string} subscriberId
 * @returns {Promise<{ opened: boolean, failures: number }>}
 */
async function recordFailure(subscriberId) {
  const failures = await redisConnection.incr(KEY_FAILURES(subscriberId));

  if (failures >= FAILURE_THRESHOLD) {
    const currentState = await redisConnection.get(KEY_STATE(subscriberId));
    if (currentState !== STATE_OPEN) {
      // Open the circuit
      await redisConnection.mset(
        KEY_STATE(subscriberId), STATE_OPEN,
        KEY_OPENED_AT(subscriberId), String(Date.now())
      );
      logger.warn('Circuit breaker opened for subscriber', {
        subscriberId,
        consecutiveFailures: failures,
        threshold: FAILURE_THRESHOLD,
        cooldownMs: COOLDOWN_MS,
      });
      return { opened: true, failures };
    }
  }

  return { opened: false, failures };
}

/**
 * Record a delivery success for a subscriber.
 * Resets failure count and closes the circuit.
 *
 * @param {string} subscriberId
 * @returns {Promise<{ wasOpen: boolean }>}
 */
async function recordSuccess(subscriberId) {
  const currentState = await redisConnection.get(KEY_STATE(subscriberId));
  const wasOpen = currentState === STATE_OPEN;

  // Reset all circuit breaker state
  await redisConnection.del(
    KEY_FAILURES(subscriberId),
    KEY_STATE(subscriberId),
    KEY_OPENED_AT(subscriberId)
  );

  if (wasOpen) {
    logger.info('Circuit breaker closed after successful delivery', { subscriberId });
  }

  return { wasOpen };
}

/**
 * Reset the circuit breaker for a subscriber unconditionally.
 * Used for testing/admin purposes.
 *
 * @param {string} subscriberId
 */
async function resetCircuit(subscriberId) {
  await redisConnection.del(
    KEY_FAILURES(subscriberId),
    KEY_STATE(subscriberId),
    KEY_OPENED_AT(subscriberId)
  );
}

module.exports = {
  getCircuitState,
  recordFailure,
  recordSuccess,
  resetCircuit,
  FAILURE_THRESHOLD,
  COOLDOWN_MS,
};
