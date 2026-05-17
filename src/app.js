require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const connectDB = require("./config/db");
const logger = require("./config/logger");
const webhookRoutes = require("./routes/webhooks");
const eventRoutes = require("./routes/events");
const deadLetterRoutes = require("./routes/deadLetters");
const { startPendingEventRecovery } = require("./utils/eventQueue");
const { deliveryQueue } = require("./queues/deliveryQueue");

const app = express();

// Capture raw body bytes alongside parsed JSON.
// Required so the delivery worker can sign the exact wire bytes
// rather than re-serialising a parsed object (which has unstable
// property order across engines and runtimes).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
    limit: "16kb",
  }),
);

// Rate limiting — tighter on event ingestion, looser on management routes
const eventLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { error: "Too many requests, slow down" },
});

const managementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
});

app.use("/events", eventLimiter, eventRoutes);
app.use("/webhooks", managementLimiter, webhookRoutes);
app.use("/dead-letters", managementLimiter, deadLetterRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  await connectDB();

  const server = app.listen(PORT, () => {
    logger.info(`Server started on port ${PORT}`);
    // Start recovery only inside the listen callback — guarantees the DB
    // connection pool is fully warmed before the first recovery tick runs
    const recoveryTimer = startPendingEventRecovery();

    const shutdown = async (signal) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);

      //Stop accepting new HTTP requests
      server.close();

      //Stop the recovery interval from firing again
      if (recoveryTimer) clearInterval(recoveryTimer);

      //Let BullMQ finish in-progress jobs before closing
      await deliveryQueue.close();

      //Close DB connection
      await mongoose.connection.close();

      logger.info("Graceful shutdown complete.");
      process.exit(0);
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
