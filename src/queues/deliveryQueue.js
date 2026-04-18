const { Queue } = require('bullmq')
const redisConnection = require('../config/redis')

// Main delivery queue — jobs flow through here to the worker
const deliveryQueue = new Queue('webhook-delivery', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000           // 1s → 2s → 4s → 8s → 16s
    },
    removeOnComplete: 100,  // keep last 100 completed jobs
    removeOnFail: 200       // keep last 200 failed jobs
  }
})

// Dead letter queue — permanently failed deliveries land here.
// removeOnFail is set so that jobs that fail inside the DLQ itself
// (rare but possible) do not accumulate in Redis indefinitely.
const deadLetterQueue = new Queue('webhook-dead-letter', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 200
  }
})

module.exports = { deliveryQueue, deadLetterQueue }