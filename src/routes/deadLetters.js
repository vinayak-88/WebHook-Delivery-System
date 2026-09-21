const express = require('express');
const router = express.Router();
const { deadLetterQueue, deliveryQueue } = require('../queues/deliveryQueue');
const Event = require('../models/Event');
const logger = require('../config/logger');
const authenticateAdmin = require('../middlewares/authenticateAdmin');

// Secure all DLQ routes with admin authentication
router.use(authenticateAdmin);

const formatJob = async (job) => ({
  jobId: job.id,
  name: job.name,
  state: await job.getState(),
  eventId: job.data.eventId,
  subscriberId: job.data.subscriberId,
  subscriberUrl: job.data.subscriberUrl,
  failureReason: job.data.failureReason || null,
  failedAt: job.data.failedAt || null,
  originalJobId: job.data.originalJobId || null,
  timestamp: new Date(job.timestamp).toISOString(),
});

// GET /dead-letters - View dead-lettered jobs for inspection
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

  try {
    const jobs = await deadLetterQueue.getJobs(['waiting'], 0, limit - 1, false);
    const formattedJobs = await Promise.all(jobs.map((job) => formatJob(job)));

    return res.json({
      count: formattedJobs.length,
      jobs: formattedJobs,
    });
  } catch (err) {
    logger.error('Failed to fetch dead-letter jobs', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /dead-letters/:jobId/replay - Replay a single dead-lettered job
router.post('/:jobId/replay', async (req, res) => {
  try {
    const deadLetterJob = await deadLetterQueue.getJob(req.params.jobId);

    if (!deadLetterJob) {
      return res.status(404).json({ error: 'Dead-letter job not found' });
    }

    const { eventId, subscriberId, subscriberUrl, payload, requestId } = deadLetterJob.data;

    if (!eventId || !subscriberId || !subscriberUrl || payload === undefined) {
      return res.status(400).json({ error: 'Dead-letter job is missing replay data' });
    }

    // Deterministic job ID — prevents double-delivery if replay is called twice before the first replay completes
    const replayJobId = `replay:${deadLetterJob.id}`;

    // Check if a replay is already active or waiting
    const existingReplayJob = await deliveryQueue.getJob(replayJobId);
    if (existingReplayJob) {
      const state = await existingReplayJob.getState();
      if (state !== 'failed' && state !== 'completed') {
        return res.status(409).json({
          error: 'A replay job for this dead-letter entry is already active',
          replayJobId: existingReplayJob.id,
          state,
        });
      }
    }

    const replayedJob = await deliveryQueue.add(
      'deliver',
      {
        eventId,
        subscriberId,
        subscriberUrl,
        payload,
        requestId: requestId || null,
      },
      {
        jobId: replayJobId,
      }
    );

    // Update DLQ replay state on parent Event
    await Event.findByIdAndUpdate(eventId, {
      $inc: { replayCount: 1 },
      lastReplayedAt: new Date(),
      lastReplayJobId: replayedJob.id,
    });

    logger.info('Dead-letter job replayed', {
      deadLetterJobId: deadLetterJob.id,
      replayJobId: replayedJob.id,
      eventId,
      subscriberId,
    });

    return res.status(202).json({
      message: 'Dead-letter job replayed',
      deadLetterJobId: deadLetterJob.id,
      replayJobId: replayedJob.id,
    });
  } catch (err) {
    logger.error('Failed to replay dead-letter job', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;