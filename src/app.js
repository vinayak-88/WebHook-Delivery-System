require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const connectDB = require("./config/db");
const redisConnection = require("./config/redis");
const logger = require("./config/logger");
const webhookRoutes = require("./routes/webhooks");
const eventRoutes = require("./routes/events");
const deadLetterRoutes = require("./routes/deadLetters");
const producerRouter = require("./routes/producer");
const eventTypeRoutes = require("./routes/eventTypes");
const requestIdMiddleware = require("./middlewares/requestId");
const { startPendingEventRecovery } = require("./utils/eventQueue");
const { deliveryQueue } = require("./queues/deliveryQueue");

const app = express();

const BODY_LIMIT = process.env.BODY_LIMIT || "16kb";

// Validate encryption key configuration at startup
const encryptionKey = process.env.WEBHOOK_ENCRYPTION_KEY;
if (process.env.NODE_ENV === "production" || encryptionKey) {
  if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    logger.error("Fatal: WEBHOOK_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
  }
}

// Attach Request ID to every request and response
app.use(requestIdMiddleware);

// Capture raw body bytes alongside parsed JSON
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
    limit: BODY_LIMIT,
  }),
);

// Redis-backed rate limiting
const createRedisStore = (prefix) => {
  // Use memory store in test environment to avoid open Redis connection handles during testing
  if (process.env.NODE_ENV === "test") {
    return undefined;
  }
  return new RedisStore({
    sendCommand: (...args) => redisConnection.call(...args),
    prefix: `rl:${prefix}:`,
  });
};

const eventLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  store: createRedisStore("events"),
  message: { error: "Too many requests, slow down" },
  passOnStoreError: false, // Fail closed if Redis is down
});

const managementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  store: createRedisStore("mgmt"),
  message: { error: "Too many requests, slow down" },
  passOnStoreError: false, // Fail closed if Redis is down
});

app.use("/events", eventLimiter, eventRoutes);
app.use("/webhooks", managementLimiter, webhookRoutes);
app.use("/dead-letters", managementLimiter, deadLetterRoutes);
app.use("/producers", managementLimiter, producerRouter);
app.use("/event-types", managementLimiter, eventTypeRoutes);

// Liveness check (cheap process check)
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Readiness check (verifies MongoDB and Redis connectivity)
app.get("/ready", async (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;
  let redisConnected = false;
  try {
    const pong = await redisConnection.ping();
    redisConnected = pong === "PONG";
  } catch {
    redisConnected = false;
  }

  const isReady = mongoConnected && redisConnected;
  const statusCode = isReady ? 200 : 503;

  res.status(statusCode).json({
    status: isReady ? "ready" : "unready",
    dependencies: {
      mongodb: mongoConnected ? "connected" : "disconnected",
      redis: redisConnected ? "connected" : "disconnected",
    },
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({
      error: "Payload too large",
      limit: BODY_LIMIT,
    });
  }

  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    requestId: req.requestId,
  });

  res.status(err.statusCode || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10000;

const startServer = async () => {
  await connectDB();

  const server = app.listen(PORT, () => {
    logger.info(`Server started on port ${PORT}`);

    const recoveryTimer = startPendingEventRecovery();
    let isShuttingDown = false;

    const shutdown = async (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info(`${signal} received. Starting graceful shutdown...`);

      // Guard against hanging shutdown
      const forceExitTimer = setTimeout(() => {
        logger.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExitTimer.unref();

      try {
        // Stop accepting new HTTP requests
        server.close();

        // Stop recovery interval
        if (recoveryTimer) clearInterval(recoveryTimer);

        // Close BullMQ queue
        await deliveryQueue.close();

        // Close Redis connection
        await redisConnection.quit().catch(() => {});

        // Close DB connection
        await mongoose.connection.close();

        logger.info("Graceful shutdown complete.");
        process.exit(0);
      } catch (err) {
        logger.error("Error during graceful shutdown", { error: err.message });
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
};

if (require.main === module) {
  startServer().catch((err) => {
    logger.error("Failed to start server", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });
}

module.exports = app;
