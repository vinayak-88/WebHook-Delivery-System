const express = require('express')
const router = express.Router()

// Bug fix: PascalCase imports to match actual filenames on Linux filesystems
const Subscriber = require('../models/Subscriber')
const DeliveryLog = require('../models/DeliveryLog')
const logger = require('../config/logger')

// Gap fix: minimum secret length for meaningful HMAC security.
// HMAC-SHA256 has a 64-byte block size. Secrets shorter than 32 chars
// are trivially brute-forceable — enforce a floor.
const SECRET_MIN_LENGTH = 32

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

  // Gap fix: validate every event type string in the array against the same
  // "noun.verb" convention enforced on the producer side in events.js.
  // Without this, a subscriber can register with "PAYMENT_SUCCESS" or ""
  // and silently never receive any deliveries because the string will never
  // match a fired event type.
  const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/
  const invalidEvents = events.filter(e => typeof e !== 'string' || !EVENT_TYPE_RE.test(e.trim()))
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error: 'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
      invalid: invalidEvents
    })
  }

  // Gap fix: enforce minimum secret length
  if (typeof secret !== 'string' || secret.length < SECRET_MIN_LENGTH) {
    return res.status(400).json({
      error: `secret must be at least ${SECRET_MIN_LENGTH} characters`
    })
  }

  try {
    const parsed = new URL(subscriberUrl)
    // Gap fix: enforce HTTPS. Allowing HTTP means webhook payloads and
    // HMAC signatures travel in plaintext — an attacker on the same network
    // can intercept both, breaking the security guarantee HMAC provides.
    // Allow HTTP only in non-production environments (local dev / testing).
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      return res.status(400).json({ error: 'subscriberUrl must use HTTPS in production' })
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(400).json({ error: 'subscriberUrl must be a valid HTTP or HTTPS URL' })
    }
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