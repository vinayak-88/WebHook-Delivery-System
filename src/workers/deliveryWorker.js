require("dotenv").config();
const { Worker, DelayedError } = require("bullmq");
const axios = require("axios");
const redisConnection = require("../config/redis");
const connectDB = require("../config/db");
const logger = require("../config/logger");
const DeliveryLog = require("../models/DeliveryLog");
const Subscriber = require("../models/Subscriber");
const { deadLetterQueue, MAX_DELIVERY_ATTEMPTS } = require("../queues/deliveryQueue");
const { generateSignature } = require("../utils/hmac");
const { decryptSigningKey } = require("../utils/encryption");
const { validateNoSSRF } = require("../utils/ssrf");
const { assertValidDeliveryJobData } = require("../utils/jobSchema");
const {
  getCircuitState,
  recordFailure,
  recordSuccess,
  COOLDOWN_MS,
} = require("../utils/circuitBreaker");
const { startDLQMonitor, stopDLQMonitor } = require("../utils/dlqMonitor");

const RETRY_JITTER_MS = Number(process.env.RETRY_JITTER_MS) || 500;
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_WEBHOOK_TIMEOUT_MS) || 5000;

const rawConcurrency = Number(process.env.WORKER_CONCURRENCY);
const workerConcurrency =
  Number.isInteger(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : 5;

const buildLogPayload = ({
  eventId,
  subscriberId,
  subscriberUrl,
  attemptNumber,
  statusCode,
  responseBody,
  success,
  errorMessage,
  requestId,
}) => ({
  eventId,
  subscriberId,
  subscriberUrl,
  attemptNumber,
  statusCode,
  responseBody,
  success,
  errorMessage,
  requestId: requestId || null,
});

const persistDeliveryLog = async (
  logPayload,
  { rethrowOnFailure = false } = {},
) => {
  try {
    await DeliveryLog.create(logPayload);
  } catch (err) {
    logger.error("Failed to persist delivery log", {
      eventId: logPayload.eventId,
      subscriberId: logPayload.subscriberId,
      attemptNumber: logPayload.attemptNumber,
      success: logPayload.success,
      error: err.message,
    });

    if (rethrowOnFailure) {
      throw err;
    }
  }
};

const processDeliveryJob = async (job) => {
  // 1. Validate job data schema (consumer-side trust boundary)
  assertValidDeliveryJobData(job.data);

  const { eventId, subscriberId, subscriberUrl, payload, requestId } = job.data;
  const attemptNumber = job.attemptsMade + 1;

  logger.info(`Delivering job ${job.id}`, {
    attempt: attemptNumber,
    subscriberUrl,
    eventId,
    requestId,
  });

  // 2. Check subscriber circuit breaker state
  const circuit = await getCircuitState(subscriberId);
  if (circuit.state === "open") {
    const delayMs = Math.max(circuit.remainingCooldownMs, 1000);
    logger.warn(
      `Circuit open for subscriber ${subscriberId}. Delaying job ${job.id} for ${delayMs}ms`,
      { subscriberId, delayMs },
    );
    if (job.token && typeof job.moveToDelayed === "function") {
      await job.moveToDelayed(Date.now() + delayMs, job.token);
      throw new DelayedError();
    }
    throw new Error(
      `CIRCUIT_OPEN: Subscriber circuit is open (cooldown ${delayMs}ms remaining)`,
    );
  }

  // 3. SSRF destination validation immediately before outbound request
  await validateNoSSRF(subscriberUrl);

  // 4. Fetch subscriber and decrypt secret
  const subscriber = await Subscriber.findById(subscriberId).select(
    "signingKey isActive timeoutMs",
  );
  if (!subscriber || !subscriber.isActive) {
    throw new Error(`Subscriber ${subscriberId} is inactive or not found`);
  }

  const signingKey = decryptSigningKey(subscriber.signingKey, subscriberId);

  const bodyBuffer = Buffer.from(JSON.stringify(payload));
  const timestamp = Date.now();
  const signature = generateSignature(bodyBuffer, signingKey, timestamp);
  const timeoutMs = subscriber.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    const response = await axios.post(subscriberUrl, bodyBuffer, {
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event-Id": eventId,
        "X-Webhook-Attempt": attemptNumber,
        "X-timestamp": String(timestamp),
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      timeout: timeoutMs,
      maxRedirects: 0, // Prevent redirect-based SSRF bypass
    });

    // Record circuit breaker success
    await recordSuccess(subscriberId);

    await persistDeliveryLog(
      buildLogPayload({
        eventId,
        subscriberId,
        subscriberUrl,
        attemptNumber,
        statusCode: response.status,
        responseBody: JSON.stringify(response.data),
        success: true,
        errorMessage: null,
        requestId,
      }),
    );

    logger.info(`Job ${job.id} delivered successfully`, {
      attempt: attemptNumber,
      statusCode: response.status,
      requestId,
    });

    return response;
  } catch (err) {
    // Record circuit breaker failure
    await recordFailure(subscriberId);

    const statusCode = err.response ? err.response.status : null;
    const responseBody = err.response
      ? JSON.stringify(err.response.data)
      : null;
    const errorMessage = err.message;

    if (err.response) {
      logger.warn(`Job ${job.id} failed — subscriber returned error`, {
        attempt: attemptNumber,
        statusCode,
        requestId,
      });
    } else {
      logger.warn(`Job ${job.id} failed — network error`, {
        attempt: attemptNumber,
        error: err.message,
        requestId,
      });
    }

    await persistDeliveryLog(
      buildLogPayload({
        eventId,
        subscriberId,
        subscriberUrl,
        attemptNumber,
        statusCode,
        responseBody,
        success: false,
        errorMessage,
        requestId,
      }),
    );

    throw err;
  }
};

const deliveryWorker = new Worker("webhook-delivery", processDeliveryJob, {
  connection: redisConnection,
  concurrency: workerConcurrency,
  settings: {
    backoffStrategy: (attemptsMade, type, err) => {
      if (err && err.message && err.message.startsWith("CIRCUIT_OPEN")) {
        return COOLDOWN_MS;
      }
      const base = 1000 * Math.pow(2, attemptsMade - 1);
      const jitter = Math.random() * RETRY_JITTER_MS;
      return Math.round(base + jitter);
    },
  },
});

deliveryWorker.on("failed", async (job, err) => {
  if (!job) {
    logger.error("Worker job failed before BullMQ provided job context", {
      error: err.message,
    });
    return;
  }

  // Do not escalate to DLQ if delayed by circuit breaker
  if (err && (err.name === "DelayedError" || err.message?.startsWith("CIRCUIT_OPEN"))) {
    return;
  }

  if (job.attemptsMade >= MAX_DELIVERY_ATTEMPTS) {
    logger.error(
      `Job ${job.id} permanently failed — moving to dead letter queue`,
      {
        subscriberUrl: job.data.subscriberUrl,
        eventId: job.data.eventId,
        totalAttempts: job.attemptsMade,
      },
    );

    try {
      await deadLetterQueue.add(
        "failed-delivery",
        {
          ...job.data,
          failureReason: err.message,
          originalJobId: job.id,
          failedAt: new Date().toISOString(),
        },
        {
          jobId: `dead-letter:${job.id}`,
        },
      );
    } catch (deadLetterErr) {
      logger.error("Failed to enqueue dead-letter job", {
        originalJobId: job.id,
        error: deadLetterErr.message,
      });
    }
  }
});

deliveryWorker.on("completed", (job) => {
  logger.info(`Job ${job.id} completed`);
});

deliveryWorker.on("error", (err) => {
  logger.error("Worker error", { error: err.message });
});

// Graceful shutdown — wait for active jobs to finish before exiting
const shutdown = async (signal) => {
  logger.info(`Received ${signal} — closing worker gracefully`);
  try {
    stopDLQMonitor();
    await deliveryWorker.close();
    logger.info("Worker closed cleanly");
    process.exit(0);
  } catch (err) {
    logger.error("Error during worker shutdown", { error: err.message });
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const startWorker = async () => {
  await connectDB();
  startDLQMonitor();
  logger.info("Delivery worker started — waiting for jobs", {
    concurrency: workerConcurrency,
  });
};

if (require.main === module) {
  startWorker().catch((err) => {
    logger.error("Failed to start worker", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });
}

module.exports = {
  deliveryWorker,
  processDeliveryJob,
};
