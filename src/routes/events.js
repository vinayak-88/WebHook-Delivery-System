const express = require("express");
const router = express.Router();
const Event = require("../models/Event");
const Subscriber = require("../models/Subscriber");
const logger = require("../config/logger");
const { queueEventDeliveries } = require("../utils/eventQueue");
const authenticateProducer = require("../middlewares/authenticateProducer");

// POST /events
// Accept an incoming event, find matching subscribers, queue deliveries
router.post("/", authenticateProducer, async (req, res) => {
  const { type, payload } = req.body;

  if (
    typeof type !== "string" ||
    !type.trim() ||
    payload === undefined ||
    payload === null
  ) {
    return res.status(400).json({ error: "type and payload are required" });
  }

  const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
  if (!EVENT_TYPE_RE.test(type.trim())) {
    return res.status(400).json({
      error: 'type must follow the "noun.verb" format (e.g. "payment.success")',
    });
  }

  const producer = req.producer;
  if (!producer.allowedEvents.includes(type.trim())) {
    return res.status(403).json({
      error: `Producer is not authorized to fire event type: ${type}`,
    });
  }

  try {
    const subscribers = await Subscriber.find({
      events: type,
      isActive: true,
    });

    //no check for subscriber found to maintain audit trail that event arrived by creating event instance in db

    const event = await Event.create({
      type,
      payload,
      deliveryTargets: subscribers.map((subscriber) => ({
        subscriberId: subscriber._id,
        subscriberUrl: subscriber.subscriberUrl,
      })),
    });

    try {
      const queueResult = await queueEventDeliveries(event);

      if (queueResult.jobsQueued === 0) {
        logger.info("Event received but no subscribers found", {
          type,
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
        type,
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
        type,
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
