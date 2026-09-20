const mongoose = require("mongoose");

/*
 * Secret is intentionally excluded — it is never snapshotted into the event
 * document or Redis job data. The worker fetches and decrypts it fresh from
 * the Subscriber collection at delivery time to minimise exposure.
 */

const deliveryTargetSchema = new mongoose.Schema(
  {
    subscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscriber",
      required: true,
    },
    subscriberUrl: {
      type: String,
      required: true,
    },
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema(
  {
    /**
     * The producer that submitted this event.
     * Used for ownership checks on GET /events/:id.
     */
    producerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Producer",
      required: false, // Optional for backward compatibility with pre-producer events
      index: true,
    },

    /**
     * Optional idempotency key supplied by the producer.
     * Uniqueness is enforced at the { producerId, idempotencyKey } level.
     * See the sparse compound index below.
     */
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
    },

    type: {
      type: String,
      required: true,
      trim: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    deliveryTargets: {
      type: [deliveryTargetSchema],
      default: [],
      validate: {
        validator: function (arr) {
          const ids = arr.map((t) => t.subscriberId.toString());
          return new Set(ids).size === ids.length;
        },
        message: "deliveryTargets contains duplicate subscriberIds",
      },
    },
    queueStatus: {
      type: String,
      enum: ["pending", "queued", "no_subscribers"],
      default: "pending",
    },
    queuedJobCount: {
      type: Number,
      default: 0,
    },
    queueEnqueuedAt: {
      type: Date,
      default: null,
    },
    lastQueueError: {
      message: { type: String, default: null },
      code: { type: String, default: null },
      occurredAt: { type: Date, default: null },
    },

    // ── DLQ replay tracking ──────────────────────────────────────────────
    /** Number of times this event's DLQ job has been replayed */
    replayCount: {
      type: Number,
      default: 0,
    },
    /** Timestamp of the most recent replay attempt */
    lastReplayedAt: {
      type: Date,
      default: null,
    },
    /** BullMQ job ID of the most recent replay job */
    lastReplayJobId: {
      type: String,
      default: null,
    },

    /**
     * Request ID from the producer's HTTP request that created this event.
     * Used for distributed tracing across API logs, queue, and worker.
     */
    requestId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Compound index for the pending-event recovery query:
 *   Event.find({ queueStatus: 'pending' }).sort({ createdAt: 1 })
 */
eventSchema.index({ queueStatus: 1, createdAt: 1 });

/**
 * Sparse compound unique index for idempotency.
 * Uniqueness is scoped to { producerId, idempotencyKey }.
 * sparse: true means rows where idempotencyKey is null are excluded,
 * allowing events without an idempotency key to coexist freely.
 */
eventSchema.index(
  { producerId: 1, idempotencyKey: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { idempotencyKey: { $ne: null } },
  }
);

module.exports = mongoose.model("Event", eventSchema);
