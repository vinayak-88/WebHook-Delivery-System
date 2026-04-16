const mongoose = require('mongoose')

const subscriberSchema = new mongoose.Schema({
  subscriberUrl: {
    type: String,
    required: true,
    trim: true
  },
  events: {
    type: [String],
    required: true,
    validate: v => Array.isArray(v) && v.length > 0
  },
  secret: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true })

module.exports = mongoose.model('Subscriber', subscriberSchema)