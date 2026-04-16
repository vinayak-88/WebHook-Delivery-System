require('dotenv').config()
const { Worker } = require('bullmq')
const axios = require('axios')
const redisConnection = require('../config/redis')
const connectDB = require('../config/db')
const logger = require('../config/logger')
const DeliveryLog = require('../models/DeliveryLog')
const { deadLetterQueue } = require('../queues/deliveryQueue')
const { generateSignature } = require('../utils/hmac')

const deliveryWorker = new Worker('webhook-delivery', async (job) => {
  const { eventId, subscriberId, subscriberUrl, payload, secret } = job.data
  const attemptNumber = job.attemptsMade + 1

  logger.info(`Delivering job ${job.id}`, {
    attempt: attemptNumber,
    subscriberUrl,
    eventId
  })

  // Sign the payload before delivery
  const signature = generateSignature(payload, secret)

  let statusCode = null
  let responseBody = null
  let success = false
  let errorMessage = null

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

    statusCode = response.status
    responseBody = JSON.stringify(response.data)
    success = true

    logger.info(`Job ${job.id} delivered successfully`, {
      attempt: attemptNumber,
      statusCode
    })

  } catch (err) {
    errorMessage = err.message

    if (err.response) {
      // Subscriber responded with an error status
      statusCode = err.response.status
      responseBody = JSON.stringify(err.response.data)
      logger.warn(`Job ${job.id} failed — subscriber returned error`, {
        attempt: attemptNumber,
        statusCode
      })
    } else {
      // Network-level failure (timeout, DNS, connection refused)
      logger.warn(`Job ${job.id} failed — network error`, {
        attempt: attemptNumber,
        error: err.message
      })
    }

    // Always throw so BullMQ knows to retry
    throw err

  } finally {
    // Log every attempt regardless of outcome
    await DeliveryLog.create({
      eventId,
      subscriberId,
      subscriberUrl,
      attemptNumber,
      statusCode,
      responseBody,
      success,
      errorMessage
    })
  }

}, {
  connection: redisConnection,
  concurrency: 5  // process up to 5 jobs simultaneously
})

// When a job exhausts all retry attempts, move it to dead letter queue
deliveryWorker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    logger.error(`Job ${job.id} permanently failed — moving to dead letter queue`, {
      subscriberUrl: job.data.subscriberUrl,
      eventId: job.data.eventId,
      totalAttempts: job.attemptsMade
    })

    await deadLetterQueue.add('failed-delivery', {
      ...job.data,
      failureReason: err.message,
      originalJobId: job.id,
      failedAt: new Date().toISOString()
    })
  }
})

deliveryWorker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed`)
})

deliveryWorker.on('error', (err) => {
  logger.error('Worker error', { error: err.message })
})

// Start worker as standalone process
const start = async () => {
  await connectDB()
  logger.info('Delivery worker started — waiting for jobs')
}

start()

module.exports = deliveryWorker