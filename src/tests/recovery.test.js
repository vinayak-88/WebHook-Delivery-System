jest.mock('../models/Event', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../queues/deliveryQueue', () => ({
  deliveryQueue: { addBulk: jest.fn() },
}));
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Event = require('../models/Event');
const { deliveryQueue } = require('../queues/deliveryQueue');
const { recoverPendingEvents } = require('../utils/eventQueue');

const EVENT_ID = '507f1f77bcf86cd799439011';
const SUB_ID = '507f191e810c19729de860ea';

const pendingEvent = () => ({
  _id: EVENT_ID,
  payload: { orderId: 'ORD-1' },
  requestId: null,
  deliveryTargets: [{ subscriberId: SUB_ID, subscriberUrl: 'https://example.com/hook' }],
});

const mockFind = (events) => {
  Event.find.mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(events),
    }),
  });
};

describe('Pending-event recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Event.findByIdAndUpdate.mockResolvedValue(null);
  });

  it('leaves the event pending when Redis enqueue fails so it can be recovered later', async () => {
    mockFind([pendingEvent()]);
    deliveryQueue.addBulk.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await recoverPendingEvents({ limit: 25 });

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({
        queueStatus: 'pending',
        lastQueueError: expect.objectContaining({ message: 'redis unavailable' }),
      }),
      { new: true }
    );
  });

  it('queues the pending event once Redis is back (no duplicate state)', async () => {
    mockFind([pendingEvent()]);
    deliveryQueue.addBulk.mockResolvedValueOnce([]);

    const result = await recoverPendingEvents({ limit: 25 });

    expect(result).toEqual({ scanned: 1, recovered: 1 });
    expect(deliveryQueue.addBulk).toHaveBeenCalledTimes(1);
    expect(Event.findByIdAndUpdate).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ queueStatus: 'queued', queuedJobCount: 1 }),
      { new: true }
    );
  });

  it('does nothing when no pending events exist', async () => {
    mockFind([]);

    const result = await recoverPendingEvents({ limit: 25 });

    expect(result).toEqual({ scanned: 0, recovered: 0 });
    expect(deliveryQueue.addBulk).not.toHaveBeenCalled();
  });
});
