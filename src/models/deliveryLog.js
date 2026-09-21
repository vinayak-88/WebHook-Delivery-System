const mongoose = require('mongoose');

const deliveryLogSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },
    subscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscriber',
      required: true,
    },
    subscriberUrl: {
      type: String,
      required: true,
    },
    attemptNumber: {
      type: Number,
      required: true,
    },
    statusCode: {
      type: Number,
      default: null, // null if network error (no response)
    },
    responseBody: {
      type: String,
      default: null,
    },
    success: {
      type: Boolean,
      required: true,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    /**
     * Elapsed time of the outbound HTTP attempt in milliseconds.
     * Measured around the Axios request for both success and failure.
     */
    durationMs: {
      type: Number,
      default: null,
    },
    requestId: {
      type: String,
      default: null,
    },
  },
  // Append-only audit record: DeliveryLog documents are never updated after
  // creation, so only createdAt is generated (no misleading updatedAt).
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound index for querying subscriber logs sorted by newest first:
// DeliveryLog.find({ subscriberId }).sort({ createdAt: -1 })
deliveryLogSchema.index({ subscriberId: 1, createdAt: -1 });

module.exports = mongoose.model('DeliveryLog', deliveryLogSchema);