const express = require('express')
const router = express.Router()
const Subscriber = require('../models/subscriber')
const DeliveryLog = require('../models/deliveryLog')
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
    new URL(subscriberUrl)
  } catch {
    return res.status(400).json({ error: 'subscriberUrl must be a valid URL' })
  }

  try {
    const subscriber = await new Subscriber({
      subscriberUrl,
      events,
      secret  // hits the virtual setter on the schema, gets hashed in pre-save
    }).save()

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
    // Duplicate subscriberUrl + events combination
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'A subscriber with this URL and event combination already exists'
      })
    }
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
// View delivery history for a subscriber with pagination.
// Query params: page (default 1), limit (default 50, max 100)
router.get('/:id/logs', async (req, res) => {
  try {
    const subscriber = await Subscriber.findById(req.params.id)

    if (!subscriber) {
      return res.status(404).json({ error: 'Subscriber not found' })
    }

    const page = Math.max(Number(req.query.page) || 1, 1)
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const skip = (page - 1) * limit

    const [logs, total] = await Promise.all([
      DeliveryLog.find({ subscriberId: req.params.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('eventId', 'type payload createdAt'),
      DeliveryLog.countDocuments({ subscriberId: req.params.id })
    ])

    res.json({
      subscriberId: req.params.id,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      logs
    })

  } catch (err) {
    logger.error('Failed to fetch delivery logs', { error: err.message })
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router