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
    requestId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound index for querying subscriber logs sorted by newest first:
// DeliveryLog.find({ subscriberId }).sort({ createdAt: -1 })
deliveryLogSchema.index({ subscriberId: 1, createdAt: -1 });

module.exports = mongoose.model('DeliveryLog', deliveryLogSchema);