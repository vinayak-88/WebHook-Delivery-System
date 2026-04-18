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
  // Secret is intentionally NOT stored in job.data or the Event document.
  // Fetch it fresh from the Subscriber collection at delivery time.
  const { eventId, subscriberId, subscriberUrl, payload } = job.data
  const attemptNumber = job.attemptsMade + 1

  logger.info(`Delivering job ${job.id}`, {
    attempt: attemptNumber,
    subscriberUrl,
    eventId
  })

  const subscriber = await Subscriber.findById(subscriberId).select('secretHash')
  if (!subscriber) {
    // Subscriber was hard-deleted — nothing to deliver to, fail permanently
    throw new Error(`Subscriber ${subscriberId} not found — cannot sign delivery`)
  }

  // Sign the exact bytes that will be sent over the wire.
  // Using a Buffer from JSON.stringify ensures the same byte sequence
  // is signed and can be independently verified by the subscriber.
  const bodyBuffer = Buffer.from(JSON.stringify(payload))
  const signature = generateSignature(bodyBuffer, subscriber.secretHash)

  try {
    const response = await axios.post(subscriberUrl, payload, {
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

  // job.opts.attempts may be undefined in some BullMQ versions if
  // defaultJobOptions are not merged into job.opts — fall back to 5
  const maxAttempts = job.opts?.attempts ?? 5

  if (job.attemptsMade >= maxAttempts) {
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
// Without this, Docker/OS SIGTERM would interrupt in-flight deliveries,
// causing BullMQ to re-enqueue them and potentially deliver twice.
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