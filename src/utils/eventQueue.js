const Event = require('../models/event')
const Subscriber = require('../models/subscriber')
const { deliveryQueue } = require('../queues/deliveryQueue')
const logger = require('../config/logger')

const PENDING_QUEUE_STATUS = 'pending'
const QUEUED_QUEUE_STATUS = 'queued'
const NO_SUBSCRIBERS_QUEUE_STATUS = 'no_subscribers'

const getDeliveryTargets = (event) => event.deliveryTargets || []

const snapshotDeliveryTargets = async (event) => {
  const subscribers = await Subscriber.find({
    events: event.type,
    isActive: true
  })

  // Secret is intentionally excluded from the snapshot —
  // it is fetched fresh by the worker at delivery time
  const deliveryTargets = subscribers.map((subscriber) => ({
    subscriberId: subscriber._id,
    subscriberUrl: subscriber.subscriberUrl
  }))

  await markEventQueueState(event._id, { deliveryTargets })
  event.deliveryTargets = deliveryTargets

  return deliveryTargets
}

const buildJobId = (eventId, subscriberId) => (
  `event:${eventId}:subscriber:${subscriberId}`
)

const buildDeliveryJobs = (event) => (
  getDeliveryTargets(event).map((target) => ({
    name: 'deliver',
    data: {
      eventId: event._id.toString(),
      subscriberId: target.subscriberId.toString(),
      subscriberUrl: target.subscriberUrl,
      payload: event.payload
      // secret intentionally omitted — worker fetches it from DB
    },
    opts: {
      jobId: buildJobId(event._id.toString(), target.subscriberId.toString())
    }
  }))
)

const markEventQueueState = async (eventId, updates) => (
  Event.findByIdAndUpdate(eventId, updates, { new: true })
)

const queueEventDeliveries = async (event) => {
  let deliveryTargets = getDeliveryTargets(event)

  // Backfill targets for legacy events that were stored before
  // delivery target snapshots were added to the schema.
  // Only runs when type is present — events without a type (malformed
  // legacy records) fall through to no_subscribers cleanly.
  //
  // NOTE: This backfill is process-local. The isRunning flag in
  // startPendingEventRecovery prevents overlapping ticks within a single
  // process, but does NOT protect against two API instances running
  // simultaneously. In a multi-instance deployment, use a distributed
  // lock (e.g. Redlock) around the recovery scan before scaling out.
  if (deliveryTargets.length === 0 && event.type) {
    deliveryTargets = await snapshotDeliveryTargets(event)
  }

  const jobs = buildDeliveryJobs({
    ...event,
    deliveryTargets
  })

  if (jobs.length === 0) {
    await markEventQueueState(event._id, {
      queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS,
      queuedJobCount: 0,
      queueEnqueuedAt: new Date(),
      lastQueueError: null
    })

    return {
      jobsQueued: 0,
      queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS
    }
  }

  try {
    await deliveryQueue.addBulk(jobs)

    await markEventQueueState(event._id, {
      queueStatus: QUEUED_QUEUE_STATUS,
      queuedJobCount: jobs.length,
      queueEnqueuedAt: new Date(),
      lastQueueError: null
    })

    return {
      jobsQueued: jobs.length,
      queueStatus: QUEUED_QUEUE_STATUS
    }
  } catch (err) {
    await markEventQueueState(event._id, {
      queueStatus: PENDING_QUEUE_STATUS,
      lastQueueError: err.message
    })

    throw err
  }
}

const recoverPendingEvents = async ({ limit = 25 } = {}) => {
  const pendingEvents = await Event.find({ queueStatus: PENDING_QUEUE_STATUS })
    .sort({ createdAt: 1 })
    .limit(limit)

  let recovered = 0

  for (const event of pendingEvents) {
    try {
      await queueEventDeliveries(event)
      recovered++
    } catch (err) {
      logger.warn('Pending event remains queued for recovery', {
        eventId: event._id.toString(),
        error: err.message
      })
    }
  }

  return {
    scanned: pendingEvents.length,
    recovered
  }
}

const startPendingEventRecovery = ({
  intervalMs = Number(process.env.RECOVERY_INTERVAL_MS) || 5000,
  batchSize = Number(process.env.RECOVERY_BATCH_SIZE) || 25
} = {}) => {
  if (intervalMs <= 0) {
    return null
  }

  let isRunning = false

  const runRecovery = async () => {
    if (isRunning) {
      return
    }

    isRunning = true

    try {
      const result = await recoverPendingEvents({ limit: batchSize })

      if (result.recovered > 0) {
        logger.info('Recovered pending events into the delivery queue', result)
      }
    } catch (err) {
      logger.error('Pending event recovery failed', {
        error: err.message,
        stack: err.stack
      })
    } finally {
      isRunning = false
    }
  }

  const timer = setInterval(() => {
    void runRecovery()
  }, intervalMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  void runRecovery()

  return timer
}

module.exports = {
  buildDeliveryJobs,
  buildJobId,
  queueEventDeliveries,
  recoverPendingEvents,
  startPendingEventRecovery,
  PENDING_QUEUE_STATUS,
  QUEUED_QUEUE_STATUS,
  NO_SUBSCRIBERS_QUEUE_STATUS
}