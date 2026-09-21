const express = require("express");
const router = express.Router();

const Subscriber = require("../models/Subscriber");
const DeliveryLog = require("../models/DeliveryLog");
const logger = require("../config/logger");
const authenticateSubscriber = require("../middlewares/authenticateSubscriber");
const { generateApiKey, hashKey } = require("../utils/apiKey");
const { validateNoSSRF } = require("../utils/ssrf");

// Secrets shorter than 32 chars are trivially brute-forceable
const SECRET_MIN_LENGTH = 32;
const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

// GET /webhooks - View current subscriber profile
router.get("/", authenticateSubscriber, async (req, res) => {
  const subscriber = req.subscriber;
  res.json({
    subscriberId: subscriber._id,
    subscriberUrl: subscriber.subscriberUrl,
    events: subscriber.events,
    isActive: subscriber.isActive,
    createdAt: subscriber.createdAt,
    updatedAt: subscriber.updatedAt,
  });
});

// POST /webhooks/register - Register a new subscriber
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

  const invalidEvents = events.filter(
    (e) => typeof e !== "string" || !EVENT_TYPE_RE.test(e.trim()),
  );
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error: 'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
      invalid: invalidEvents,
    });
  }

  events = events.map((e) => e.trim());

  if (typeof secret !== "string") {
    return res.status(400).json({
      error: "secret must be of type string",
    });
  }

  if (secret.length < SECRET_MIN_LENGTH) {
    return res.status(400).json({
      error: `secret must be at least ${SECRET_MIN_LENGTH} characters`,
    });
  }

  // SSRF & protocol validation
  try {
    await validateNoSSRF(subscriberUrl.trim());
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Generate 32-byte API key and store SHA-256 hash
  const rawApiKey = generateApiKey();
  const hashedApiKey = hashKey(rawApiKey);

  try {
    const subscriber = new Subscriber({
      subscriberUrl: subscriberUrl.trim(),
      events,
      apiSecret: hashedApiKey,
      secret, // Hits virtual setter: encrypts using AES-256-GCM
    });

    await subscriber.save();

    logger.info("Subscriber registered", {
      subscriberId: subscriber._id,
      subscriberUrl: subscriber.subscriberUrl,
      events,
    });

    res.status(201).json({
      message: "Subscriber registered successfully",
      subscriberId: subscriber._id,
      subscriberUrl: subscriber.subscriberUrl,
      events: subscriber.events,
      apiKey: rawApiKey,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: "A subscriber with this URL already exists",
      });
    }
    logger.error("Failed to register subscriber", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /webhooks - Update subscriber configuration (URL, events)
router.patch("/", authenticateSubscriber, async (req, res) => {
  const subscriber = req.subscriber;
  const { subscriberUrl, events } = req.body;

  if (
    req.body.subscriberId !== undefined ||
    req.body.apiSecret !== undefined ||
    req.body.signingKey !== undefined
  ) {
    return res.status(400).json({
      error: "Cannot update subscriberId, apiSecret, or signingKey via this endpoint",
    });
  }

  if (
    subscriberUrl === undefined &&
    events === undefined
  ) {
    return res.status(400).json({
      error: "At least one of subscriberUrl or events must be provided",
    });
  }

  // Validate subscriberUrl if provided
  if (subscriberUrl !== undefined) {
    if (typeof subscriberUrl !== "string" || !subscriberUrl.trim()) {
      return res.status(400).json({ error: "subscriberUrl must be a non-empty string" });
    }
    try {
      await validateNoSSRF(subscriberUrl.trim());
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    subscriber.subscriberUrl = subscriberUrl.trim();
  }

  // Validate events if provided
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: "events must be a non-empty array" });
    }
    const invalidEvents = events.filter(
      (e) => typeof e !== "string" || !EVENT_TYPE_RE.test(e.trim()),
    );
    if (invalidEvents.length > 0) {
      return res.status(400).json({
        error: 'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
        invalid: invalidEvents,
      });
    }
    const trimmedEvents = events.map((e) => e.trim());
    subscriber.events = trimmedEvents;
  }

  try {
    await subscriber.save();
    logger.info("Subscriber configuration updated", {
      subscriberId: subscriber._id,
      subscriberUrl: subscriber.subscriberUrl,
      events: subscriber.events,
    });

    res.json({
      message: "Subscriber updated successfully",
      subscriberId: subscriber._id,
      subscriberUrl: subscriber.subscriberUrl,
      events: subscriber.events,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "A subscriber with this URL already exists" });
    }
    logger.error("Failed to update subscriber", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /webhooks/events - Update subscribed events only
router.patch("/events", authenticateSubscriber, async (req, res) => {
  let { events } = req.body;
  const subscriber = req.subscriber;

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
      error: 'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
      invalid: invalidEvents,
    });
  }

  events = events.map((e) => e.trim());

  try {
    subscriber.events = events;
    await subscriber.save();

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
      error: "Failed to update events",
      events,
    });
  }
});

// DELETE /webhooks - Deactivate subscriber
router.delete("/", authenticateSubscriber, async (req, res) => {
  const subscriber = req.subscriber;
  try {
    subscriber.isActive = false;
    await subscriber.save();

    logger.info("Subscriber deactivated", { subscriberId: subscriber._id });
    res.json({ message: "Subscriber deactivated successfully" });
  } catch (err) {
    logger.error("Failed to deactivate subscriber", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /webhooks/logs - View delivery history for authenticated subscriber
router.get("/logs", authenticateSubscriber, async (req, res) => {
  const subscriber = req.subscriber;
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      DeliveryLog.find({ subscriberId: subscriber._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("eventId", "type payload createdAt requestId"),
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
