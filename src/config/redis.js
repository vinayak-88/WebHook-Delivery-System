const { Redis } = require('ioredis')
const logger = require('./logger')
 
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null  // required by BullMQ
})
 
redisConnection.on('connect', () => logger.info('Redis connected'))
redisConnection.on('error', (err) => logger.error('Redis error', { error: err.message }))
 
module.exports = redisConnection
