const express = require("express");
const router = express.Router();
const Producer = require("../models/Producer");
const logger = require("../config/logger");
const authenticateProducer = require("../middlewares/authenticateProducer");
const { generateApiKey, hashKey } = require("../utils/apiKey");

const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

router.post("/register", async (req, res) => {
  let { producerUrl, allowedEvents } = req.body;

  if (!producerUrl || !producerUrl.trim() || !allowedEvents) {
    return res.status(400).json({
      error: "producerUrl and allowedEvents are required",
    });
  }

  if (!Array.isArray(allowedEvents) || allowedEvents.length === 0) {
    return res.status(400).json({
      error: "allowedEvents must be a non-empty array",
    });
  }

  //validate the events array
  const invalidEvents = allowedEvents.filter(
    (e) => typeof e !== "string" || !EVENT_TYPE_RE.test(e.trim()),
  );
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error:
        'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
      invalid: invalidEvents,
    });
  }

  allowedEvents = allowedEvents.map((e) => e.trim());

  //validate the producerUrl
  try {
    const parsed = new URL(producerUrl);
    //allow only https so that secrets are encrypted
    if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
      return res
        .status(400)
        .json({ error: "producerUrl must use HTTPS in production" });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return res
        .status(400)
        .json({ error: "producerUrl must be a valid HTTP or HTTPS URL" });
    }
  } catch {
    return res.status(400).json({ error: "producerUrl must be a valid URL" });
  }

  //create a random 32-byte string as a secret
  const rawSecret = generateApiKey();

  //hash that string to store in db
  const hashedSecret = hashKey(rawSecret);

  try {
    const producer = await Producer.create({
      producerUrl,
      apiSecret: hashedSecret,
      allowedEvents,
    });

    logger.info("Producer registered", {
      producerId: producer._id,
      producerUrl,
      allowedEvents,
    });

    res.status(201).json({
      message: "Producer registered successfully",
      producerId: producer._id,
      producerUrl: producer.producerUrl,
      events: producer.allowedEvents,
      apiKey: rawSecret,
    });
  } catch (err) {
    //duplicate producer
    if (err.code === 11000) {
      return res.status(409).json({
        error: "A producer with this URL already exists",
      });
    }
    logger.error("Failed to register producer", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/events", authenticateProducer, async (req, res) => {
  let { allowedEvents } = req.body;
  let producer = req.producer;

  if (!Array.isArray(allowedEvents) || allowedEvents.length === 0) {
    return res.status(400).json({
      error: "allowedEvents must be a non-empty array",
    });
  }

  const invalidEvents = allowedEvents.filter(
    (e) => typeof e !== "string" || !EVENT_TYPE_RE.test(e.trim()),
  );
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error:
        'Each event type must follow the "noun.verb" format (e.g. "payment.success")',
      invalid: invalidEvents,
    });
  }

  allowedEvents = allowedEvents.map((e) => e.trim());

  try {
    producer.allowedEvents = allowedEvents;
    producer = await producer.save();

    logger.info("Producer events update", {
      producerId: producer._id,
      allowedEvents,
    });
    return res.status(200).json({
      message: "Events updated successfully",
      allowedEvents,
    });
  } catch (error) {
    logger.error("Failed to update events", { error: error.message });
    return res.status(500).json({
      message: "Failed to update events",
      allowedEvents,
    });
  }
});

router.delete("/", authenticateProducer, async (req, res) => {
  let producer = req.producer;
  try {
    producer.isActive = false;
    producer = await producer.save();

    logger.info("Producer deactivated", { producerId: producer._id });
    res.json({ message: "Producer deactivated successfully" });
  } catch (err) {
    logger.error("Failed to deactivate Producer", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
