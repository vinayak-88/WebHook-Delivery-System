const express = require('express')
const router = express.Router()

// Bug fix: import paths must match the actual filename casing exactly.
// On Linux (Docker/CI), the filesystem is case-sensitive. Event.js and
// Subscriber.js are PascalCase — lowercase imports fail at runtime with
// MODULE_NOT_FOUND even though they appear to work on macOS.
const Event = require('../models/Event')
const Subscriber = require('../models/Subscriber')
const logger = require('../config/logger')
const { queueEventDeliveries } = require('../utils/eventQueue')

// POST /events
// Accept an incoming event, find matching subscribers, queue deliveries
router.post('/', async (req, res) => {
  const { type, payload } = req.body

  if (typeof type !== 'string' || !type.trim() || payload === undefined) {
    return res.status(400).json({ error: 'type and payload are required' })
  }

  // Gap fix: validate event type format — must follow "noun.verb" convention
  // to prevent typo mismatches between producers and subscribers.
  // e.g. "payment.success" is valid, "paymentsuccess" or "PAYMENT_SUCCESS" are not.
  const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/
  if (!EVENT_TYPE_RE.test(type.trim())) {
    return res.status(400).json({
      error: 'type must follow the "noun.verb" format (e.g. "payment.success")'
    })
  }

  try {
    // Snapshot the intended recipients at ingestion time so recovery
    // can replay the exact fan-out even if subscriber records change later.
    const subscribers = await Subscriber.find({
      events: type,
      isActive: true
    })

    const event = await Event.create({
      type,
      payload,
      // Bug fix: removed `secret: subscriber.secret` which was always
      // undefined — `secret` is a virtual setter on the Subscriber schema,
      // not a stored field, so reading it back from a saved document returns
      // undefined. The Event.deliveryTargets schema has no secret field by
      // design (worker fetches it from the Subscriber at delivery time).
      deliveryTargets: subscribers.map((subscriber) => ({
        subscriberId: subscriber._id,
        subscriberUrl: subscriber.subscriberUrl
      }))
    })

    try {
      const queueResult = await queueEventDeliveries(event)

      if (queueResult.jobsQueued === 0) {
        logger.info('Event received but no subscribers found', {
          type,
          eventId: event._id
        })

        return res.status(202).json({
          message: 'Event accepted — no active subscribers for this event type',
          eventId: event._id,
          jobsQueued: 0
        })
      }

      logger.info('Event queued for delivery', {
        eventId: event._id,
        type,
        jobsQueued: queueResult.jobsQueued
      })

      return res.status(202).json({
        message: 'Event accepted and queued for delivery',
        eventId: event._id,
        jobsQueued: queueResult.jobsQueued
      })
    } catch (err) {
      logger.warn('Event accepted but queueing deferred to recovery loop', {
        eventId: event._id,
        type,
        error: err.message
      })

      return res.status(202).json({
        message: 'Event accepted; delivery queue is temporarily unavailable and recovery will retry automatically',
        eventId: event._id,
        jobsQueued: 0,
        recoveryScheduled: true
      })
    }
  } catch (err) {
    logger.error('Failed to process event', { error: err.message })
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router