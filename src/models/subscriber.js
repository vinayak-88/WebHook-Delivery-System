const mongoose = require("mongoose");

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
  { timestamps: true },
);

subscriberSchema.index({ events: 1 });

subscriberSchema.virtual("secret").set(function (val) {
  this.signingKey = val;
});

module.exports = mongoose.model("Subscriber", subscriberSchema);
