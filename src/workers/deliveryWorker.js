require("dotenv").config();
const { Worker } = require("bullmq");
const axios = require("axios");
const redisConnection = require("../config/redis");
const connectDB = require("../config/db");
const logger = require("../config/logger");
const DeliveryLog = require("../models/DeliveryLog");
const Subscriber = require("../models/Subscriber");
const { deadLetterQueue, MAX_DELIVERY_ATTEMPTS } = require("../queues/deliveryQueue");
const { generateSignature } = require("../utils/hmac");
const { decrypt } = require("../utils/encryption");
const { validateNoSSRF } = require("../utils/ssrf");
const { assertValidDeliveryJobData } = require("../utils/jobSchema");

const RETRY_JITTER_MS = Number(process.env.RETRY_JITTER_MS) || 500;
// Single application-level timeout for all outbound webhook requests.
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS) || 5000;

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

  // 2. SSRF destination validation immediately before outbound request
  await validateNoSSRF(subscriberUrl);

  // 3. Fetch subscriber and decrypt secret
  const subscriber = await Subscriber.findById(subscriberId).select(
    "signingKey isActive",
  );
  if (!subscriber || !subscriber.isActive) {
    throw new Error(`Subscriber ${subscriberId} is inactive or not found`);
  }

  const signingKey = decrypt(subscriber.signingKey);

  const bodyBuffer = Buffer.from(JSON.stringify(payload));
  const timestamp = Date.now();
  const signature = generateSignature(bodyBuffer, signingKey, timestamp);

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
      timeout: WEBHOOK_TIMEOUT_MS,
      maxRedirects: 0, // Prevent redirect-based SSRF bypass
    });

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
    // Exponential backoff with random jitter to avoid thundering herds
    backoffStrategy: (attemptsMade) => {
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
