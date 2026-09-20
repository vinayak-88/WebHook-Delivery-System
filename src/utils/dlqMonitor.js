/**
 * DLQ Monitor — periodically checks Dead Letter Queue size and emits
 * structured log alerts when the size exceeds a configurable threshold.
 *
 * This is application-level observability, not a full monitoring/metrics system.
 * Integrate with your existing log aggregation (Datadog, CloudWatch, etc.)
 * to turn structured log ERROR events into actual alerts.
 */

const { deadLetterQueue } = require('../queues/deliveryQueue');
const logger = require('../config/logger');

const DLQ_ALERT_THRESHOLD = Number(process.env.DLQ_ALERT_THRESHOLD) || 10;
const DLQ_ALERT_INTERVAL_MS = Number(process.env.DLQ_ALERT_INTERVAL_MS) || 300_000; // 5 minutes

let lastAlertAt = 0;
let monitorTimer = null;

/**
 * Check DLQ size and log an alert if threshold is exceeded.
 * Debounced — will not log more than once per DLQ_ALERT_INTERVAL_MS.
 */
async function checkDLQ() {
  try {
    const count = await deadLetterQueue.getWaitingCount();

    if (count >= DLQ_ALERT_THRESHOLD) {
      const now = Date.now();
      const timeSinceLastAlert = now - lastAlertAt;

      if (timeSinceLastAlert >= DLQ_ALERT_INTERVAL_MS || lastAlertAt === 0) {
        lastAlertAt = now;
        logger.error('DLQ alert: dead letter queue size exceeds threshold', {
          dlqSize: count,
          threshold: DLQ_ALERT_THRESHOLD,
          alert: 'DLQ_SIZE_EXCEEDED',
          actionRequired: 'Inspect /dead-letters and replay or investigate failed deliveries',
        });
      }
    }
  } catch (err) {
    logger.warn('DLQ monitor check failed', { error: err.message });
  }
}

/**
 * Start the DLQ monitoring interval.
 * Should be called from the worker process startup.
 *
 * @returns {NodeJS.Timeout | null} The timer reference (null if disabled)
 */
function startDLQMonitor() {
  if (DLQ_ALERT_INTERVAL_MS <= 0) {
    logger.info('DLQ monitor disabled (DLQ_ALERT_INTERVAL_MS <= 0)');
    return null;
  }

  logger.info('DLQ monitor started', {
    threshold: DLQ_ALERT_THRESHOLD,
    intervalMs: DLQ_ALERT_INTERVAL_MS,
  });

  // Run immediately on start, then on interval
  void checkDLQ();

  monitorTimer = setInterval(() => void checkDLQ(), DLQ_ALERT_INTERVAL_MS);
  return monitorTimer;
}

/**
 * Stop the DLQ monitor.
 */
function stopDLQMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

module.exports = { startDLQMonitor, stopDLQMonitor, checkDLQ };
