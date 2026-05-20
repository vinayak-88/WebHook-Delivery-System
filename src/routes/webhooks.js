const express = require("express");
const router = express.Router();

const Subscriber = require("../models/Subscriber");
const DeliveryLog = require("../models/DeliveryLog");
const logger = require("../config/logger");
const authenticateSubscriber = require("../middlewares/authenticateSubscriber");
const { generateApiKey, hashKey } = require("../utils/apiKey");

//Secrets shorter than 32 chars are trivially brute-forceable
const SECRET_MIN_LENGTH = 32;
const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

// POST /webhooks/register
// Register a new subscriber
router.post("/register", async (req, res) => {
  let { subscriberUrl, events, secret } = req.body;

  if (!subscriberUrl || !subscriberUrl.trim() || !events || !secret) {
    return res.status(400).json({
      error: "subscriberUrl, events, and secret are required",
    });
  }

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({
      error: "events must be a non-empty array",
    });
  }

  //only a certain type of event nomenclature is allowed : payment.success(example)
  const invalidEvents = events.filter(
    (e) => typeof e !== "string" || !EVENT_TYPE_RE.test(e.trim()),
  );
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error:
        'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
      invalid: invalidEvents,
    });
  }

  events = events.map((e) => e.trim());

  if (typeof secret !== "string") {
    return res.status(400).json({
      error: "secret must be of type string",
    });
  }

  //minimum secret length check
  if (secret.length < SECRET_MIN_LENGTH) {
    return res.status(400).json({
      error: `secret must be at least ${SECRET_MIN_LENGTH} characters`,
    });
  }

  try {
    const parsed = new URL(subscriberUrl);
    //allow only https so that secrets are encrypted
    if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
      return res
        .status(400)
        .json({ error: "subscriberUrl must use HTTPS in production" });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return res
        .status(400)
        .json({ error: "subscriberUrl must be a valid HTTP or HTTPS URL" });
    }
  } catch {
    return res.status(400).json({ error: "subscriberUrl must be a valid URL" });
  }

  //generate an api key of 32 bytes
  const rawSecret = generateApiKey();

  //hash that string to store in db
  const hashedSecret = hashKey(rawSecret);

  try {
    const subscriber = await new Subscriber({
      subscriberUrl,
      events,
      apiSecret : hashedSecret,
      secret, // hits the virtual setter on the schema
    }).save();

    logger.info("Subscriber registered", {
      subscriberId: subscriber._id,
      subscriberUrl,
      events,
    });

    res.status(201).json({
      message: "Subscriber registered successfully",
      subscriberId: subscriber._id,
      subscriberUrl: subscriber.subscriberUrl,
      events: subscriber.events,
      apiKey : rawSecret
    });
  } catch (err) {
    // Duplicate subscriberUrl
    if (err.code === 11000) {
      return res.status(409).json({
        error: "A subscriber with this URL already exists",
      });
    }
    logger.error("Failed to register subscriber", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/events", authenticateSubscriber, async (req, res) => {
  let { events } = req.body;
  let subscriber = req.subscriber;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({
      error: "events must be a non-empty array",
    });
  }

  const invalidEvents = events.filter(
    (e) => typeof e !== "string" || !EVENT_TYPE_RE.test(e.trim()),
  );
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error:
        'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
      invalid: invalidEvents,
    });
  }

  events = events.map((e) => e.trim());

  try {
    subscriber.events = events;
    subscriber = await subscriber.save();

    logger.info("Subscriber events update", {
      subscriberId: subscriber._id,
      events,
    });
    return res.status(200).json({
      message: "Events updated successfully",
      events,
    });
  } catch (error) {
    logger.error("Failed to update events", { error: error.message });
    return res.status(500).json({
      message: "Failed to update events",
      events,
    });
  }
});

// DELETE /webhooks/:id
// Deactivate a subscriber
router.delete("/", authenticateSubscriber, async (req, res) => {
  let subscriber = req.subscriber
  try {
    subscriber.isActive = false
    subscriber = await subscriber.save();

    logger.info("Subscriber deactivated", { subscriberId: subscriber._id });
    res.json({ message: "Subscriber deactivated successfully" });
  } catch (err) {
    logger.error("Failed to deactivate subscriber", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /webhooks/:id/logs
// View delivery history for a subscriber with pagination.
router.get("/logs", authenticateSubscriber, async (req, res) => {
  let subscriber = req.subscriber
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      DeliveryLog.find({ subscriberId: subscriber._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("eventId", "type payload createdAt"),
      DeliveryLog.countDocuments({ subscriberId: subscriber._id }),
    ]);

    res.json({
      subscriberId: subscriber._id,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      logs,
    });
  } catch (err) {
    logger.error("Failed to fetch delivery logs", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
