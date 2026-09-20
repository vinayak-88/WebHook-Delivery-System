const mongoose = require('mongoose');

const eventTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      validate: {
        validator: function (v) {
          return /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(v);
        },
        message: 'Event type name must follow noun.verb format (e.g. "payment.success")',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EventType', eventTypeSchema);
