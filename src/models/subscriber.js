const mongoose = require('mongoose')
const bcrypt = require('bcrypt')

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
  // Store only the hash — plaintext secret is never persisted
  secretHash: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true })

// Compound unique index — prevents duplicate registrations
// for the same URL + event combination
subscriberSchema.index(
  { subscriberUrl: 1, events: 1 },
  { unique: true }
)

// Virtual setter so calling code can still write subscriber.secret = '...'
// and it gets hashed transparently via the pre-save hook
subscriberSchema.virtual('secret').set(function (val) {
  this._plaintextSecret = val
  this.secretHash = val  // pre-save hook will overwrite with hash
})

subscriberSchema.pre('save', async function () {
  // Only hash if the raw value was just set via the virtual
  if (!this._plaintextSecret) return
  this.secretHash = await bcrypt.hash(this._plaintextSecret, 12)
  delete this._plaintextSecret
})

module.exports = mongoose.model('Subscriber', subscriberSchema)