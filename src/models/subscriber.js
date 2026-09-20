const mongoose = require("mongoose");
const { encrypt } = require("../utils/encryption");

const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_WEBHOOK_TIMEOUT_MS) || 5000;
const MAX_TIMEOUT_MS = Number(process.env.MAX_WEBHOOK_TIMEOUT_MS) || 30000;
const MIN_TIMEOUT_MS = 1000;

const subscriberSchema = new mongoose.Schema(
  {
    subscriberUrl: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    events: {
      type: [String],
      required: true,
      validate: [
        {
          validator: function (arr) {
            return arr.length > 0;
          },
          message: "events array must not be empty",
        },
        {
          validator: function (arr) {
            return new Set(arr).size === arr.length;
          },
          message: "events array must not contain duplicates",
        },
      ],
    },
    /**
     * signingKey stores the AES-256-GCM encrypted form of the subscriber's
     * webhook secret in the format: <ivHex>:<authTagHex>:<ciphertextHex>
     *
     * The plaintext secret is NEVER stored. The worker decrypts this at
     * delivery time using WEBHOOK_ENCRYPTION_KEY.
     */
    signingKey: {
      type: String,
      required: true,
    },
    apiSecret: {
      type: String,
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    /**
     * Per-subscriber HTTP delivery timeout in milliseconds.
     * Must be between MIN_TIMEOUT_MS and MAX_TIMEOUT_MS.
     * Defaults to DEFAULT_WEBHOOK_TIMEOUT_MS (5000ms).
     */
    timeoutMs: {
      type: Number,
      default: DEFAULT_TIMEOUT_MS,
      min: [MIN_TIMEOUT_MS, `timeoutMs must be at least ${MIN_TIMEOUT_MS}ms`],
      max: [MAX_TIMEOUT_MS, `timeoutMs must not exceed ${MAX_TIMEOUT_MS}ms`],
    },
  },
  { timestamps: true }
);

// Multikey index for subscriber event-type matching
subscriberSchema.index({ events: 1 });

/**
 * Virtual setter: accepts the plaintext webhook secret and immediately
 * encrypts it before storing in signingKey.
 *
 * Usage:
 *   new Subscriber({ ..., secret: plaintextSecret })
 *   subscriber.secret = newPlaintextSecret
 */
subscriberSchema.virtual("secret").set(function (val) {
  if (val) {
    this.signingKey = encrypt(val);
  }
});

module.exports = mongoose.model("Subscriber", subscriberSchema);
