jest.mock('../models/event', () => ({
  findByIdAndUpdate: jest.fn(),
  find: jest.fn()
}))

jest.mock('../models/subscriber', () => ({
  find: jest.fn()
}))

jest.mock('../queues/deliveryQueue', () => ({
  deliveryQueue: {
    addBulk: jest.fn()
  }
}))

jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const Event = require('../models/event')
const Subscriber = require('../models/subscriber')
const { deliveryQueue } = require('../queues/deliveryQueue')
const {
  buildJobId,
  queueEventDeliveries,
  QUEUED_QUEUE_STATUS,
  NO_SUBSCRIBERS_QUEUE_STATUS,
  PENDING_QUEUE_STATUS
} = require('../utils/eventQueue')

describe('eventQueue utility', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Event.findByIdAndUpdate.mockResolvedValue(null)
    Subscriber.find.mockResolvedValue([])
  })

  it('builds deterministic job ids per event/subscriber pair', () => {
    expect(buildJobId('event-1', 'subscriber-1'))
      .toBe('event:event-1:subscriber:subscriber-1')
  })

  it('queues delivery jobs and marks the event as queued', async () => {
    const event = {
      _id: 'event-1',
      payload: { orderId: 'ORD-1' },
      deliveryTargets: [
        {
          subscriberId: 'subscriber-1',
          subscriberUrl: 'https://example.com/webhook'
          // no secret — intentionally excluded from deliveryTargets
        }
      ]
    }

    const result = await queueEventDeliveries(event)

    expect(deliveryQueue.addBulk).toHaveBeenCalledWith([
      {
        name: 'deliver',
        data: {
          eventId: 'event-1',
          subscriberId: 'subscriber-1',
          subscriberUrl: 'https://example.com/webhook',
          payload: { orderId: 'ORD-1' }
          // secret intentionally absent — worker fetches from DB
        },
        opts: {
          jobId: 'event:event-1:subscriber:subscriber-1'
        }
      }
    ])

    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      'event-1',
      expect.objectContaining({
        queueStatus: QUEUED_QUEUE_STATUS,
        queuedJobCount: 1,
        lastQueueError: null
      }),
      { new: true }
    )

    expect(result).toEqual({
      jobsQueued: 1,
      queueStatus: QUEUED_QUEUE_STATUS
    })
  })

  it('marks events with no targets as no_subscribers without queueing', async () => {
    const result = await queueEventDeliveries({
      _id: 'event-2',
      payload: { orderId: 'ORD-2' },
      deliveryTargets: []
    })

    expect(deliveryQueue.addBulk).not.toHaveBeenCalled()
    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      'event-2',
      expect.objectContaining({
        queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS,
        queuedJobCount: 0,
        lastQueueError: null
      }),
      { new: true }
    )
    expect(result).toEqual({
      jobsQueued: 0,
      queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS
    })
  })

  it('rebuilds missing delivery targets for legacy pending events before queueing', async () => {
    Subscriber.find.mockResolvedValueOnce([
      {
        _id: 'subscriber-legacy',
        subscriberUrl: 'https://example.com/legacy'
        // no secret on the snapshot — excluded by design
      }
    ])

    const result = await queueEventDeliveries({
      _id: 'event-legacy',
      type: 'payment.success',
      payload: { orderId: 'ORD-LEGACY' },
      deliveryTargets: []
    })

    expect(Subscriber.find).toHaveBeenCalledWith({
      events: 'payment.success',
      isActive: true
    })

    expect(Event.findByIdAndUpdate).toHaveBeenNthCalledWith(
      1,
      'event-legacy',
      {
        deliveryTargets: [
          {
            subscriberId: 'subscriber-legacy',
            subscriberUrl: 'https://example.com/legacy'
          }
        ]
      },
      { new: true }
    )

    expect(deliveryQueue.addBulk).toHaveBeenCalledWith([
      {
        name: 'deliver',
        data: {
          eventId: 'event-legacy',
          subscriberId: 'subscriber-legacy',
          subscriberUrl: 'https://example.com/legacy',
          payload: { orderId: 'ORD-LEGACY' }
        },
        opts: {
          jobId: 'event:event-legacy:subscriber:subscriber-legacy'
        }
      }
    ])

    expect(result).toEqual({
      jobsQueued: 1,
      queueStatus: QUEUED_QUEUE_STATUS
    })
  })

  it('marks event as no_subscribers when deliveryTargets is empty and type is absent', async () => {
    // Malformed legacy record with no type — backfill cannot run,
    // should fall through to no_subscribers cleanly
    const result = await queueEventDeliveries({
      _id: 'event-no-type',
      payload: { orderId: 'ORD-X' },
      deliveryTargets: []
      // no type field
    })

    expect(Subscriber.find).not.toHaveBeenCalled()
    expect(deliveryQueue.addBulk).not.toHaveBeenCalled()
    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      'event-no-type',
      expect.objectContaining({ queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS }),
      { new: true }
    )
    expect(result.jobsQueued).toBe(0)
  })

  it('keeps the event pending when queueing fails', async () => {
    deliveryQueue.addBulk.mockRejectedValueOnce(new Error('redis unavailable'))

    await expect(queueEventDeliveries({
      _id: 'event-3',
      payload: { orderId: 'ORD-3' },
      deliveryTargets: [
        {
          subscriberId: 'subscriber-3',
          subscriberUrl: 'https://example.com/fail'
        }
      ]
    })).rejects.toThrow('redis unavailable')

    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      'event-3',
      expect.objectContaining({
        queueStatus: PENDING_QUEUE_STATUS,
        lastQueueError: 'redis unavailable'
      }),
      { new: true }
    )
  })
})