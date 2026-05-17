const Event = require("../models/Event");
const { deliveryQueue } = require("../queues/deliveryQueue");
const logger = require("../config/logger");

const PENDING_QUEUE_STATUS = "pending";
const QUEUED_QUEUE_STATUS = "queued";
const NO_SUBSCRIBERS_QUEUE_STATUS = "no_subscribers";

const buildJobId = (eventId, subscriberId) =>
  `event:${eventId}:subscriber:${subscriberId}`;

const buildDeliveryJobs = (event) =>
  event.deliveryTargets.map((target) => ({
    name: "deliver",
    data: {
      eventId: event._id.toString(),
      subscriberId: target.subscriberId.toString(),
      subscriberUrl: target.subscriberUrl,
      payload: event.payload,
      // secret intentionally omitted — worker fetches it from DB
    },
    opts: {
      jobId: buildJobId(event._id.toString(), target.subscriberId.toString()),
    },
  }));

const markEventQueueState = async (eventId, updates) =>
  Event.findByIdAndUpdate(eventId, updates, { new: true });

const queueEventDeliveries = async (event) => {
  const jobs = buildDeliveryJobs(event);

  if (jobs.length === 0) {
    await markEventQueueState(event._id, {
      queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS,
      queuedJobCount: 0,
    });

    return {
      jobsQueued: 0,
      queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS,
    };
  }

  try {
    await deliveryQueue.addBulk(jobs);

    await markEventQueueState(event._id, {
      queueStatus: QUEUED_QUEUE_STATUS,
      queuedJobCount: jobs.length,
      queueEnqueuedAt: new Date(),
      lastQueueError: { message: null, code: null, occurredAt: null },
    });

    return {
      jobsQueued: jobs.length,
      queueStatus: QUEUED_QUEUE_STATUS,
    };
  } catch (err) {
    await markEventQueueState(event._id, {
      queueStatus: PENDING_QUEUE_STATUS,
      lastQueueError: {
        message: err.message,
        code: err.code || null,
        occurredAt: new Date(),
      },
    });

    throw err;
  }
};

const recoverPendingEvents = async ({ limit = 25 } = {}) => {
  const pendingEvents = await Event.find({ queueStatus: PENDING_QUEUE_STATUS })
    .sort({ createdAt: 1 }) //ascending order
    .limit(limit);

  let recovered = 0;

  for (const event of pendingEvents) {
    try {
      await queueEventDeliveries(event);
      recovered++;
    } catch (err) {
      logger.warn("Pending event remains queued for recovery", {
        eventId: event._id.toString(),
        error: err.message,
      });
    }
  }

  return {
    scanned: pendingEvents.length,
    recovered,
  };
};

const startPendingEventRecovery = ({
  intervalMs = Number(process.env.RECOVERY_INTERVAL_MS) || 5000,
  batchSize = Number(process.env.RECOVERY_BATCH_SIZE) || 25,
} = {}) => {
  if (intervalMs <= 0) {
    return null;
  }
  if (process.env.DISABLE_RECOVERY === "true") {
    logger.warn(
      "Pending event recovery is disabled via DISABLE_RECOVERY=true. " +
        "Enable on exactly one instance or use a distributed lock before scaling out.",
    );
    return null;
  }

  let isRunning = false;

  const runRecovery = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;

    try {
      const result = await recoverPendingEvents({ limit: batchSize });

      if (result.recovered > 0) {
        logger.info("Recovered pending events into the delivery queue", result);
      } else if (result.scanned > 0) {
        logger.warn("Pending events found but none could be recovered", result);
      }
    } catch (err) {
      logger.error("Pending event recovery failed", {
        error: err.message,
        stack: err.stack,
      });
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => {
    void runRecovery();
  }, intervalMs);

  void runRecovery();

  return timer;
};

module.exports = {
  buildDeliveryJobs,
  buildJobId,
  queueEventDeliveries,
  recoverPendingEvents,
  startPendingEventRecovery,
  PENDING_QUEUE_STATUS,
  QUEUED_QUEUE_STATUS,
  NO_SUBSCRIBERS_QUEUE_STATUS,
};
