jest.mock('../models/Event', () => ({
  findByIdAndUpdate: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../models/Subscriber', () => ({
  find: jest.fn(),
}));

jest.mock('../queues/deliveryQueue', () => ({
  deliveryQueue: {
    addBulk: jest.fn(),
  },
}));

jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Event = require('../models/Event');
const { deliveryQueue } = require('../queues/deliveryQueue');
const {
  buildJobId,
  queueEventDeliveries,
  QUEUED_QUEUE_STATUS,
  NO_SUBSCRIBERS_QUEUE_STATUS,
  PENDING_QUEUE_STATUS,
} = require('../utils/eventQueue');

const VALID_EVENT_ID = '507f1f77bcf86cd799439011';
const VALID_SUB_ID = '507f191e810c19729de860ea';

describe('eventQueue utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Event.findByIdAndUpdate.mockResolvedValue(null);
  });

  it('builds deterministic job ids per event/subscriber pair', () => {
    expect(buildJobId(VALID_EVENT_ID, VALID_SUB_ID))
      .toBe(`event-${VALID_EVENT_ID}-subscriber-${VALID_SUB_ID}`);
  });

  it('queues delivery jobs and marks the event as queued', async () => {
    const event = {
      _id: VALID_EVENT_ID,
      payload: { orderId: 'ORD-1' },
      requestId: 'req-abc',
      deliveryTargets: [
        {
          subscriberId: VALID_SUB_ID,
          subscriberUrl: 'https://example.com/webhook',
        },
      ],
    };

    const result = await queueEventDeliveries(event);

    expect(deliveryQueue.addBulk).toHaveBeenCalledWith([
      {
        name: 'deliver',
        data: {
          eventId: VALID_EVENT_ID,
          subscriberId: VALID_SUB_ID,
          subscriberUrl: 'https://example.com/webhook',
          payload: { orderId: 'ORD-1' },
          requestId: 'req-abc',
        },
        opts: {
          jobId: `event-${VALID_EVENT_ID}-subscriber-${VALID_SUB_ID}`,
        },
      },
    ]);

    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      VALID_EVENT_ID,
      expect.objectContaining({
        queueStatus: QUEUED_QUEUE_STATUS,
        queuedJobCount: 1,
      }),
      { new: true }
    );

    expect(result).toEqual({
      jobsQueued: 1,
      queueStatus: QUEUED_QUEUE_STATUS,
    });
  });

  it('marks events with no targets as no_subscribers without queueing', async () => {
    const result = await queueEventDeliveries({
      _id: VALID_EVENT_ID,
      payload: { orderId: 'ORD-2' },
      deliveryTargets: [],
    });

    expect(deliveryQueue.addBulk).not.toHaveBeenCalled();
    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      VALID_EVENT_ID,
      expect.objectContaining({
        queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS,
        queuedJobCount: 0,
      }),
      { new: true }
    );
    expect(result).toEqual({
      jobsQueued: 0,
      queueStatus: NO_SUBSCRIBERS_QUEUE_STATUS,
    });
  });

  it('keeps the event pending when queueing fails', async () => {
    deliveryQueue.addBulk.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      queueEventDeliveries({
        _id: VALID_EVENT_ID,
        payload: { orderId: 'ORD-3' },
        deliveryTargets: [
          {
            subscriberId: VALID_SUB_ID,
            subscriberUrl: 'https://example.com/fail',
          },
        ],
      })
    ).rejects.toThrow('redis unavailable');

    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      VALID_EVENT_ID,
      expect.objectContaining({
        queueStatus: PENDING_QUEUE_STATUS,
        lastQueueError: expect.objectContaining({ message: 'redis unavailable' }),
      }),
      { new: true }
    );
  });
});