const mongoose = require('mongoose')
const logger = require('./logger')
 
const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/webhook-delivery'
    await mongoose.connect(mongoUri)
    logger.info('MongoDB connected')
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message })
    process.exit(1)
  }
}
 
module.exports = connectDB
