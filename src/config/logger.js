const { createLogger, format, transports } = require('winston')
const path = require('path')
const fs = require('fs')

// Use process.cwd() so the logs directory is always relative to the
// project root, regardless of where this file lives in the src tree.
const logsDir = path.resolve(process.cwd(), 'logs')

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true })
}

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error'
    }),
    new transports.File({
      filename: path.join(logsDir, 'combined.log')
    })
  ]
})

module.exports = logger