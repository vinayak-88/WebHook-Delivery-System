const mongoose = require('mongoose')

// Secret is intentionally excluded — it is never snapshotted into the
// event document or Redis job data. The worker fetches it fresh from
// the Subscriber collection at delivery time to minimise plaintext exposure.
const deliveryTargetSchema = new mongoose.Schema({
  subscriberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscriber',
    required: true
  },
  subscriberUrl: {
    type: String,
    required: true
  }
}, { _id: false })

const eventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    trim: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  deliveryTargets: {
    type: [deliveryTargetSchema],
    default: []
  },
  queueStatus: {
    type: String,
    enum: ['pending', 'queued', 'no_subscribers'],
    default: 'pending'
  },
  queuedJobCount: {
    type: Number,
    default: 0
  },
  queueEnqueuedAt: {
    type: Date,
    default: null
  },
  lastQueueError: {
    type: String,
    default: null
  }
}, { timestamps: true })

module.exports = mongoose.model('Event', eventSchema)