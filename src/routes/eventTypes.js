const express = require('express');
const router = express.Router();
const EventType = require('../models/EventType');
const authenticateAdmin = require('../middlewares/authenticateAdmin');
const logger = require('../config/logger');

const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

// GET /event-types - list active event types (public or admin, let's allow inspection)
router.get('/', async (req, res) => {
  try {
    const types = await EventType.find({ isActive: true })
      .select('name description createdAt')
      .sort({ name: 1 });
    res.json({ count: types.length, eventTypes: types });
  } catch (err) {
    logger.error('Failed to list event types', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /event-types - register a new event type (Admin only)
router.post('/', authenticateAdmin, async (req, res) => {
  const { name, description } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const trimmedName = name.trim();
  if (!EVENT_TYPE_RE.test(trimmedName)) {
    return res.status(400).json({
      error: 'Event type name must follow noun.verb format (e.g. "payment.success")',
    });
  }

  try {
    const existing = await EventType.findOne({ name: trimmedName });
    if (existing) {
      if (existing.isActive) {
        return res.status(409).json({ error: `Event type "${trimmedName}" is already registered` });
      }
      existing.isActive = true;
      if (description !== undefined) existing.description = description;
      await existing.save();
      return res.status(200).json({
        message: 'Event type reactivated successfully',
        eventType: existing,
      });
    }

    const eventType = await EventType.create({
      name: trimmedName,
      description: description || '',
    });

    logger.info('Event type registered', { name: trimmedName });
    return res.status(201).json({
      message: 'Event type registered successfully',
      eventType,
    });
  } catch (err) {
    logger.error('Failed to register event type', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /event-types/:name - deactivate an event type (Admin only)
router.delete('/:name', authenticateAdmin, async (req, res) => {
  const { name } = req.params;
  try {
    const eventType = await EventType.findOne({ name });
    if (!eventType) {
      return res.status(404).json({ error: 'Event type not found' });
    }

    eventType.isActive = false;
    await eventType.save();

    logger.info('Event type deactivated', { name });
    res.json({ message: `Event type "${name}" deactivated successfully` });
  } catch (err) {
    logger.error('Failed to deactivate event type', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
