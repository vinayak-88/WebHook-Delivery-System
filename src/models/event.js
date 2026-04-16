const mongoose = require('mongoose')

const eventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    trim: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  }
}, { timestamps: true })

module.exports = mongoose.model('Event', eventSchema)