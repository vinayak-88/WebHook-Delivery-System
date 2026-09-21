const mongoose = require("mongoose");
const { encrypt } = require("../utils/encryption");

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
