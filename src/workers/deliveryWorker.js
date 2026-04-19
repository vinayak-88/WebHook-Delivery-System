require('dotenv').config()
const { Worker } = require('bullmq')
const axios = require('axios')
const redisConnection = require('../config/redis')
const connectDB = require('../config/db')
const logger = require('../config/logger')
const DeliveryLog = require('../models/deliveryLog')
const Subscriber = require('../models/subscriber')
const { deadLetterQueue } = require('../queues/deliveryQueue')
const { generateSignature } = require('../utils/hmac')

// Bug fix: import the queue config constant so maxAttempts is always in
// sync with deliveryQueue.js. Previously the worker used
// job.opts?.attempts ?? 5 — but BullMQ does not copy defaultJobOptions
// into individual job.opts, so job.opts.attempts is always undefined and
// the fallback of 5 was correct only by coincidence.
const { MAX_DELIVERY_ATTEMPTS } = require('../queues/deliveryQueue')

const buildLogPayload = ({
  eventId,
  subscriberId,
  subscriberUrl,
  attemptNumber,
  statusCode,
  responseBody,
  success,
  errorMessage
}) => ({
  eventId,
  subscriberId,
  subscriberUrl,
  attemptNumber,
  statusCode,
  responseBody,
  success,
  errorMessage
})

const persistDeliveryLog = async (logPayload, { rethrowOnFailure = false } = {}) => {
  try {
    await DeliveryLog.create(logPayload)
  } catch (err) {
    logger.error('Failed to persist delivery log', {
      eventId: logPayload.eventId,
      subscriberId: logPayload.subscriberId,
      attemptNumber: logPayload.attemptNumber,
      success: logPayload.success,
      error: err.message
    })

    if (rethrowOnFailure) {
      throw err
    }
  }
}

const processDeliveryJob = async (job) => {
  const { eventId, subscriberId, subscriberUrl, payload } = job.data
  const attemptNumber = job.attemptsMade + 1

  logger.info(`Delivering job ${job.id}`, {
    attempt: attemptNumber,
    subscriberUrl,
    eventId
  })

  // Bug fix: fetch signingKey, not secretHash.
  // secretHash is a bcrypt hash — it cannot be used as an HMAC key because
  // the subscriber has the plaintext and derives the same key independently.
  // signingKey is a deterministic HKDF-SHA256 derivative of the plaintext
  // stored on the Subscriber document, so the worker never needs the
  // plaintext itself while still producing a verifiable signature.
  const subscriber = await Subscriber.findById(subscriberId).select('signingKey')
  if (!subscriber) {
    // Subscriber was hard-deleted — nothing to deliver to, fail permanently
    throw new Error(`Subscriber ${subscriberId} not found — cannot sign delivery`)
  }

  // Sign the exact bytes that will be sent over the wire.
  // bodyBuffer is passed directly to axios so the signed bytes and the
  // wire bytes are the same buffer — eliminates the implicit double-stringify
  // that occurred when axios.post received a plain object and re-serialised it.
  const bodyBuffer = Buffer.from(JSON.stringify(payload))
  const signature = generateSignature(bodyBuffer, subscriber.signingKey)

  try {
    const response = await axios.post(subscriberUrl, bodyBuffer, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event-Id': eventId,
        'X-Webhook-Attempt': attemptNumber
      },
      timeout: 5000
    })

    await persistDeliveryLog(buildLogPayload({
      eventId,
      subscriberId,
      subscriberUrl,
      attemptNumber,
      statusCode: response.status,
      responseBody: JSON.stringify(response.data),
      success: true,
      errorMessage: null
    }))

    logger.info(`Job ${job.id} delivered successfully`, {
      attempt: attemptNumber,
      statusCode: response.status
    })

    return response
  } catch (err) {
    const statusCode = err.response ? err.response.status : null
    const responseBody = err.response ? JSON.stringify(err.response.data) : null
    const errorMessage = err.message

    if (err.response) {
      logger.warn(`Job ${job.id} failed — subscriber returned error`, {
        attempt: attemptNumber,
        statusCode
      })
    } else {
      logger.warn(`Job ${job.id} failed — network error`, {
        attempt: attemptNumber,
        error: err.message
      })
    }

    await persistDeliveryLog(buildLogPayload({
      eventId,
      subscriberId,
      subscriberUrl,
      attemptNumber,
      statusCode,
      responseBody,
      success: false,
      errorMessage
    }))

    throw err
  }
}

const deliveryWorker = new Worker('webhook-delivery', processDeliveryJob, {
  connection: redisConnection,
  concurrency: 5
})

deliveryWorker.on('failed', async (job, err) => {
  if (!job) {
    logger.error('Worker job failed before BullMQ provided job context', {
      error: err.message
    })
    return
  }

  // Bug fix: use the exported constant from deliveryQueue.js instead of
  // job.opts?.attempts. BullMQ does not propagate defaultJobOptions into
  // job.opts, so job.opts.attempts is always undefined at runtime.
  if (job.attemptsMade >= MAX_DELIVERY_ATTEMPTS) {
    logger.error(`Job ${job.id} permanently failed — moving to dead letter queue`, {
      subscriberUrl: job.data.subscriberUrl,
      eventId: job.data.eventId,
      totalAttempts: job.attemptsMade
    })

    try {
      await deadLetterQueue.add('failed-delivery', {
        ...job.data,
        failureReason: err.message,
        originalJobId: job.id,
        failedAt: new Date().toISOString()
      }, {
        jobId: `dead-letter:${job.id}`
      })
    } catch (deadLetterErr) {
      logger.error('Failed to enqueue dead-letter job', {
        originalJobId: job.id,
        error: deadLetterErr.message
      })
    }
  }
})

deliveryWorker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed`)
})

deliveryWorker.on('error', (err) => {
  logger.error('Worker error', { error: err.message })
})

// Graceful shutdown — wait for active jobs to finish before exiting.
const shutdown = async (signal) => {
  logger.info(`Received ${signal} — closing worker gracefully`)
  try {
    await deliveryWorker.close()
    logger.info('Worker closed cleanly')
    process.exit(0)
  } catch (err) {
    logger.error('Error during worker shutdown', { error: err.message })
    process.exit(1)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const startWorker = async () => {
  await connectDB()
  logger.info('Delivery worker started — waiting for jobs')
}

if (require.main === module) {
  startWorker().catch((err) => {
    logger.error('Failed to start worker', { error: err.message, stack: err.stack })
    process.exit(1)
  })
}

module.exports = {
  deliveryWorker,
  processDeliveryJob
}