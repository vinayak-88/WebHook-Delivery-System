const { Queue } = require('bullmq')
const redisConnection = require('../config/redis')
const MAX_DELIVERY_ATTEMPTS = 5

// Main delivery queue — jobs flow through here to the worker
const deliveryQueue = new Queue('webhook-delivery', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: MAX_DELIVERY_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: 1000           // 1s → 2s → 4s → 8s
    },
    removeOnComplete: 100,  // keep last 100 completed jobs
    removeOnFail: 200       // keep last 200 failed jobs
  }
})

// Dead letter queue — permanently failed deliveries land here.
const deadLetterQueue = new Queue('webhook-dead-letter', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 200
  }
})

module.exports = { deliveryQueue, deadLetterQueue, MAX_DELIVERY_ATTEMPTS }