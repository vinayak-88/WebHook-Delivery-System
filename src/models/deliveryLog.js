const mongoose = require('mongoose')
 
const deliveryLogSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true
  },
  subscriberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscriber',
    required: true
  },
  subscriberUrl: {
    type: String,
    required: true
  },
  attemptNumber: {
    type: Number,
    required: true
  },
  statusCode: {
    type: Number,
    default: null     // null if network error (no response)
  },
  responseBody: {
    type: String,
    default: null
  },
  success: {
    type: Boolean,
    required: true
  },
  errorMessage: {
    type: String,
    default: null     // populated on network-level failures
  }
}, { timestamps: true })
 
module.exports = mongoose.model('DeliveryLog', deliveryLogSchema)