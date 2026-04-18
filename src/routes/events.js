const express = require('express')
const router = express.Router()
const Event = require('../models/event')
const Subscriber = require('../models/subscriber')
const logger = require('../config/logger')
const { queueEventDeliveries } = require('../utils/eventQueue')

// POST /events
// Accept an incoming event, find matching subscribers, queue deliveries
router.post('/', async (req, res) => {
  const { type, payload } = req.body

  if (typeof type !== 'string' || !type.trim() || payload === undefined) {
    return res.status(400).json({ error: 'type and payload are required' })
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
      deliveryTargets: subscribers.map((subscriber) => ({
        subscriberId: subscriber._id,
        subscriberUrl: subscriber.subscriberUrl,
        secret: subscriber.secret
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
