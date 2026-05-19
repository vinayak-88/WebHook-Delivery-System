const mongoose = require("mongoose");

const producerSchema = new mongoose.Schema(
  {
    producerUrl: {
      type: String,
      trim: true,
      required: true,
      unique: true,
      validate: {
        validator: function (v) {
          return /^https?:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9-].*$/.test(v);
        },
        message: "producerUrl must be a valid URL",
      },
    },
    apiSecret: {
      type: String,
      required: true,
      unique: true,
    },
    allowedEvents: {
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

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Producer", producerSchema);
