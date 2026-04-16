const express = require('express')
const router = express.Router()
const Event = require('../models/Event')
const Subscriber = require('../models/Subscriber')
const { deliveryQueue } = require('../queues/deliveryQueue')
const logger = require('../config/logger')

// POST /events
// Accept an incoming event, find matching subscribers, queue deliveries
router.post('/', async (req, res) => {
  const { type, payload } = req.body

  if (!type || !payload) {
    return res.status(400).json({ error: 'type and payload are required' })
  }

  try {
    // 1. Persist the event
    const event = await Event.create({ type, payload })

    // 2. Find all active subscribers for this event type
    const subscribers = await Subscriber.find({
      events: type,
      isActive: true
    })

    if (subscribers.length === 0) {
      logger.info('Event received but no subscribers found', { type })
      return res.status(202).json({
        message: 'Event accepted — no active subscribers for this event type',
        eventId: event._id,
        jobsQueued: 0
      })
    }

    // 3. Queue one delivery job per subscriber
    const jobs = subscribers.map(subscriber => ({
      name: 'deliver',
      data: {
        eventId: event._id.toString(),
        subscriberId: subscriber._id.toString(),
        subscriberUrl: subscriber.subscriberUrl,
        payload,
        secret: subscriber.secret
      }
    }))

    await deliveryQueue.addBulk(jobs)

    logger.info('Event queued for delivery', {
      eventId: event._id,
      type,
      jobsQueued: subscribers.length
    })

    // 202 Accepted — not 200 — because delivery is async, not yet complete
    res.status(202).json({
      message: 'Event accepted and queued for delivery',
      eventId: event._id,
      jobsQueued: subscribers.length
    })

  } catch (err) {
    logger.error('Failed to process event', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router