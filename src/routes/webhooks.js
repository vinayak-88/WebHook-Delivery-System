const express = require('express')
const router = express.Router()
const Subscriber = require('../models/Subscriber')
const DeliveryLog = require('../models/DeliveryLog')
const logger = require('../config/logger')

// POST /webhooks/register
// Register a new subscriber
router.post('/register', async (req, res) => {
  const { subscriberUrl, events, secret } = req.body

  if (!subscriberUrl || !events || !secret) {
    return res.status(400).json({
      error: 'subscriberUrl, events, and secret are required'
    })
  }

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({
      error: 'events must be a non-empty array'
    })
  }

  try {
    const subscriber = await Subscriber.create({ subscriberUrl, events, secret })

    logger.info('Subscriber registered', {
      subscriberId: subscriber._id,
      subscriberUrl,
      events
    })

    res.status(201).json({
      message: 'Subscriber registered successfully',
      subscriberId: subscriber._id,
      subscriberUrl: subscriber.subscriberUrl,
      events: subscriber.events
    })

  } catch (err) {
    logger.error('Failed to register subscriber', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /webhooks/:id
// Deactivate a subscriber
router.delete('/:id', async (req, res) => {
  try {
    const subscriber = await Subscriber.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    )

    if (!subscriber) {
      return res.status(404).json({ error: 'Subscriber not found' })
    }

    logger.info('Subscriber deactivated', { subscriberId: req.params.id })
    res.json({ message: 'Subscriber deactivated successfully' })

  } catch (err) {
    logger.error('Failed to deactivate subscriber', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /webhooks/:id/logs
// View delivery history for a subscriber
router.get('/:id/logs', async (req, res) => {
  try {
    const logs = await DeliveryLog.find({ subscriberId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('eventId', 'type payload createdAt')

    res.json({ subscriberId: req.params.id, logs })

  } catch (err) {
    logger.error('Failed to fetch delivery logs', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router