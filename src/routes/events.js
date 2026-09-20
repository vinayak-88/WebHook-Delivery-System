const express = require("express");
const router = express.Router();
const Event = require("../models/Event");
const Subscriber = require("../models/Subscriber");
const logger = require("../config/logger");
const { queueEventDeliveries } = require("../utils/eventQueue");
const authenticateProducer = require("../middlewares/authenticateProducer");
const { validateRegisteredEventTypes } = require("../utils/eventTypeValidator");

const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

// GET /events/:id - retrieve event delivery status (producer-authenticated)
router.get("/:id", authenticateProducer, async (req, res) => {
  const { id } = req.params;
  const producer = req.producer;

  try {
    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Ownership check: if producerId is recorded, ensure requesting producer owns it
    if (event.producerId && !event.producerId.equals(producer._id)) {
      return res.status(403).json({ error: "Access denied: you do not own this event" });
    }

    res.json({
      eventId: event._id,
      producerId: event.producerId || null,
      type: event.type,
      queueStatus: event.queueStatus,
      queuedJobCount: event.queuedJobCount,
      queueEnqueuedAt: event.queueEnqueuedAt,
      deliveryTargetCount: event.deliveryTargets.length,
      deliveryTargets: event.deliveryTargets.map((t) => ({
        subscriberId: t.subscriberId,
        subscriberUrl: t.subscriberUrl,
      })),
      replayCount: event.replayCount || 0,
      lastReplayedAt: event.lastReplayedAt || null,
      lastReplayJobId: event.lastReplayJobId || null,
      requestId: event.requestId || null,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid event ID format" });
    }
    logger.error("Failed to fetch event", { error: err.message, eventId: id });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /events - accept an incoming event, find matching subscribers, queue deliveries
router.post("/", authenticateProducer, async (req, res) => {
  const { type, payload } = req.body;
  const rawIdempotencyKey = req.body.idempotencyKey || req.headers["idempotency-key"];
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : null;

  if (
    typeof type !== "string" ||
    !type.trim() ||
    payload === undefined ||
    payload === null
  ) {
    return res.status(400).json({ error: "type and payload are required" });
  }

  const normalizedType = type.trim();
  if (!EVENT_TYPE_RE.test(normalizedType)) {
    return res.status(400).json({
      error: 'type must follow the "noun.verb" format (e.g. "payment.success")',
    });
  }

  const producer = req.producer;
  if (!producer.allowedEvents.includes(normalizedType)) {
    return res.status(403).json({
      error: `Producer is not authorized to fire event type: ${normalizedType}`,
    });
  }

  // Validate against EventType registry if active or in strict mode
  try {
    await validateRegisteredEventTypes(normalizedType);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  // Check producer-scoped idempotency
  if (idempotencyKey) {
    try {
      const existingEvent = await Event.findOne({
        producerId: producer._id,
        idempotencyKey,
      });

      if (existingEvent) {
        // Verify payload and type match
        const isPayloadMatch =
          JSON.stringify(payload) === JSON.stringify(existingEvent.payload);

        if (existingEvent.type !== normalizedType || !isPayloadMatch) {
          return res.status(409).json({
            error: "Idempotency key already used with different event type or payload",
            eventId: existingEvent._id,
          });
        }

        // Return the existing event details idempotently
        return res.status(200).json({
          message: "Event already accepted (idempotent replay)",
          eventId: existingEvent._id,
          queueStatus: existingEvent.queueStatus,
          jobsQueued: existingEvent.queuedJobCount,
          isDuplicate: true,
        });
      }
    } catch (err) {
      logger.error("Failed to check idempotency key", { error: err.message });
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  try {
    const subscribers = await Subscriber.find({
      events: normalizedType,
      isActive: true,
    });

    let event;
    try {
      event = await Event.create({
        producerId: producer._id,
        idempotencyKey,
        type: normalizedType,
        payload,
        requestId: req.requestId || null,
        deliveryTargets: subscribers.map((subscriber) => ({
          subscriberId: subscriber._id,
          subscriberUrl: subscriber.subscriberUrl,
        })),
      });
    } catch (createErr) {
      // Catch race-condition on compound unique index { producerId, idempotencyKey }
      if (createErr.code === 11000 && idempotencyKey) {
        const raceEvent = await Event.findOne({
          producerId: producer._id,
          idempotencyKey,
        });
        if (raceEvent) {
          return res.status(200).json({
            message: "Event already accepted (idempotent replay)",
            eventId: raceEvent._id,
            queueStatus: raceEvent.queueStatus,
            jobsQueued: raceEvent.queuedJobCount,
            isDuplicate: true,
          });
        }
      }
      throw createErr;
    }

    try {
      const queueResult = await queueEventDeliveries(event);

      if (queueResult.jobsQueued === 0) {
        logger.info("Event received but no subscribers found", {
          type: normalizedType,
          eventId: event._id,
        });

        return res.status(202).json({
          message: "Event accepted — no active subscribers for this event type",
          eventId: event._id,
          jobsQueued: 0,
        });
      }

      logger.info("Event queued for delivery", {
        eventId: event._id,
        type: normalizedType,
        jobsQueued: queueResult.jobsQueued,
      });

      return res.status(202).json({
        message: "Event accepted and queued for delivery",
        eventId: event._id,
        jobsQueued: queueResult.jobsQueued,
      });
    } catch (err) {
      logger.warn("Event accepted but queueing deferred to recovery loop", {
        eventId: event._id,
        type: normalizedType,
        error: err.message,
      });

      return res.status(202).json({
        message:
          "Event accepted; delivery queue is temporarily unavailable and recovery will retry automatically",
        eventId: event._id,
        jobsQueued: 0,
        recoveryScheduled: true,
      });
    }
  } catch (err) {
    logger.error("Failed to process event", { error: err.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
