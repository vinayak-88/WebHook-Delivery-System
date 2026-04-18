const express = require('express')
const router = express.Router()
const { deadLetterQueue, deliveryQueue } = require('../queues/deliveryQueue')
const logger = require('../config/logger')

const DLQ_STATES = [
  'waiting',
  'delayed',
  'active',
  'completed',
  'failed',
  'prioritized',
  'paused'
]

const formatJob = async (job) => ({
  jobId: job.id,
  name: job.name,
  state: await job.getState(),
  eventId: job.data.eventId,
  subscriberId: job.data.subscriberId,
  subscriberUrl: job.data.subscriberUrl,
  failureReason: job.data.failureReason || job.failedReason || null,
  failedAt: job.data.failedAt || null,
  originalJobId: job.data.originalJobId || null,
  timestamp: new Date(job.timestamp).toISOString()
})

// GET /dead-letters
// View dead-lettered jobs for inspection.
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)

  try {
    const jobs = await deadLetterQueue.getJobs(DLQ_STATES, 0, limit - 1, false)
    const formattedJobs = await Promise.all(jobs.map((job) => formatJob(job)))

    return res.json({
      count: formattedJobs.length,
      jobs: formattedJobs
    })
  } catch (err) {
    logger.error('Failed to fetch dead-letter jobs', { error: err.message })
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /dead-letters/:jobId/replay
// Replay a dead-lettered delivery back into the main queue.
// The replay job ID is deterministic (no timestamp suffix) so that
// replaying the same DLQ job twice does not produce duplicate deliveries —
// BullMQ will reject the second add if a job with that ID already exists
// and is still active or waiting.
router.post('/:jobId/replay', async (req, res) => {
  try {
    const deadLetterJob = await deadLetterQueue.getJob(req.params.jobId)

    if (!deadLetterJob) {
      return res.status(404).json({ error: 'Dead-letter job not found' })
    }

    const { eventId, subscriberId, subscriberUrl, payload } = deadLetterJob.data

    if (!eventId || !subscriberId || !subscriberUrl || payload === undefined) {
      return res.status(400).json({ error: 'Dead-letter job is missing replay data' })
    }

    // Deterministic job ID — prevents double-delivery if replay is
    // called twice before the first replay job completes
    const replayJobId = `replay:${deadLetterJob.id}`

    // Check if a replay is already active or waiting
    const existingReplayJob = await deliveryQueue.getJob(replayJobId)
    if (existingReplayJob) {
      const state = await existingReplayJob.getState()
      if (state !== 'failed' && state !== 'completed') {
        return res.status(409).json({
          error: 'A replay job for this dead-letter entry is already active',
          replayJobId: existingReplayJob.id,
          state
        })
      }
    }

    const replayedJob = await deliveryQueue.add('deliver', {
      eventId,
      subscriberId,
      subscriberUrl,
      payload
      // secret intentionally omitted — worker fetches it from DB
    }, {
      jobId: replayJobId
    })

    logger.info('Dead-letter job replayed', {
      deadLetterJobId: deadLetterJob.id,
      replayJobId: replayedJob.id,
      eventId,
      subscriberId
    })

    return res.status(202).json({
      message: 'Dead-letter job replayed',
      deadLetterJobId: deadLetterJob.id,
      replayJobId: replayedJob.id
    })
  } catch (err) {
    logger.error('Failed to replay dead-letter job', { error: err.message })
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router