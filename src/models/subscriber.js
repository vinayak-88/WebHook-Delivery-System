const mongoose = require('mongoose')
const bcrypt = require('bcrypt')
const crypto = require('crypto')

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
  // bcrypt hash of the plaintext secret — for any future
  // challenge/verify flows. Never used for HMAC signing.
  secretHash: {
    type: String,
    required: true
  },
  // Separate random key used exclusively for HMAC-SHA256 signing.
  // Derived from the plaintext secret via HKDF-SHA256 so it is
  // deterministic (same secret always produces the same signingKey)
  // but cryptographically independent from secretHash.
  // Stored in plaintext because it is already a keyed derivative —
  // it reveals nothing about the original secret.
  signingKey: {
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
  this.secretHash = val  // pre-save hook overwrites with bcrypt hash
})

subscriberSchema.pre('save', async function () {
  // Only runs when the raw value was set via the virtual setter
  if (!this._plaintextSecret) return

  // bcrypt hash — for secretHash field
  this.secretHash = await bcrypt.hash(this._plaintextSecret, 12)

  // HKDF-SHA256 — deterministic signing key derived from the plaintext.
  // Using HKDF instead of a raw copy means the signingKey is
  // cryptographically independent from the password-equivalent secretHash.
  // 'webhook-signing-v1' is the info/context label; change it to rotate
  // all signing keys without changing subscriber secrets.
  this.signingKey = crypto.hkdfSync(
    'sha256',
    Buffer.from(this._plaintextSecret),
    Buffer.alloc(0),            // salt (empty — secret itself is the IKM)
    Buffer.from('webhook-signing-v1'),
    32                          // 32 bytes = 256-bit key, hex = 64 chars
  ).toString('hex')

  delete this._plaintextSecret
})

module.exports = mongoose.model('Subscriber', subscriberSchema)